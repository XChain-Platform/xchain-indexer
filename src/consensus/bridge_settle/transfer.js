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
 * XChain Platform - bridge settle pass: this chain's leg of one finalized transfer.
 *
 * The apply is one ordered ladder of refusals followed by one ledger effect, and the phases
 * below keep that order exactly: a phase refuses by returning a SETTLE_REASON and the caller
 * stops there, so no phase can run ahead of a check the original ran before it. THE ORDER IS
 * CONSENSUS-VISIBLE, because which refusal a row takes decides whether an action index is
 * assigned at this block.
 *
 * BUILT BY THE ENTRY: the canonical builder, the quorum check and the escrow door come from
 * there (see the entry header and canonicals.js for why the entry owns those captures).
 *
 *
 * THE BODIES ARE PLAIN NAMED FUNCTIONS that take the entry's deps as their first argument, and
 * the factory at the foot only binds them. That keeps every step its own named function instead
 * of one long closure, while every capture still comes from the entry.
 ********************************************************************/

'use strict';

// One pure resolver owns both the asset namespace and the leg direction.
const { resolveTransferOrigin } = require('../bridge_checkpoint_check/origin.js');
const { SETTLE_REASON, isNull, int } = require('./reasons.js');
const { buildInLegEffects, buildOutLegEffects } = require('./leg_effects.js');
const { isSettled, isSourceLegSettled, recordSettlement } = require('./settlements.js');

/**
 * The refusals that read the ROW and the block alone, in order, before any database work.
 *
 * @returns {{reason: string}|{fields: Object}} a reason refuses the row where the original
 *          ladder refused it; `fields` carries the coerced row values the later phases use
 */
function screenRow(row, ctx){
    if(!row || typeof row !== 'object' || !ctx || typeof ctx !== 'object')
        return { reason: SETTLE_REASON.ROW_FIELDS };

    const id        = String(row.transfer_id || '');
    const srcChain  = String(row.src_chain || '');
    const destChain = String(row.dest_chain || '');
    const tick      = String(row.tick || '');
    const decimals  = int(row.decimals);
    const snapshot  = int(row.snapshot_block);
    // src_action_index is REQUIRED, not optional, because it is half of the source leg and the
    // source leg is what the one-settlement-per-leg refusal below is keyed on. A row that names
    // no source action cannot be tested for uniqueness at all, so admitting it would be a hole
    // straight through that refusal; it is also a row no real lock or burn can produce, since
    // the hub derives the field from the source action and signs it into the canonical.
    const srcIndex  = int(row.src_action_index);
    if(!id || !srcChain || !destChain || !tick || decimals === null || snapshot === null ||
       srcIndex === null || isNull(row.dest_address) || isNull(row.amount))
        return { reason: SETTLE_REASON.ROW_FIELDS };

    // Network scope, the CROSS_SETTLE belt-and-suspenders guard: the network is inside the
    // signed canonical, so a foreign-network row can never verify here anyway, but refusing it
    // before the signature work keeps a regtest-signed row from ever touching a mainnet ledger
    // read even if a mirror served it.
    if(String(row.network || '') !== String(ctx.network || ''))
        return { reason: SETTLE_REASON.NETWORK };

    // Chain identity, the relic spec's guard: `network` separates environments, `btc_chain_id`
    // separates RE-GENESES of one environment, which is the case a regtest rail actually hits.
    // Transport and not signed, so it is compared only when this node knows its own identity.
    const localChainId = ctx.config ? ctx.config['BTC_CHAIN_ID'] : null;
    if(!isNull(row.btc_chain_id) && !isNull(localChainId) &&
       String(row.btc_chain_id) !== String(localChainId))
        return { reason: SETTLE_REASON.CHAIN_ID };

    if(String(row.status || '') !== 'finalized')
        return { reason: SETTLE_REASON.NOT_FINALIZED };

    // The destination leg is always THIS chain's leg: an in leg mints here from a lock on the
    // origin, an out leg releases escrow here from a burn on the other side. Direction is
    // DERIVED from the row and is never a column.
    if(destChain !== String(ctx.coin || ''))
        return { reason: SETTLE_REASON.NOT_OURS };

    // Due, against the block loop's PROTOCOL time (median-time-past off mainnet), never a wall
    // clock: a wall clock differs per node and would apply the same row at different blocks.
    const blockTime = Number(ctx.blockTime);
    if(!Number.isFinite(blockTime) || Number(row.effective_time) > blockTime)
        return { reason: SETTLE_REASON.NOT_DUE };

    return { fields: { id, srcChain, destChain, tick, decimals, snapshot, srcIndex } };
}

/**
 * Everything that must hold before an effect: the two idempotency reads, the amount format,
 * the cross_chain quorum and the escrow cross-check, in that order.
 *
 * @returns {Promise<string|null>} the SETTLE_REASON that refuses the row, or null to apply
 */
async function guardApply(deps, row, ctx, f){
    const refusal = await guardSettledAndAmount(deps, row, ctx, f);
    if(refusal) return refusal;
    return await guardQuorumAndEscrow(deps, row, ctx, f);
}

/**
 * The first half of guardApply's order: the two idempotency reads, then the amount format.
 *
 * @returns {Promise<string|null>} the SETTLE_REASON that refuses the row, or null to go on
 */
async function guardSettledAndAmount(deps, row, ctx, f){
    const { warnOnce } = deps.refusalLog;
    const db = ctx.indexerDb;

    if(await isSettled(db, f.id, 'transfer'))
        return SETTLE_REASON.ALREADY_APPLIED;

    // ONE SETTLEMENT PER SOURCE LEG. The id-keyed test above answers "have I applied THIS row?";
    // this one answers "have I already paid out this lock or burn?", which is the question the
    // ledger of record has to answer and the hub's own guard cannot answer for it.
    //
    // IT IS A REFUSAL AND NOT A DEFERRAL, and that is the whole point: the fact it turns on is
    // a settlement this chain has already written, which no later block can unwrite short of a
    // local reorg below the applying block, and a reorg drops the record with the action index
    // so the leg re-applies on replay. Deferring instead would park the row on a barrier that
    // waits forever for something that will never change.
    //
    // REPLAY-SAFE because every input is in the ledger: the already-settled set is this chain's
    // own bridge_settlements table, and which of two duplicate rows applies first is fixed by
    // the due set's (snapshot_block, transfer_id) order and by effective_time against protocol
    // block_time, never by arrival order, a wall clock or the hub's AUTO_INCREMENT. Two nodes
    // replaying the same chain and the same mirror therefore refuse the same row.
    if(await isSourceLegSettled(db, f.srcChain, f.srcIndex)){
        warnOnce('XBRIDGE', f.id, SETTLE_REASON.SRC_LEG_APPLIED,
                  SETTLE_REASON.SRC_LEG_APPLIED + ' (' + f.srcChain + ':' + f.srcIndex + ') : skipping');
        return SETTLE_REASON.SRC_LEG_APPLIED;
    }

    // The amount moves as the SIGNED TEXT, not as a re-formatted number. `decimals` is a
    // signed field precisely so the string's precision is fixed by the record, and re-rendering
    // it here (bcadd returns a bignumber, whose String() drops trailing zeros) would put a
    // different literal in the ledger than the one the federation signed. So it is VALIDATED
    // against the signed decimals and then passed through untouched, the way every handler
    // passes a wire amount through.
    const amount = String(row.amount);
    if(!ctx.util.isValidAmountFormat(f.decimals, amount, ctx.blockTime) || !ctx.util.bcgt(amount, 0))
        return SETTLE_REASON.AMOUNT;
    return null;
}

/**
 * The second half of guardApply's order: the cross_chain quorum, then the escrow cross-check.
 *
 * @returns {Promise<string|null>} the SETTLE_REASON that refuses the row, or null to apply
 */
async function guardQuorumAndEscrow(deps, row, ctx, f){
    const { verifyQuorum }      = deps.quorum;
    const { transferCanonical } = deps.canonicals;
    const { log, warnOnce }     = deps.refusalLog;
    const db = ctx.indexerDb;

    // Quorum FIRST, before any effect and before the cross-check. An absent capability snapshot
    // is a retry and not a refusal: the block loop's snapshot barrier front-stops it, and this
    // branch is the residual-race guard.
    const quorum = await verifyQuorum(transferCanonical(row), row.validator_signatures,
                                      f.snapshot, row.network, db);
    if(quorum.snapshotAbsent){
        log('XBRIDGE', f.id, SETTLE_REASON.SNAPSHOT_ABSENT + ' : deferring');
        return SETTLE_REASON.SNAPSHOT_ABSENT;
    }
    if(!quorum.met){
        warnOnce('XBRIDGE', f.id, SETTLE_REASON.QUORUM,
                  SETTLE_REASON.QUORUM + ' (' + quorum.valid + '/' + quorum.total + ') : skipping');
        return SETTLE_REASON.QUORUM;
    }

    // THE ESCROW CHECK HOOK, called UNCONDITIONALLY and AFTER quorum verification but BEFORE any effect.
    // Unconditional on purpose: the module decides for itself which legs need a proof (an out
    // leg passes, because the escrow it releases is a local balance this node is authoritative
    // over), so there is no branch here that could be gated wrong. ok:false applies NOTHING.
    const cross = deps.verifyEscrowAgainstCheckpoint(row, ctx);
    if(!cross.ok){
        warnOnce('XBRIDGE', f.id, SETTLE_REASON.ESCROW_PROOF,
                  SETTLE_REASON.ESCROW_PROOF + ': ' + cross.reason + ' : skipping');
        return SETTLE_REASON.ESCROW_PROOF;
    }

    return null;
}

/**
 * Mint the internal settle action. Directly through createActionIndex and NEVER through
 * actions.processTransaction / processAction: actions/xbridge.js returns a system-injected
 * v2/v5 without writing a verdict, a row or a ledger effect, precisely so this pass is the
 * sole writer of the leg (the CROSS_SETTLE and XEXEC shape). FORMAT is 2 for the gas tick
 * and 5 for a general token, which is what the wire versions mean.
 *
 * @returns {Promise<number>} the action index the leg took
 */
async function mintSettleAction(deps, row, ctx, f, amount, gasTick, effects, isInLeg){
    const { log } = deps.refusalLog;
    const db = ctx.indexerDb;
    const data = {
        ACTION:      'XBRIDGE',
        FORMAT:      (f.tick === gasTick) ? 2 : 5,
        BLOCK_INDEX: ctx.blockIndex,
        BLOCK_TIME:  ctx.blockTime
    };
    data['ACTION_INDEX'] = await db.createActionIndex({ ACTION: 'XBRIDGE', BLOCK_INDEX: ctx.blockIndex, FORMAT: data['FORMAT'] });
    data['STATUS'] = 'valid';

    log('XBRIDGE v' + data['FORMAT'], f.id, (isInLeg ? 'mint ' : 'release ') + amount + ' ' +
         effects.localTick + ' -> ' + row.dest_address + ' : ' + data['STATUS']);

    await ctx.util.processTransactionLedgerChanges(db, data, effects.credits, effects.debits, []);
    await db.updateBalances(Object.keys(ctx.util.getAddressesList()));
    await db.updateTokens(ctx.util.getTickersList());
    await recordSettlement(db, data['ACTION_INDEX'], f.id, 'transfer', ctx.blockIndex, row);
    // The seam's ctx carries `actions`, not `mapper`; the mapper hangs off it, the way every
    // handler reaches it. Accepting an explicit ctx.mapper too keeps a direct caller (a test,
    // a recovery path) from having to build a whole actions object for one method.
    await (ctx.mapper || ctx.actions.mapper).createMappings(data);
    return data['ACTION_INDEX'];
}

/**
 * Apply this chain's leg of one finalized bridge transfer: XBRIDGE v2 (XCHAIN) and v5
 * (a general token). The direction is DERIVED from the row, never read from a column.
 *
 * IN leg (this chain is dest_chain, from a v0/v3 lock on the origin):
 *   credit(row.dest_address, tick, row.amount) at row.decimals
 *   token SUPPLY += row.amount
 *   creating the token row if this chain holds none yet - for XCHAIN the byte-identical
 *   injectGasToken parameter set through genesis.injectProtocolToken, for a general token
 *   the <ORIGIN> root row and then the <ORIGIN>.<NAME> child row.
 *
 * OUT leg (this chain is the origin, from a v1/v4 burn on the other side):
 *   debit(ADDRESS.BRIDGE_<row.src_chain>, tick, row.amount)
 *   credit(row.dest_address, tick, row.amount)
 *   An escrow balance that would go NEGATIVE is a protocol violation: apply nothing and log
 *   exactly one line naming the transfer_id.
 *
 * Injected legs pay no fee (the CROSS_SETTLE and XEXEC precedent) and bypass isActionAllowed
 * (so a sleeping origin still releases escrow to a burner).
 *
 * VERIFICATION, before any effect, is the CROSS_SETTLE rule verbatim: rebuild the
 * EQUIV-wrapped content canonical
 *   XBRIDGE|transfer_id|snapshot_block|tick|decimals|src_chain|src_action_index|src_address|dest_chain|dest_address|amount|effective_time|network
 * with ENGINE_TAGS.BRIDGE, ROUND_ID = transfer_id, VIEW = row.finalizing_view; a signature
 * counts only if its pubkey is in the cross_chain set at snapshot_block AND verifies, and a
 * pubkey enters the seen-set only AFTER its signature verifies; stake-weighted
 * source-deduped two-thirds at or above STAKE_WEIGHTED_QUORUM_ACTIVATION, else 2f+1. A
 * foreign `network` or a foreign `btc_chain_id` is refused outright.
 *
 * IDEMPOTENCY. A row whose (transfer_id, kind='transfer') is already in bridge_settlements
 * is skipped. The record is local and reorg-rollback-able on purpose: the mirrored row can
 * be deleted later, so "did this chain already apply it?" can never be a read of the mirror.
 *
 * ONE SETTLEMENT PER SOURCE LEG, beside that filter and keyed on (src_chain, src_action_index)
 * rather than on the id: a second row naming a lock or burn this chain has already paid out is
 * REFUSED, never deferred. See isSourceLegSettled.
 *
 * BUILT.
 *
 * @param {Object} row - one finalized bridge_transfers row as mirrored: transfer_id,
 *                       snapshot_block, network, src_chain, src_action_index, src_address,
 *                       dest_chain, dest_address, tick, decimals, amount, effective_time,
 *                       finalizing_view, validator_signatures, status, push_generation,
 *                       btc_chain_id
 * @param {Object} ctx - pass context: { actions, indexerDb, util, config, coin, network,
 *                       blockIndex, blockTime }. `blockTime` is the block loop's PROTOCOL
 *                       time (median-time-past off mainnet, the raw stamp on mainnet) and
 *                       is what effective_time is compared against, never a wall clock
 * @returns {Promise<{applied: boolean, reason: (string|null), actionIndex: (number|null)}>}
 *          applied false with a reason for a refusal (terminal) or a not-yet-due row
 *          (carried forward); the reason is what the single log line names
 */
async function applyBridgeTransfer(deps, row, ctx){
    const out = (applied, reason, actionIndex) => ({ applied: applied, reason: reason, actionIndex: actionIndex || null });

    const screened = screenRow(row, ctx);
    if(screened.reason) return out(false, screened.reason);
    const f = screened.fields;
    const origin = resolveTransferOrigin(row);
    if(!origin) return out(false, SETTLE_REASON.ROW_FIELDS);

    const refusal = await guardApply(deps, row, ctx, f);
    if(refusal) return out(false, refusal);

    // DIRECTION IS DERIVED FROM THE ROW and is never a column. Bare native ticks are locks
    // from src_chain, while a dest-rooted tick is a burn back to that native origin. XCHAIN
    // retains its BTC origin. The checkpoint check uses this same resolver.
    const isInLeg = (origin.kind === 'lock');
    const gasTick = ctx.config ? String(ctx.config['GAS']) : 'XCHAIN';
    const addresses = (ctx.config && ctx.config['ADDRESS']) || {};
    const amount = String(row.amount);

    // Reset the per-action address/ticker lists the way processAction does for every other
    // handler: this pass mints its action directly (actions/xbridge.js returns a system-injected
    // v2/v5 untouched), so nothing else resets them, and a stale list would make updateBalances
    // recompute an unrelated address.
    ctx.util.resetLists();

    const effects = isInLeg
        ? await buildInLegEffects(deps, row, ctx, f, amount, gasTick, addresses)
        : await buildOutLegEffects(deps, row, ctx, f, amount, addresses);
    if(effects.reason) return out(false, effects.reason);

    const actionIndex = await mintSettleAction(deps, row, ctx, f, amount, gasTick, effects, isInLeg);
    return out(true, null, actionIndex);
}

/**
 * @param {Object} deps - { canonicals, quorum, refusalLog, verifyEscrowAgainstCheckpoint },
 *                        all built or owned by the ENTRY
 */
module.exports = function createTransfer(deps){
    return { applyBridgeTransfer: (row, ctx) => applyBridgeTransfer(deps, row, ctx) };
};
