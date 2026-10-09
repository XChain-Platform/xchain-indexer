/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform - bridge settle pass: the end-of-block driver and its due sets.
 *
 * The pass driver, the proof fetch available to each transfer leg, and the two ordered,
 * capped due-set reads. The order inside the pass and the order inside each due set are
 * consensus-visible (they decide which action indexes exist at this block), so both are
 * spelled here exactly as they were.
 *
 * BUILT BY THE ENTRY (see the entry header and canonicals.js).
 *
 *
 * THE BODIES ARE PLAIN NAMED FUNCTIONS that take the entry's deps as their first argument, and
 * the factory at the foot only binds them. That keeps every step its own named function instead
 * of one long closure, while every capture still comes from the entry.
 ********************************************************************/

'use strict';

const cpCheck     = require('../bridge_checkpoint_check.js');
const proofClient = require('../bridge_proof_client.js');
const { resolveTransferOrigin } = require('../bridge_checkpoint_check/origin.js');
const { XBRIDGE_MAX_PER_BLOCK, XPOLICY_MAX_PER_BLOCK } = require('../../protocol/constants.js');
const { int, SETTLE_REASON } = require('./reasons.js');
const { parseMembershipOrRef } = require('./policy_membership.js');
const { dropRefRowsFromFirst } = require('./policy_ref_due.js');
const { recordSettlement } = require('./settlements.js');
const gateRegistry = require('../gate_registry');

const POLICY_REFUSAL_RECORD_KEY =
    'bridge_policy_refusal_record_activation.BRIDGE_POLICY_REFUSAL_RECORD_ACTIVATION';
const ROW_FIELDS_TERMINAL_KEY =
    'bridge_row_fields_terminal_activation.BRIDGE_ROW_FIELDS_TERMINAL_ACTIVATION';

// Refusals that name a fact about the row no later block changes and that write no settlement
// record. Such a row stays in the due set forever, so it must not count against the per-block
// cap or XBRIDGE_MAX_PER_BLOCK of them would stop every settle to the chain.
const TERMINAL_REFUSALS = new Set([
    SETTLE_REASON.QUORUM,
    SETTLE_REASON.ESCROW_PROOF,
    SETTLE_REASON.ESCROW_MISSING,
    SETTLE_REASON.ESCROW_SHORT,
    SETTLE_REASON.TOKEN_ROW,
]);

function policyRefusalRecordActive(ctx){
    return gateRegistry.activeAt(POLICY_REFUSAL_RECORD_KEY,
                                 ctx.network, ctx.coin, ctx.blockIndex, null);
}

function transferRefusalIsTerminal(reason, ctx){
    if(TERMINAL_REFUSALS.has(reason)) return true;
    return reason === SETTLE_REASON.ROW_FIELDS &&
        gateRegistry.activeAt(ROW_FIELDS_TERMINAL_KEY,
                              ctx.network, ctx.coin, ctx.blockIndex, null);
}

async function recordPolicyRefusal(row, result, ctx){
    const db = ctx.indexerDb;
    const actionIndexes = result.actionIndexes || [];
    let anchor = actionIndexes.length ? actionIndexes[actionIndexes.length - 1] : null;
    if(anchor === null || anchor === undefined)
        anchor = await db.createActionIndex({ ACTION: 'XPOLICY', BLOCK_INDEX: ctx.blockIndex, FORMAT: 0 });
    await recordSettlement(db, anchor, row.snapshot_id, 'refused', ctx.blockIndex,
                           { src_chain: row.origin_chain, src_action_index: null,
                             dest_chain: ctx.coin, dest_address: null, tick: row.tick });
}

/**
 * Build a proof for one transfer, or STALL the whole pass.
 *
 * WHY THE PASS AND NOT THE CHECK FETCHES IT. bridge_checkpoint_check.js is synchronous and
 * pure by design, so it cannot make two nodes disagree because one of them had a slower
 * database. That makes the fetch the CALLER's obligation, and it comes with the caller's two
 * rules, both discharged in bridge_proof_client.js: the checkpoint is selected
 * deterministically, and it is one this node has already established as quorum-signed.
 *
 * A PROOF THAT CANNOT BE OBTAINED YET STALLS, and that distinction is the reason this throws
 * instead of returning. "My mirror has not caught up" is a property of one node's network,
 * while ok:false is a consensus verdict that this row never applies here. Letting an absence
 * read as a refusal would let a node that is merely behind decide, permanently, that a
 * legitimate transfer was forged. The error escapes the pass and the block loop defers the
 * block under bridge_proof_barrier, beside waitForBridgeSync.
 *
 * OUT LEGS NEED NO PROOF and are not stalled for one: the escrow an out leg releases is an
 * ordinary balance on THIS chain, where the local ledger is authoritative and the
 * would-go-negative refusal is the guard. The exemption and the proof origin use the same
 * transfer-origin resolver as the check, so the two cannot disagree about the leg direction.
 *
 * @param {Object} row - the bridge_transfers row about to be applied
 * @param {Object} ctx - the pass context
 * @returns {Promise<Object|null>} the envelope for ctx.proof, or null when none is needed
 * @throws {BridgeProofUnavailableError}
 */
async function fetchProofForTransfer(row, ctx){
    const srcChain  = String(row.src_chain || '');
    const destChain = String(row.dest_chain || '');
    const thisChain = String(ctx.coin || '');
    const origin = resolveTransferOrigin(row);
    // Not our leg, an invalid origin shape, or an out leg: the check answers these from
    // the row alone and no remote request can change its verdict.
    if(thisChain !== destChain || !origin || thisChain === origin.originChain) return null;
    if(srcChain !== origin.originChain || origin.kind !== 'lock') return null;

    const escrow = cpCheck.resolveEscrowAddress(origin.originChain, destChain, String(row.network || ''));
    // An unresolvable escrow address is a CONFIG fact, identical on every node running this
    // build, so it is the check's refusal (ESCROW_UNRESOLVED) and not a stall.
    if(!escrow) return null;

    return await proofClient.buildEscrowProof(row, ctx, escrow);
}

/**
 * The end-of-block settle pass. XChainIndexer.js calls this in its PINNED position,
 * immediately after util.processCrossChainSettlements and before util.processCrossChainCalls.
 *
 * ORDER INSIDE THE PASS is pinned too: policy snapshots run at the HEAD, then the transfer
 * legs. A snapshot materialized after a credit in the same block would gate that credit under
 * the OLD membership on a node that ordered it the other way.
 *
 * CAPS AND CARRY-FORWARD. XPOLICY_MAX_PER_BLOCK snapshots and XBRIDGE_MAX_PER_BLOCK transfers
 * per block, the overflow carrying forward IN ORDER and never dropped: a dropped row would
 * make the applied set depend on which rows a node happened to hold, and the cutoff is
 * consensus-visible because it decides which action indexes exist.
 *
 * @param {Object} ctx - { actions, indexerDb, util, config, coin, network, blockIndex, blockTime }
 * @returns {Promise<{policies: Array<string>, transfers: Array<string>}>} the ids applied
 * @throws {BridgeProofUnavailableError} when a proof is not obtainable yet: DEFER the block
 */
async function processBridgeSettlePass(deps, ctx){
    const { applyBridgeTransfer } = deps.transfer;
    const { applyPolicySnapshot } = deps.policy;
    const applied = { policies: [], transfers: [] };
    delete ctx.proof;
    delete ctx.fetchProof;
    for(const row of await duePolicySnapshots(deps, ctx)){
        const res = await applyPolicySnapshot(row, ctx);
        if(res.applied) applied.policies.push(row.snapshot_id);
        else if(res.terminal && policyRefusalRecordActive(ctx))
            await recordPolicyRefusal(row, res, ctx);
    }
    const cap = XBRIDGE_MAX_PER_BLOCK || 25;
    let slots = 0;
    for(const row of await unsettledBridgeTransfers(deps, ctx)){
        if(slots >= cap) break;
        ctx.fetchProof = () => fetchProofForTransfer(row, ctx);
        try {
            const res = await applyBridgeTransfer(row, ctx);
            if(res.applied) applied.transfers.push(row.transfer_id);
            if(res.applied || !transferRefusalIsTerminal(res.reason, ctx)) slots++;
        } finally {
            delete ctx.proof;
            delete ctx.fetchProof;
        }
    }
    return applied;
}

/**
 * The finalized, effective, unapplied transfers whose destination is THIS chain, in
 * (snapshot_block, transfer_id) order, capped.
 *
 * ORDERED ON QUORUM-AGREED ROW CONTENT and never on the hub-assigned AUTO_INCREMENT `id`,
 * which is per-hub: two indexers mirroring different hubs must settle the same prefix, and an
 * id-ordered query would give them different ones. The same rule getEffectiveUnsettledMatches
 * follows, for the same reason.
 */
async function dueBridgeTransfers(deps, ctx){
    return (await unsettledBridgeTransfers(deps, ctx)).slice(0, XBRIDGE_MAX_PER_BLOCK || 25);
}

async function unsettledBridgeTransfers(deps, ctx){
    const db  = ctx.indexerDb;
    // Bound by height in the admission era and by the clock below it (mirrorBindClause).
    const bind = deps.canonicals.mirrorBindClause(ctx);
    const rows = await db.mirrorDb().getFinalizedBridgeTransfersForChain(ctx.network, ctx.coin, bind);
    if(rows.length === 0) return [];
    const ids = rows.map(r => r.transfer_id);
    const settled = await db.getRecordedTransferSettlementIds(ids);
    const seen = new Set(settled.map(r => r.transfer_id));
    const unsettled = rows.filter(r => !seen.has(r.transfer_id));

    // Drop a row whose SOURCE LEG this chain has already settled under a different transfer_id.
    // applyBridgeTransfer refuses such a row anyway and that refusal is the authoritative guard;
    // excluding it from the due set is what keeps a permanently refusable row from consuming one
    // of the XBRIDGE_MAX_PER_BLOCK slots on every block forever and starving legitimate
    // transfers behind it, the same reason the policy path records a snapshot that can no longer
    // progress. Deterministic: the set is a function of this chain's own bridge_settlements, so
    // every node replaying the same chain drops the same rows and applies the same slice.
    const legChains = [...new Set(unsettled.filter(r => r.src_chain && int(r.src_action_index) !== null)
                                           .map(r => String(r.src_chain)))];
    const legIndexes = [...new Set(unsettled.map(r => int(r.src_action_index)).filter(v => v !== null))];
    let settledLegs = new Set();
    if(legChains.length && legIndexes.length){
        const legRows = await db.getSettledBridgeSourceLegs(legChains, legIndexes);
        // Two IN lists select the cross product of the candidates' chains and indexes, so the
        // PAIR is matched here rather than trusted from the query: without this an applied leg
        // on one chain would suppress the same action index on another.
        settledLegs = new Set((legRows || []).map(r => String(r.src_chain) + ':' + String(int(r.src_action_index))));
    }
    return unsettled.filter(r => {
                       const idx = int(r.src_action_index);
                       // No usable source leg: left in the due set so the apply's ROW_FIELDS
                       // refusal is the one place that judges it.
                       if(!r.src_chain || idx === null) return true;
                       return !settledLegs.has(String(r.src_chain) + ':' + idx);
                   });
}

/**
 * The finalized, effective, unapplied policy snapshots, capped.
 *
 * THE ORDER IS (snapshot_block, snapshot_id) ACROSS TICKS AND policy_seq WITHIN ONE TICK, and
 * those two rules need reconciling into one TOTAL order or the per-block cutoff is not
 * node-invariant. Reconciled by ranking each (origin_chain, tick) group by its LOWEST
 * snapshot_id inside a snapshot_block, then ordering within a group by policy_seq. Both spec
 * rules hold, the comparator is a real total order (the group rank is precomputed, so no pair
 * of comparisons can contradict), and two ticks never interleave, which is what the seq rule
 * is for: a tick's seq 2 can never be applied before its seq 1.
 */
function carriesPolicyRef(row){
    const allow = parseMembershipOrRef(row.allow_list);
    const block = parseMembershipOrRef(row.block_list);
    return !!((allow && allow.ref) || (block && block.ref));
}

function prunePreConsumerRefs(rows, ctx){
    if(gateRegistry.activeAt('list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION',
                             ctx.network, ctx.coin, ctx.blockIndex, null)) return rows;
    return dropRefRowsFromFirst(rows, carriesPolicyRef);
}

async function duePolicySnapshots(deps, ctx){
    const db   = ctx.indexerDb;
    // No chain clause, deliberately: every chain reads every snapshot. In the admission era
    // THIS chain's column decides, and a row whose map never named this chain has that column
    // NULL and binds by the clock, which is the fail-closed direction for a chain added later.
    const bind = deps.canonicals.mirrorBindClause(ctx);
    let rows = await db.mirrorDb().getFinalizedPolicySnapshots(ctx.network, bind);
    if(rows.length === 0) return [];
    rows = prunePreConsumerRefs(rows, ctx);
    if(rows.length === 0) return [];

    const groupRank = new Map();
    for(const r of rows){
        const key  = String(r.origin_chain) + '|' + String(r.tick);
        const prev = groupRank.get(key);
        const sid  = String(r.snapshot_id);
        if(prev === undefined || sid < prev) groupRank.set(key, sid);
    }
    rows.sort((a, b) => {
        const ba = Number(a.snapshot_block), bb = Number(b.snapshot_block);
        if(ba !== bb) return ba - bb;
        const ka = String(a.origin_chain) + '|' + String(a.tick);
        const kb = String(b.origin_chain) + '|' + String(b.tick);
        if(ka !== kb){
            const ra = groupRank.get(ka), rb = groupRank.get(kb);
            if(ra !== rb) return ra < rb ? -1 : 1;
            return ka < kb ? -1 : 1;
        }
        return Number(a.policy_seq) - Number(b.policy_seq);
    });

    const ids = rows.map(r => r.snapshot_id);
    const settled = await db.getRecordedPolicySettlementIds(ids);
    const seen = new Set(settled.map(r => r.transfer_id));
    if(policyRefusalRecordActive(ctx)){
        const refused = await db.getRecordedPolicyRefusalIds(ids);
        for(const r of refused) seen.add(r.transfer_id);
    }
    return rows.filter(r => !seen.has(r.snapshot_id))
               .slice(0, XPOLICY_MAX_PER_BLOCK || 5);
}

/**
 * @param {Object} deps - { canonicals, transfer, policy }, built by the ENTRY
 */
module.exports = function createPass(deps){
    return {
        processBridgeSettlePass: (ctx) => processBridgeSettlePass(deps, ctx),
        fetchProofForTransfer,
        dueBridgeTransfers:      (ctx) => dueBridgeTransfers(deps, ctx),
        duePolicySnapshots:      (ctx) => duePolicySnapshots(deps, ctx),
    };
};
