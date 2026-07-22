/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 *  Option C: BTC-side anchor/archive reward derivation.
 *
 * ANCHOR is DOGE-only, but the reward is a COLLECT-spendable validator_rewards row and
 * COLLECT is BTC-only, and capability staking (hence the stake source createValidatorReward
 * resolves) is BTC-only. So the DOGE indexer can never write this reward (its
 * _resolveActiveStakeSourceId always returns null -> silent drop). Under Option C the hub
 * publishes the XANCPUB publisher-attestation quorum to the append-only, hub-mirrored
 * `anchor_reward_attestations` table; the BTC indexer keys derivation on those mirrored rows.
 *
 * The mirror is TRANSPORT, not trust: this pass re-verifies each row's XANCPUB signatures
 * against the BTC indexer's OWN locally-computed oracle_publish set at snapshot_block (the same
 * set + weighting anchor.js uses on DOGE), rebuilds the reward canonical byte-identically to
 * anchor.js._rewardCanonical / the hub's StateAnchorPublisher, and only then materializes
 * validator_rewards at block_index = snapshot_block. A forged or short-quorum row credits
 * nothing. Idempotent + reorg-safe: the reward upserts on (reward_type, round_reference) and a
 * failover double-publish is collapsed to the smallest-pubkey winner by reconcileAnchorRewardWinner;
 * a BTC reorg that block-scoped-deletes the reward at snapshot_block re-exposes the group for replay.
 *
 * Gated by ANCHOR_REWARD_DERIVE_ACTIVATION (the derive-relocation flag-day) and runs ONLY on BTC.
 ********************************************************************/

'use strict';

const ed25519 = require('./ed25519.js');
const swq     = require('./stake_weighted_quorum.js');
const eq      = require('./equivocation_header.js');
const ar      = require('./anchor_reward_activation.js');

// Rebuild the XANCPUB canonical for a mirrored attestation row. MUST byte-match
// anchor.js._rewardCanonical (DOGE parse side) and the hub's publisher canonical, or the
// re-verified quorum would never match and the reward would silently never derive.
function rewardCanonical(row){
    let network        = String(row.network);
    let snapshotBlock  = row.snapshot_block;
    let publisher      = String(row.publisher || '').toLowerCase();
    let roundReference = String(row.round_reference);
    if(String(row.reward_type) === 'anchor_archive'){
        let base = ['XANCPUB', 'anchor_archive', roundReference,
                    String(snapshotBlock), publisher, ar.ARCHIVE_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(snapshotBlock, network)){
            let roundId = 'XANCPUB|archive|' + network + '|' + roundReference + '|' + snapshotBlock;
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    }
    // Per-chain (v4/v5): reward_type is 'anchor_<CHAIN>'; CHAIN drives the disjoint roundId.
    let chain = String(row.reward_type).slice('anchor_'.length);
    let base = ['XANCPUB', 'anchor_' + chain, roundReference,
                String(snapshotBlock), publisher, ar.ANCHOR_REWARD_AMOUNT].join('|');
    if(eq.isEquivHeaderActive(snapshotBlock, network)){
        let roundId = 'XANCPUB|' + chain + '|' + network + '|' + roundReference + '|' + snapshotBlock;
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
    }
    return base;
}

// Verify a mirrored row's XANCPUB attestation against the local oracle_publish set at
// snapshot_block. Returns true iff the 2f+1 (or stake-weighted) quorum is met AND the
// publisher is itself a member of that set. Mirrors anchor.js's v4/v5/v6 attestation check
// (verify-then-mark-seen; stake-weighted at/above STAKE_WEIGHTED_QUORUM, else count).
async function verifyAttestation(indexerDb, row){
    let snapshotBlock = Number(row.snapshot_block);
    let network       = String(row.network);
    let weighted   = swq.isStakeWeightedQuorumActive(snapshotBlock, network);
    let validators = weighted
        ? await indexerDb.getStakeWeightsByCapability('oracle_publish', snapshotBlock)
        : await indexerDb.getValidatorsByCapability('oracle_publish', snapshotBlock);
    let oracleN = (validators && validators.length) ? validators.length : 0;
    if(oracleN === 0) return false;   // no local oracle_publish snapshot yet: derive later on replay
    let snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
    if(!snapPubkeys.has(String(row.publisher).toLowerCase())) return false;

    let sigs = [];
    try { sigs = JSON.parse(row.publisher_attestations || '[]'); } catch(e){ return false; }
    if(!Array.isArray(sigs) || sigs.length === 0) return false;

    let canonical = rewardCanonical(row);
    let attSigners = [], seen = new Set();
    for(let s of sigs){
        let pk = String(s && s.pubkey || '').toLowerCase();
        if(!pk || seen.has(pk)) continue;
        if(!snapPubkeys.has(pk)) continue;
        if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
        seen.add(pk);
        attSigners.push(pk);
    }
    return weighted
        ? swq.meetsStakeThreshold(validators, attSigners)
        : (attSigners.length >= ((oracleN <= 1) ? 1 : Math.max(2 * Math.floor((oracleN - 1) / 3) + 1, Math.ceil((oracleN + 1) / 2))));
}

// Derive all matured, not-yet-derived anchor/archive rewards from the mirrored
// anchor_reward_attestations table. Runs inside the block transaction on BTC only.
//   indexerDb  - db handle (block-transaction bound)
//   config     - indexer config ({ COIN, NETWORK })
//   blockIndex - the BTC block being processed (matures snapshot_block <= blockIndex)
async function deriveAnchorRewards(indexerDb, config, blockIndex){
    // Reward derivation resolves only where the oracle_publish stake lives: BTC.
    if(String(config['COIN']) !== 'BTC') return 0;
    let network = String(config['NETWORK'] || '');
    let rows = await indexerDb.getPendingAnchorRewardAttestations(network, Number(blockIndex));
    if(!rows || rows.length === 0) return 0;

    // Group by the logical reward (reward_type, round_reference): every attesting publisher
    // for a round must be inserted BEFORE reconcile, so a failover double-publish collapses to
    // the smallest-pubkey winner (identical to the DOGE on-chain path anchor.js drives).
    let groups = new Map();
    for(let row of rows){
        let key = row.reward_type + '|' + row.round_reference;
        if(!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }

    let derived = 0;
    for(let [, groupRows] of groups){
        let anyWritten = false;
        for(let row of groupRows){
            // Gate PER ROW on its own snapshot_block so an inert mainnet/testnet placeholder
            // keeps this byte-neutral until the operator arms the derive flag-day.
            if(!ar.isAnchorRewardDeriveActive(Number(row.snapshot_block), String(row.network))) continue;
            if(!await verifyAttestation(indexerDb, row)) continue;
            let amount = (String(row.reward_type) === 'anchor_archive') ? ar.ARCHIVE_REWARD_AMOUNT : ar.ANCHOR_REWARD_AMOUNT;
            let ok = await indexerDb.createValidatorReward(
                String(row.publisher).toLowerCase(), Number(row.round_reference), String(row.reward_type),
                amount, Number(row.snapshot_block), true);
            if(ok) anyWritten = true;
        }
        if(anyWritten){
            let first = groupRows[0];
            // Reconcile the single smallest-pubkey winner. The reconcile-log block_index is the
            // CURRENT BTC block, so a reorg of it restores collapsed losers (RB-ANCHOR). No ANCHOR
            // action index exists on BTC (the rows arrive via the mirror), so pass null.
            await indexerDb.reconcileAnchorRewardWinner(
                Number(first.round_reference), String(first.reward_type), Number(blockIndex), null);
            derived++;
        }
    }
    return derived;
}

module.exports = { deriveAnchorRewards, verifyAttestation, rewardCanonical };
