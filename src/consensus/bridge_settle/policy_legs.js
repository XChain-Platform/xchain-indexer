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
 * XChain Platform - bridge settle pass: injecting one policy snapshot's legs.
 *
 * The synthetic transactions a policy snapshot materializes, in their PINNED ordinal order,
 * and the rule for a leg the chain refused. Split out of policy.js so neither file passes the
 * 400-line limit; the ordinals, the injection shape and the refusal rule are unchanged.
 *
 * BUILT BY THE ENTRY like the rest of the pass, because the refusal log it writes through is
 * built there (see bridge_settle.js and bridge_settle/refusal_log.js).
 *
 *
 * THE BODIES ARE PLAIN NAMED FUNCTIONS that take the entry's deps as their first argument, and
 * the factory at the foot only binds them. That keeps every step its own named function instead
 * of one long closure, while every capture still comes from the entry.
 ********************************************************************/

'use strict';

const { SETTLE_REASON, POLICY_LEG_ORDINAL, POLICY_TX_PREFIX,
        LIST_TYPE_ADDRESS, LIST_EDIT_ADD, LIST_EDIT_REMOVE } = require('./reasons.js');
const gateRegistry = require('../gate_registry');
const { recordSettlement } = require('./settlements.js');
const { planListLeg } = require('./policy_list_plan.js');
const { bindPolicyRef, refNeedsPointer } = require('./policy_ref_bind.js');

/**
 * The injectors for one snapshot's legs, closed over the action indexes they mint.
 *
 * Each leg is a synthetic transaction of its own, tx_hash = 'XPOLICY-' + 48 characters of
 * the snapshot id and vout = the leg's PINNED ordinal, so every node assigns the same
 * action index to the same leg. Routed through processTransaction(tx, true), which stamps
 * IS_GENESIS: that flag is what exempts the injected SLEEP from the copy's LOCK_SLEEP and
 * the injected edits from the bridge-owned LIST refusal. No broadcast action ever carries
 * it, so no historical verdict moves.
 */
function legInjectors(row, ctx, f, target, actionIndexes){
    const db = ctx.indexerDb;

    const inject = async (fields, ordinal) => {
        const tx = {
            data:          fields.join('|'),
            source:        target.owner,
            destination:   null,
            amount:        null,
            tx_hash:       POLICY_TX_PREFIX + f.id.slice(0, 48),
            vout:          ordinal,
            block_index:   ctx.blockIndex,
            block_time:    ctx.blockTime,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    []
        };
        const applied = await ctx.actions.processTransaction(tx, true);
        if(applied && applied['ACTION_INDEX'] !== undefined && applied['ACTION_INDEX'] !== null)
            actionIndexes.push(Number(applied['ACTION_INDEX']));
        return applied;
    };

    // Create a missing list or edit an attached list to match the snapshot. A format 1 LIST
    // carries one verb, so removals and additions use separate pinned ordinals.
    // Detach emits no LIST leg; ISSUE 5 clears the pointer with its zero sentinel.
    const applyList = async (list, hasField, detachActive, existingIndex, createOrRemoveOrdinal, addOrdinal) => {
        const plan = planListLeg({ list, hasField, detachActive, existingIndex });
        if(plan.op === 'skip') return { created: null };
        if(plan.op === 'detach') return { created: 0 };
        if(plan.op === 'create'){
            const created = await inject(['LIST', '0', LIST_TYPE_ADDRESS, ''].concat(list), createOrRemoveOrdinal);
            if(!created || created['STATUS'] !== 'valid') return { created: false };
            return { created: Number(created['ACTION_INDEX']) };
        }
        const current = await db.getList(existingIndex, ctx.blockIndex);
        const have    = new Set((current || []).map(String));
        const want    = new Set(list.map(String));
        const remove  = [...have].filter(a => !want.has(a));
        const add     = list.filter(a => !have.has(String(a)));
        if(remove.length){
            const r = await inject(['LIST', '1', LIST_EDIT_REMOVE, String(existingIndex), ''].concat(remove), createOrRemoveOrdinal);
            if(!r || r['STATUS'] !== 'valid') return { created: false };
        }
        if(add.length){
            const a = await inject(['LIST', '1', LIST_EDIT_ADD, String(existingIndex), ''].concat(add), addOrdinal);
            if(!a || a['STATUS'] !== 'valid') return { created: false };
        }
        return { created: null };
    };

    return { inject, applyList };
}

/**
 * A leg the chain REFUSED is neither of the error rule's carried cases (those are about ordering) and
 * it is not one of its terminal ones either, so the rule has to be reasoned out rather than
 * looked up. It turns on whether a retry could duplicate work:
 *   - nothing landed yet: nothing to duplicate, so CARRY. A later block retries for free.
 *   - something landed:   a retry would re-create the list it already created, because the
 *                         pointer that would have made the second run see it is exactly the
 *                         leg that failed. That loop mints fresh action indexes on every
 *                         node on every block, forever. So the snapshot is RECORDED and
 *                         never retried, loudly: the cross_settle rule that a row which can
 *                         make no further progress is recorded so it stops being re-evaluated.
 * The copy is then left with whatever legs did land and no pointer; the applied-policy read
 * and the invariant watch are what surface it.
 */
async function legFailure(deps, ctx, f, actionIndexes, which){
    const { warn } = deps.refusalLog;
    const db = ctx.indexerDb;
    if(actionIndexes.length === 0){
        warn('XPOLICY', f.id, SETTLE_REASON.POLICY_LEG + ' (' + which + ') : nothing applied, carrying forward');
        return { applied: false, reason: SETTLE_REASON.POLICY_LEG, terminal: false, actionIndexes: actionIndexes };
    }
    warn('XPOLICY', f.id, SETTLE_REASON.POLICY_LEG + ' (' + which + ') : ' + actionIndexes.length +
          ' leg(s) already applied, recording so the pass cannot re-inject them');
    await recordSettlement(db, actionIndexes[actionIndexes.length - 1], f.id, 'policy', ctx.blockIndex,
                           { src_chain: f.origin, src_action_index: null, dest_chain: ctx.coin,
                             dest_address: null, tick: f.name });
    return { applied: false, reason: SETTLE_REASON.POLICY_LEG, terminal: true, actionIndexes: actionIndexes };
}

function refParts(ref){
    const colon = ref.indexOf(':');
    return { chain: ref.slice(0, colon), index: ref.slice(colon + 1) };
}

async function resolvePolicyRefs(ctx, member){
    const bind = async (ref) => ref ? await bindPolicyRef(ctx.indexerDb, {
        ref: refParts(ref), coin: ctx.coin, blockIndex: ctx.blockIndex
    }) : null;
    const [allow, block] = await Promise.all([bind(member.allowRef), bind(member.blockRef)]);
    if((allow && allow.pending) || (block && block.pending)) return { pending: true };
    return { allow: allow && allow.index, block: block && block.index };
}

async function ownedListIndex(ctx, target, index){
    if(index === null || index === undefined || index === '') return index;
    if(typeof ctx.indexerDb.getListShareMirrorByIndex === 'function' &&
       await ctx.indexerDb.getListShareMirrorByIndex(index)) return null;
    if(typeof ctx.indexerDb.getListSource !== 'function') return index;
    const owner = await ctx.indexerDb.getListSource(index);
    return String(owner) === String(target.owner) ? index : null;
}

async function fullCopyIndex(ctx, target, index){
    const active = gateRegistry.activeAt('list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION',
                                         ctx.network, ctx.coin, ctx.blockIndex, null);
    return active ? await ownedListIndex(ctx, target, index) : index;
}

/**
 * Inject the membership, pointer and sleep legs in their pinned ordinal order.
 *
 * @returns {Promise<{failed: string}|{pending: boolean}|null>} the leg name that refused,
 *          pending when a ref cannot bind, or null when every leg applied
 */
async function injectPolicyLegs(row, ctx, f, target, member, actionIndexes){
    const refs = await resolvePolicyRefs(ctx, member);
    if(refs.pending) return { pending: true };
    const { inject, applyList } = legInjectors(row, ctx, f, target, actionIndexes);
    const detachActive = gateRegistry.activeAt('bridge_policy_detach_activation.BRIDGE_POLICY_DETACH',
                                                ctx.network, ctx.coin, ctx.blockIndex, null);
    const hasAllowField = Object.prototype.hasOwnProperty.call(row, 'allow_list');
    const hasBlockField = Object.prototype.hasOwnProperty.call(row, 'block_list');

    const allowIndex = member.allowRef ? target.info['ALLOW_LIST'] :
        await fullCopyIndex(ctx, target, target.info['ALLOW_LIST']);
    const blockIndex = member.blockRef ? target.info['BLOCK_LIST'] :
        await fullCopyIndex(ctx, target, target.info['BLOCK_LIST']);
    const allowRes = member.allowRef ?
        { created: refNeedsPointer(allowIndex, refs.allow) ? refs.allow : null } :
        await applyList(member.allow, hasAllowField, detachActive, allowIndex,
                        POLICY_LEG_ORDINAL.ALLOW_CREATE_OR_REMOVE, POLICY_LEG_ORDINAL.ALLOW_ADD);
    if(allowRes.created === false) return { failed: 'allow list' };
    const blockRes = member.blockRef ?
        { created: refNeedsPointer(blockIndex, refs.block) ? refs.block : null } :
        await applyList(member.block, hasBlockField, detachActive, blockIndex,
                        POLICY_LEG_ORDINAL.BLOCK_CREATE_OR_REMOVE, POLICY_LEG_ORDINAL.BLOCK_ADD);
    if(blockRes.created === false) return { failed: 'block list' };

    // Point the copy only when a list was created or detached. Edits retain their pointer;
    // empty ISSUE 5 fields inherit current ids, so skip a pointer leg when both results
    // are null.
    if(allowRes.created !== null || blockRes.created !== null){
        const point = await inject(['ISSUE', '5', target.copyTick,
                                    allowRes.created === null ? '' : String(allowRes.created),
                                    blockRes.created === null ? '' : String(blockRes.created)],
                                   POLICY_LEG_ORDINAL.ISSUE_POINT);
        if(!point || point['STATUS'] !== 'valid') return { failed: 'ISSUE 5' };
    }

    // Tick sleep. The origin's own resume_block is NOT carried: heights are not comparable
    // across chains. `sleeping` true injects resume_block -1 (indefinite); false injects the
    // CURRENT block, which reads awake at that block and after (db.js sleeps only on -1 or a
    // future block, and sleep.js admits equality). Injected only when the state would change,
    // so a snapshot that says nothing new about sleep costs no action index.
    const isAsleep = await ctx.indexerDb.isTickSleeping(target.copyTick, ctx.blockIndex);
    if(!!isAsleep !== member.sleeping){
        const slept = await inject(['SLEEP', '1', member.sleeping ? '-1' : String(ctx.blockIndex), target.copyTick],
                                   POLICY_LEG_ORDINAL.SLEEP);
        if(!slept || slept['STATUS'] !== 'valid') return { failed: 'SLEEP' };
    }
    return null;
}

/**
 * @param {Object} deps - { refusalLog }, built by the ENTRY
 */
module.exports = function createPolicyLegs(deps){
    return {
        legInjectors,
        legFailure: (ctx, f, actionIndexes, which) => legFailure(deps, ctx, f, actionIndexes, which),
        injectPolicyLegs,
    };
};
