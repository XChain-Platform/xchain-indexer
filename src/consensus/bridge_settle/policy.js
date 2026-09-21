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
 * XChain Platform - bridge settle pass: the token policy snapshot legs.
 *
 * Phased exactly like transfer.js, and for the same reason: the ladder's ORDER decides which
 * refusal a row takes and whether a leg is injected at this block, so each phase refuses where
 * the original refused and the orchestrator stops there. Every refusal also carries its
 * TERMINAL flag unchanged, because that flag is what decides whether a later block re-reads
 * the row at all.
 *
 * BUILT BY THE ENTRY (see the entry header and canonicals.js).
 *
 *
 * THE BODIES ARE PLAIN NAMED FUNCTIONS that take the entry's deps as their first argument, and
 * the factory at the foot only binds them. That keeps every step its own named function instead
 * of one long closure, while every capture still comes from the entry.
 ********************************************************************/

'use strict';

const { SETTLE_REASON, isNull, int } = require('./reasons.js');
const { policyHash, verifyMembershipOrder, parseMembership } = require('./policy_membership.js');
const { isSettled, recordSettlement } = require('./settlements.js');
const createPolicyLegs = require('./policy_legs.js');

/**
 * The refusals that read the ROW and the block alone.
 *
 * TERMINAL versus CARRIED, and the split is the whole error policy of this function
 * for policy snapshots. Only a hash, signature, `network` or `btc_chain_id` failure is
 * terminal: those are properties of the ROW that no later block can change. Everything
 * else - a seq not yet applyable, a copy that does not exist here yet, a capability
 * snapshot still arriving - carries forward, because a later block can change it.
 *
 * @returns {{reason: string, terminal: boolean}|{fields: Object}}
 */
function screenRow(deps, row, ctx){
    if(!row || typeof row !== 'object' || !ctx || typeof ctx !== 'object')
        return { reason: SETTLE_REASON.ROW_FIELDS, terminal: true };

    const id       = String(row.snapshot_id || '');
    const origin   = String(row.origin_chain || '');
    const name     = String(row.tick || '');
    const snapshot = int(row.snapshot_block);
    const seq      = int(row.policy_seq);
    if(!id || !origin || !name || snapshot === null || seq === null)
        return { reason: SETTLE_REASON.ROW_FIELDS, terminal: true };

    if(String(row.network || '') !== String(ctx.network || '')){
        deps.refusalLog.warnOnce('XPOLICY', id, SETTLE_REASON.NETWORK,
                                 SETTLE_REASON.NETWORK + ' : terminal');
        return { reason: SETTLE_REASON.NETWORK, terminal: true };
    }
    const localChainId = ctx.config ? ctx.config['BTC_CHAIN_ID'] : null;
    if(!isNull(row.btc_chain_id) && !isNull(localChainId) &&
       String(row.btc_chain_id) !== String(localChainId)){
        deps.refusalLog.warnOnce('XPOLICY', id, SETTLE_REASON.CHAIN_ID,
                                 SETTLE_REASON.CHAIN_ID + ' : terminal');
        return { reason: SETTLE_REASON.CHAIN_ID, terminal: true };
    }
    if(String(row.status || '') !== 'finalized')
        return { reason: SETTLE_REASON.NOT_FINALIZED, terminal: false };

    const blockTime = Number(ctx.blockTime);
    if(!Number.isFinite(blockTime) || Number(row.effective_time) > blockTime)
        return { reason: SETTLE_REASON.NOT_DUE, terminal: false };

    // The origin chain holds the native row; there is nothing to inherit onto itself.
    if(origin === String(ctx.coin || ''))
        return { reason: SETTLE_REASON.POLICY_ORIGIN, terminal: true };

    return { fields: { id, origin, name, snapshot, seq } };
}

/**
 * The apply-order guard.
 *
 * APPLY ORDER IS BY policy_seq, and it needs its own guard rather than riding the due-set
 * sort. effective_time is NOT monotonic across seq, so seq 2 can become due at an
 * earlier block than seq 1: the per-block sort orders what is due TOGETHER and says nothing
 * about two snapshots that come due in different blocks. Applying them out of order
 * materializes the STALE membership last and leaves the copy enforcing a policy the origin
 * has already replaced, permanently. So an earlier finalized seq that this chain has not
 * recorded carries this row forward (a missing earlier seq is CARRIED, never terminal).
 *
 * @returns {Promise<{reason: string, terminal: boolean}|null>}
 */
async function guardApplyOrder(deps, row, ctx, f){
    const { log } = deps.refusalLog;
    const db = ctx.indexerDb;
    if(await isSettled(db, f.id, 'policy'))
        return { reason: SETTLE_REASON.ALREADY_APPLIED, terminal: false };

    const earlier = await db.mirrorDb().getEarlierFinalizedPolicySnapshots(row.network, f.origin, f.name, f.seq);
    for(const e of (earlier || [])){
        if(!await isSettled(db, e.snapshot_id, 'policy')){
            log('XPOLICY', f.id, SETTLE_REASON.POLICY_SEQ_GAP + ' : carrying forward');
            return { reason: SETTLE_REASON.POLICY_SEQ_GAP, terminal: false };
        }
    }
    return null;
}

/**
 * MEMBERSHIP IS TRANSPORT, NOT SIGNATURE. The arrays arrive beside the row and are bound
 * to it only through policy_hash, so the hash is recomputed from them here and a mismatch
 * refuses the row. Malformed transport is a hash-class failure: it cannot be read as an
 * empty list, because empty and absent mean opposite things under isActionAllowed.
 *
 * @returns {{reason: string, terminal: boolean}|{allow: *, block: *, sleeping: boolean}}
 */
function verifyMembership(deps, row, f){
    const { warnOnce } = deps.refusalLog;
    const allow = parseMembership(row.allow_list);
    const block = parseMembership(row.block_list);
    if(allow === false || block === false){
        warnOnce('XPOLICY', f.id, SETTLE_REASON.POLICY_HASH,
                  SETTLE_REASON.POLICY_HASH + ' (membership transport is not a JSON array) : terminal');
        return { reason: SETTLE_REASON.POLICY_HASH, terminal: true };
    }
    // Order is VERIFIED, never repaired. Re-sorting here would silently accept a row
    // whose hash the fleet computed over a different byte string.
    if(!verifyMembershipOrder(allow) || !verifyMembershipOrder(block)){
        warnOnce('XPOLICY', f.id, SETTLE_REASON.POLICY_ORDER, SETTLE_REASON.POLICY_ORDER + ' : terminal');
        return { reason: SETTLE_REASON.POLICY_ORDER, terminal: true };
    }
    const sleeping = !!int(row.sleeping);
    if(policyHash(allow, block, sleeping) !== String(row.policy_hash || '').toLowerCase()){
        warnOnce('XPOLICY', f.id, SETTLE_REASON.POLICY_HASH, SETTLE_REASON.POLICY_HASH + ' : terminal');
        return { reason: SETTLE_REASON.POLICY_HASH, terminal: true };
    }
    return { allow: allow, block: block, sleeping: sleeping };
}

/**
 * The signature quorum over the policy canonical, then the bridged copy this snapshot is
 * materialized onto.
 *
 * The bridged copy on THIS chain. A chain that holds no copy of the tick has nothing to
 * materialize the policy onto, and that is a CARRIED outcome: a copy can appear later, on
 * the first in-leg of a transfer of that tick.
 *
 * @returns {Promise<{reason: string, terminal: boolean}|{copyTick: string, owner: *, info: Object}>}
 */
async function guardQuorumAndCopy(deps, row, ctx, f){
    const { verifyQuorum }    = deps.quorum;
    const { policyCanonical } = deps.canonicals;
    const { log, warnOnce }   = deps.refusalLog;
    const db = ctx.indexerDb;
    const quorum = await verifyQuorum(policyCanonical(row), row.validator_signatures,
                                      f.snapshot, row.network, db);
    if(quorum.snapshotAbsent){
        log('XPOLICY', f.id, SETTLE_REASON.SNAPSHOT_ABSENT + ' : deferring');
        return { reason: SETTLE_REASON.SNAPSHOT_ABSENT, terminal: false };
    }
    if(!quorum.met){
        warnOnce('XPOLICY', f.id, SETTLE_REASON.QUORUM,
                  SETTLE_REASON.QUORUM + ' (' + quorum.valid + '/' + quorum.total + ') : terminal');
        return { reason: SETTLE_REASON.QUORUM, terminal: true };
    }

    const copyTick = f.origin + '.' + f.name;
    const owner    = ((ctx.config && ctx.config['ADDRESS']) || {})['BRIDGE_' + f.origin];
    const tickId   = await db.getTickerId(copyTick);
    if(isNull(tickId) || isNull(owner))
        return { reason: SETTLE_REASON.POLICY_NO_COPY, terminal: false };
    const info = await db.getTokenInfo(copyTick, ctx.blockIndex);
    if(!info)
        return { reason: SETTLE_REASON.POLICY_NO_COPY, terminal: false };
    return { copyTick: copyTick, owner: owner, info: info };
}

/**
 * The idempotency record is anchored to an action index so a destination reorg below the
 * applying block drops it with the legs and the snapshot re-applies at fresh indexes. When
 * every leg was a no-op there is no leg index to anchor to, so the record anchors to a
 * minted XPOLICY action: without it the snapshot would be re-evaluated on every later
 * block forever. A snapshot with nothing to do is ordinary, not exotic (seq 1 of a tick
 * with no lists that is awake), so this path is reached in normal operation.
 *
 * 'XPOLICY' is an internal action name, not a wire action: no decoder produces it, nothing
 * dispatches it, and it is never broadcast. It interns in index_actions the way every
 * action name does, at the same point on every node, and nothing keys a verdict or a hash
 * input on the name itself.
 */
async function recordApplied(deps, ctx, f, target, actionIndexes){
    const { log } = deps.refusalLog;
    const db = ctx.indexerDb;
    let anchor = actionIndexes.length ? actionIndexes[actionIndexes.length - 1] : null;
    if(anchor === null){
        anchor = await db.createActionIndex({ ACTION: 'XPOLICY', BLOCK_INDEX: ctx.blockIndex, FORMAT: 0 });
        actionIndexes.push(anchor);
    }

    // No ledger reconciliation here on purpose: a policy leg moves no units, and each injected
    // LIST / ISSUE / SLEEP already ran through its own handler, which does whatever balance and
    // supply work it owns. A sweep here would re-read whichever addresses the LAST leg happened
    // to leave in the shared list, which is not a set this pass has any claim about.
    await recordSettlement(db, anchor, f.id, 'policy', ctx.blockIndex,
                           { src_chain: f.origin, src_action_index: null, dest_chain: ctx.coin,
                             dest_address: null, tick: f.name });

    log('XPOLICY', f.id, 'applied seq ' + f.seq + ' to ' + target.copyTick + ' (' + actionIndexes.length + ' legs)');
}

/**
 * Apply one finalized token policy snapshot to the bridged copy on this chain: the origin
 * row's allow list, block list and tick sleep, materialized as injected local actions.
 *
 * INJECTED LEGS, ORDINALS PINNED (consensus-visible, so the order is not a style choice):
 *   0 allow-list create or REMOVE, 1 allow-list ADD, 2 block-list create or REMOVE,
 *   3 block-list ADD, 4 ISSUE 5 (point the bridged row at the lists), 5 SLEEP.
 * Legs with nothing to do are not injected. One synthetic transaction per injected action,
 * injectGasToken's field shape, tx_hash = 'XPOLICY-' + snapshot_id.slice(0, 48) and
 * vout = the leg's ordinal, so action indexes are identical on every node.
 *
 * MEMBERSHIP IS TRANSPORT, NOT SIGNATURE. allow_list and block_list arrive as JSON arrays
 * beside the row; the apply recomputes policy_hash from them and refuses the row with one
 * log line naming snapshot_id if it differs. It VERIFIES the arrays are already in
 * canonical order and refuses otherwise; it never re-sorts.
 *
 * TERMINAL versus CARRIED. Only a hash, signature, `network` or `btc_chain_id` failure is
 * terminal. Anything else - a seq not yet applyable, a missing earlier seq - carries
 * forward with one log line on the first block.
 *
 * NOT INHERITED: controller bindings (a binding names a contract deployed on one chain) and
 * address sleep (chain-local, not a token policy). The milestone-1 controller refusals stay.
 *
 * IDEMPOTENCY. Recorded in bridge_settlements with kind = 'policy' and the snapshot_id in
 * the transfer_id column, which is why `kind` is inside the unique key.
 *
 * BUILT.
 *
 * @param {Object} row - one finalized policy_snapshots row as mirrored: snapshot_id,
 *                       snapshot_block, origin_chain, tick, policy_seq, origin_block,
 *                       policy_hash, allow_list, block_list, sleeping, effective_time,
 *                       network, finalizing_view, validator_signatures, status,
 *                       push_generation, btc_chain_id
 * @param {Object} ctx - pass context, as applyBridgeTransfer
 * @returns {Promise<{applied: boolean, reason: (string|null), terminal: boolean,
 *          actionIndexes: Array<number>}>} terminal true means never retry this row
 */
async function applyPolicySnapshot(deps, row, ctx){
    const { legFailure, injectPolicyLegs } = deps.legs;
    const out = (applied, reason, terminal, actionIndexes) =>
        ({ applied: applied, reason: reason, terminal: !!terminal, actionIndexes: actionIndexes || [] });

    const screened = screenRow(deps, row, ctx);
    if(screened.reason) return out(false, screened.reason, screened.terminal);
    const f = screened.fields;

    const ordered = await guardApplyOrder(deps, row, ctx, f);
    if(ordered) return out(false, ordered.reason, ordered.terminal);

    const member = verifyMembership(deps, row, f);
    if(member.reason) return out(false, member.reason, member.terminal);

    const target = await guardQuorumAndCopy(deps, row, ctx, f);
    if(target.reason) return out(false, target.reason, target.terminal);

    ctx.util.resetLists();

    const actionIndexes = [];
    const failed = await injectPolicyLegs(row, ctx, f, target, member, actionIndexes);
    if(failed) return await legFailure(ctx, f, actionIndexes, failed.failed);

    await recordApplied(deps, ctx, f, target, actionIndexes);
    return out(true, null, false, actionIndexes);
}

/**
 * @param {Object} deps - { canonicals, quorum, refusalLog }, built by the ENTRY; the leg
 *                        injectors are built here over the same refusal log
 */
module.exports = function createPolicy(deps){
    const bound = Object.assign({}, deps, { legs: createPolicyLegs({ refusalLog: deps.refusalLog }) });
    return { applyPolicySnapshot: (row, ctx) => applyPolicySnapshot(bound, row, ctx) };
};
