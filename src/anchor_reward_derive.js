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
 * _resolveActiveStakeSourceId always returns null -> silent drop). Under Option C the hub
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
 * anchor.js._rewardCanonical / the hub's StateAnchorPublisher, and only then materializes
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
const ar      = require('./anchor_reward_activation.js');
const arKey   = require('./anchor_reward_key.js');
const coins   = require('./coins');

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

// Thrown when a matured reward cannot be PROVEN either way at this block (no DOGE
// visibility, DOGE unreachable, or the anchor is not yet buried deep enough). The block
// loop catches it, does not advance, and retries the block: deferring is the only outcome
// that keeps every node deriving the identical set at the identical height. Deriving
// without the proof would pay for an anchor that may never have landed; SKIPPING would make
// the reward set depend on one node's network luck and fork the ledger just as badly.
class AnchorProofUnavailableError extends Error {
    constructor(message){ super(message); this.name = 'AnchorProofUnavailableError'; }
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
    let minConfirmations = coins.DEFAULT_CONFIRMATIONS.DOGE;

    // Group by the logical reward (reward_type, round_reference, round_qualifier): every
    // attesting publisher for a round must be inserted BEFORE reconcile, so a failover
    // double-publish collapses to the smallest-pubkey winner (identical to the DOGE on-chain
    // path anchor.js drives).
    //
    // The qualifier is in the key because for 'anchor_archive' the pair (reward_type,
    // round_reference) does NOT name one logical reward: round_reference is MATCH_BATCH_SEQ,
    // a dense hub counter a wipe-and-replay rebase reissues (anchor_reward_key.js). Two
    // distinct archive anchors sharing a reissued seq landed in ONE group, so the single
    // reconcile that group ran collapsed them to one winner across two snapshots and deleted
    // a real publisher's pay. Split by qualifier, each snapshot's archive reward reconciles
    // as its own single-winner group, which is what the attestation quorum actually attested.
    let groups = new Map();
    for(let row of rows){
        let key = row.reward_type + '|' + row.round_reference + '|' +
                  arKey.rewardRoundQualifier(row.reward_type, row.snapshot_block);
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
            // The mirror says this reward's anchor was mined. Prove it against DOGE
            // ourselves before minting: the mirror is transport, and the hub that wrote the
            // row is exactly the party the reward pays. 'rejected' is chain-determined and
            // fleet-uniform, so it skips this row permanently; 'unknown' is a local
            // visibility failure, so it defers the whole block rather than letting this
            // node's reward set diverge from its peers'.
            let verdict = await (proof ? proof.proveMined({
                txid:            row.doge_anchor_txid,
                rewardType:      String(row.reward_type),
                roundReference:  Number(row.round_reference),
                snapshotBlock:   Number(row.snapshot_block),
                publisher:       String(row.publisher).toLowerCase(),
                network:         String(row.network),
                minConfirmations: minConfirmations
            }) : 'unknown');
            if(verdict === 'unknown')
                throw new AnchorProofUnavailableError(
                    'anchor reward ' + row.reward_type + '/' + row.round_reference + ' (publisher ' +
                    String(row.publisher).toLowerCase() + ') matured at BTC block ' + blockIndex +
                    ' but its DOGE anchor ' + (row.doge_anchor_txid || '<none>') + ' could not be proven mined; ' +
                    'deferring the block (wire DOGE_INDEXER_URL on this indexer if this persists)');
            if(verdict !== 'verified'){
                console.warn('anchor reward ' + row.reward_type + '/' + row.round_reference + ' publisher ' +
                             String(row.publisher).toLowerCase() + ': DOGE anchor proof REJECTED (' +
                             (row.doge_anchor_txid || '<no txid>') + '); no reward derived');
                continue;
            }
            let amount = (String(row.reward_type) === 'anchor_archive') ? ar.ARCHIVE_REWARD_AMOUNT : ar.ANCHOR_REWARD_AMOUNT;
            // block_index = snapshot_block (the earn-block, where the stake source resolves);
            // derive_block_index = the current BTC block, which is where the row is actually
            // minted. Without the second stamp a reorg to any height in (snapshot_block,
            // blockIndex] orphans the minting block yet leaves the reward in place, because the
            // rollback delete only scopes on block_index.
            let ok = await indexerDb.createValidatorReward(
                String(row.publisher).toLowerCase(), Number(row.round_reference), String(row.reward_type),
                amount, Number(row.snapshot_block), true, Number(blockIndex),
                arKey.rewardRoundQualifier(row.reward_type, row.snapshot_block));
            if(ok) anyWritten = true;
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
