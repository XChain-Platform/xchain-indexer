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
 * Option C: BTC-side anchor/archive reward derivation.
 *
 * ANCHOR is DOGE-only, but the reward is a COLLECT-spendable validator_rewards row and
 * COLLECT is BTC-only, and capability staking (hence the stake source createValidatorReward
 * resolves) is BTC-only. So the DOGE indexer can never write this reward (its
 * resolveActiveStakeSourceId always returns null -> silent drop). Under Option C the hub
 * publishes the XANCPUB publisher-attestation quorum to the append-only, hub-mirrored
 * `anchor_reward_attestations` table; the BTC indexer keys derivation on those mirrored rows.
 *
 * THREE independent gates stand between a mirrored row and a minted reward, and none of
 * them trusts the party that would be paid:
 *   1. the XANCPUB quorum, re-verified below against this node's OWN oracle_publish set;
 *   2. the MINED DOGE ANCHOR, re-proved via the DOGE indexer's getanchorconfirmations read
 *      (anchor_proof_client.js) and bound to this exact reward tuple, so an evicted or
 *      reorged anchor pays nothing;
 *   3. the fleet-agreed MIRROR-COMPLETENESS WATERMARK, so the block a reward materializes
 *      at is the same on every node whatever their mirrors' arrival order was.
 *
 * The mirror is transport, not trust: this pass re-verifies each row's XANCPUB signatures
 * against the BTC indexer's own locally-computed oracle_publish set at snapshot_block (the same
 * set + weighting anchor.js uses on DOGE), rebuilds the reward canonical byte-identically to
 * anchor.js.rewardCanonical / the hub's StateAnchorPublisher, and only then materializes
 * validator_rewards at block_index = snapshot_block. A forged or short-quorum row credits
 * nothing. Idempotent and reorg-safe: the reward upserts on (reward_type, round_reference,
 * round_qualifier) - the qualifier being snapshot_block for the archive leg, whose
 * round_reference is a hub counter a rebase reissues (anchor_reward_key.js) - and a
 * failover double-publish is collapsed to the smallest-pubkey winner by reconcileAnchorRewardWinner;
 * a BTC reorg that block-scoped-deletes the reward at snapshot_block re-exposes the group for replay.
 *
 * Two block heights are persisted. block_index = snapshot_block is the reward's earn block: it
 * is where the stake source resolves and where a from-genesis replay must credit it.
 * derive_block_index = the BTC block being processed is the reward's materialization block, which
 * is strictly later. Rollback needs both, because the row must disappear when either height is
 * orphaned: scoping on the earn-block alone leaves a COLLECT-spendable reward alive after a reorg
 * to any height in (snapshot_block, blockIndex], a reward a clean replay to that height has not
 * derived yet.
 *
 * Gated by ANCHOR_REWARD_DERIVE_ACTIVATION (the derive-relocation flag-day) and runs ONLY on BTC.
 ********************************************************************/

'use strict';

const ed25519 = require('./ed25519.js');
const swq     = require('./stake_weighted_quorum.js');
const eq      = require('./equivocation_header.js');
const ar      = require('./gates/anchor_reward_gate.js');
const arKey   = require('../actions/anchor/anchor_reward_key.js');
// The proof-and-mint step and the logical-reward grouping live beside this file in
// anchor_reward_derive/. Every activation read (ar) stays here.
const { AnchorProofUnavailableError, mintProvenRow } = require('./anchor_reward_derive/mint_row.js');
const { groupByLogicalReward } = require('./anchor_reward_derive/reward_groups.js');
// No coin-registry require here on purpose: nothing inside the block transaction may read a
// field the registry advertises as operator-tunable (see minConfirmations below).

// Rebuild the XANCPUB canonical for a mirrored attestation row. MUST byte-match
// anchor.js.rewardCanonical (DOGE parse side) and the hub's publisher canonical, or the
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
    if(String(row.reward_type) === 'anchor_bundle'){
        // Bundle leg (v0): ONE reward per per-network bundle. round_reference IS the
        // snapshot block, so field 2 and field 3 repeat it; the six-field positional
        // layout is kept so slash.js reads snapshot_block at index 3 for every XANCPUB
        // family. MUST byte-match anchor.js.rewardCanonical's v0 branch and the hub's
        // bundle attestation canonical.
        let base = ['XANCPUB', 'anchor_bundle', roundReference,
                    String(snapshotBlock), publisher, ar.ANCHOR_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(snapshotBlock, network)){
            let roundId = 'XANCPUB|bundle|' + network + '|' + snapshotBlock;
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    }
    // Per-chain (retired v4/v5 rows still mirrored): reward_type is 'anchor_<CHAIN>';
    // CHAIN drives the disjoint roundId.
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
// publisher is itself a member of that set. Mirrors anchor.js's v0/v1 attestation check
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

// The two flag-days a mirrored row must be past before it may mint, each read at the
// row's own snapshot_block and network.
function rowGatesActive(row){
    // Gate PER ROW on its own snapshot_block so an inert mainnet/testnet placeholder
    // keeps this byte-neutral until the operator arms the derive flag-day.
    if(!ar.isAnchorRewardDeriveActive(Number(row.snapshot_block), String(row.network))) return false;
    // And gate on the reward FAMILY's own flag-day, which is a different question from
    // WHERE derivation happens. ANCHOR_REWARD_DERIVE_ACTIVATION only relocates the mint
    // from the DOGE indexer to this one; whether the family pays at all is
    // ANCHOR_REWARD_ACTIVATION / ARCHIVE_REWARD_ACTIVATION, and the protocol is explicit
    // that below the archive flag-day a v1 indexes its checkpoint and archive valid but
    // "never derives an anchor_archive reward even with a full attestation"
    // (xchain-documentation/protocol/actions/anchor.md). The relocation gate is armed at
    // genesis on every network while the family gates are not, so without this the only
    // thing between a below-flag-day attestation row and a COLLECT-spendable
    // validator_rewards row is the hub's own leader-side family check: one honest
    // producer, and no consumer-side defence at all against a rogue or mis-built hub.
    // The mirror is transport, not trust - the same rule the XANCPUB re-verification and
    // the DOGE mined-proof below exist for - so the consumer re-derives this gate too.
    //
    // The split is the SAME one the amount pick below makes, deliberately: anchor_archive
    // rides the archive flag-day and every other anchor family (anchor_bundle and the
    // per-chain anchor_<CHAIN>) rides the anchor flag-day. Keying it off a whitelist of
    // known reward types instead would silently stop paying a family added later, which
    // is a worse failure than the one this closes.
    return (String(row.reward_type) === 'anchor_archive')
        ? ar.isArchiveRewardActive(Number(row.snapshot_block), String(row.network))
        : ar.isAnchorRewardActive(Number(row.snapshot_block), String(row.network));
}

// Derive all matured, not-yet-derived anchor/archive rewards from the mirrored
// anchor_reward_attestations table. Runs inside the block transaction on BTC only.
//   indexerDb  - db handle (block-transaction bound)
//   config     - indexer config ({ COIN, NETWORK })
//   blockIndex - the BTC block being processed
//   proof      - AnchorProofClient (DOGE anchor visibility). Required at/above the derive
//                gate: without it nothing can be proven mined, so every matured row defers.
//
// Maturity is the fleet-agreed watermark, NOT snapshot_block: a row is derivable at
// snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY. Rows still inside that window are simply
// not fetched, so a node whose mirror is a few minutes behind the fleet still derives the
// identical set at the identical height.
async function deriveAnchorRewards(indexerDb, config, blockIndex, proof){
    // Reward derivation resolves only where the oracle_publish stake lives: BTC.
    if(String(config['COIN']) !== 'BTC') return 0;
    let network = String(config['NETWORK'] || '');
    // Below the watermark nothing has matured yet (and an early chain cannot underflow into
    // maturing everything at a negative height).
    let watermark = Number(blockIndex) - ar.ANCHOR_REWARD_MIRROR_MATURITY;
    if(!Number.isFinite(watermark) || watermark < 0) return 0;
    let rows = await indexerDb.getPendingAnchorRewardAttestations(network, watermark);
    if(!rows || rows.length === 0) return 0;
    // The burial depth this mint gate requires, from the frozen ledger constants beside the
    // activation map, NOT from the coin registry: the registry's `confirmations` is
    // classified as operator-tunable depth, sits outside the pinned consensus subset, and is
    // env-overridable per node (coins.resolveConfirmations), so sourcing a ledger input from
    // it let two nodes derive the same reward at different BTC heights while their consensus
    // pins verified clean. The hub's own attest gate keeps reading the registry knob, which
    // is local trust policy there; on mainnet and testnet that knob is floor-clamped to the
    // same default, so a hub can never attest shallower than this gate will mint.
    let minConfirmations = ar.ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS;

    // Group by the logical reward (reward_type, round_reference, round_qualifier); see
    // groupByLogicalReward in anchor_reward_derive/reward_groups.js for why the qualifier
    // is part of the key and why every publisher is inserted before reconcile.
    let groups = groupByLogicalReward(rows);

    let derived = 0;
    for(let [, groupRows] of groups){
        let anyWritten = false;
        for(let row of groupRows){
            if(!rowGatesActive(row)) continue;
            if(!await verifyAttestation(indexerDb, row)) continue;
            // Prove the row's DOGE anchor mined, then mint it (anchor_reward_derive/mint_row.js).
            // An anchor that cannot be proven either way throws AnchorProofUnavailableError,
            // which defers the whole block.
            let amount = (String(row.reward_type) === 'anchor_archive') ? ar.ARCHIVE_REWARD_AMOUNT : ar.ANCHOR_REWARD_AMOUNT;
            if(await mintProvenRow(indexerDb, row, { blockIndex, proof, minConfirmations, amount })) anyWritten = true;
        }
        if(anyWritten){
            let first = groupRows[0];
            // Reconcile the single smallest-pubkey winner. The reconcile-log block_index is the
            // CURRENT BTC block, so a reorg of it restores collapsed losers (RB-ANCHOR). No ANCHOR
            // action index exists on BTC (the rows arrive via the mirror), so pass null.
            // The qualifier is a property of the GROUP (it is part of the group key), so any
            // member names it; taking it from `first` cannot disagree with what the writers
            // above stamped on the rows this reconcile is about to compare.
            await indexerDb.reconcileAnchorRewardWinner(
                Number(first.round_reference), String(first.reward_type), Number(blockIndex), null,
                arKey.rewardRoundQualifier(first.reward_type, first.snapshot_block));
            derived++;
        }
    }
    return derived;
}

module.exports = { deriveAnchorRewards, verifyAttestation, rewardCanonical, AnchorProofUnavailableError };
