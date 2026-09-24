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
 * ISSUE controller binding (format 6, the programmable policy layer): the check that
 * CONTROLLER names a live contract, the per-action-class bind/unbind rules, and the
 * token_controllers event a valid format-6 ISSUE appends.
 *
 * This is where a guard gets BOUND to a token. Where a bound guard RUNS is each guarded
 * handler's own controller_guard.js (mint, destroy and the others).
 *
 * Each function runs with `this` bound to the Issue handler (./index.js and ./settle.js
 * call each as fn.call(this, ctx)) and reads and writes the shared context.
 *
 ********************************************************************/

'use strict';

// Verify CONTROLLER references an existing, active contract on this chain.
// The bound contract's `guard` method is consulted before guarded native
// actions on this token settle (see
// xchain-documentation/protocol/controller-bound-tokens.md). Mirrors the
// contract-active check in actions/execute/index.js so a token can only bind to a
// contract the indexer can actually execute. A guard whose `guard` method is
// missing/throws is fail-closed at runtime (denies the action), not here.
async function validateControllerContract(ctx){
    let { data } = ctx;
    let error = ctx.error;

    if(!error && !this.util.isNull(data['CONTROLLER'])){
        let controllerInfo = await this.indexerDb.getContract(data['CONTROLLER']);
        if(!controllerInfo){
            error = 'invalid: CONTROLLER (unknown)';
        } else {
            let controllerStatus = await this.indexerDb.getStatusString(controllerInfo.status_id);
            if(controllerStatus !== 'valid')
                error = 'invalid: CONTROLLER (not active)';
        }
    }

    ctx.error = error;
}

// Programmable policy layer: token controller bind/unbind (format 6). The CONTROLLER-active
// check above already validated the bound contract (when CONTROLLER is set); here we validate
// the per-action-class binding semantics. SOURCE-is-owner is enforced by the generic
// "issued by another address" check above (tokenInfo is required, so it always applies).
async function validateControllerBinding(ctx){
    let { data, issue, tokenInfo, format } = ctx;
    let error = ctx.error;

    if(!error && format === 6){
        let actionClass = (this.util.isNull(data['ACTION_CLASS'])) ? null : String(data['ACTION_CLASS']).toLowerCase();
        let isUnbind    = (String(data['UNBIND']) === '1');
        if(!tokenInfo){
            // Can only bind a controller to an existing token you own
            error = 'invalid: TICK (unknown)';
        } else if(this.config['CONTROLLER_BINDABLE_CLASSES'].indexOf(actionClass) === -1){
            error = 'invalid: ACTION_CLASS (unknown)';
        } else {
            let tickId    = await this.indexerDb.getTickerId(data['TICK']);
            let effective = await this.indexerDb.getEffectiveTokenController(tickId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(isUnbind){
                // UNBIND: an effective (still-gating) controller must exist for this class, and
                // it must be a live bind. A second unbind while one is already in its cooldown
                // window is rejected (the drop is already scheduled).
                if(!effective)
                    error = 'invalid: ACTION_CLASS (not bound)';
                else if(Number(effective.is_unbind) === 1)
                    error = 'invalid: ACTION_CLASS (already unbinding)';
            } else {
                // BIND: CONTROLLER required, no controller may already gate this class (no
                // stacking; replace = unbind-then-bind, which preserves the cooldown's teeth),
                // and any COOLDOWN_BLOCKS given must be a non-negative integer.
                if(this.util.isNull(data['CONTROLLER']))
                    error = 'invalid: CONTROLLER (null)';
                else if(effective)
                    error = 'invalid: ACTION_CLASS (already bound)';
                else if(!this.util.isNull(issue['COOLDOWN_BLOCKS']) && !/^\d+$/.test(String(issue['COOLDOWN_BLOCKS'])))
                    error = 'invalid: COOLDOWN_BLOCKS (format)';
            }
        }
    }

    ctx.error = error;
}

// Programmable policy layer: append the token controller bind/unbind event (format 6).
// The binding lives in token_controllers (not the token record); the issues row above is
// the audit trail. issue['CONTROLLER']/['COOLDOWN_BLOCKS'] are the raw (pre-numeric)
// values, which map cleanly onto the BIGINT/INT columns.
async function recordControllerEvent(ctx){
    let { data, issue, format } = ctx;

    if(format === 6){
        let tickId      = await this.indexerDb.getTickerId(data['TICK']);
        let actionClass = String(data['ACTION_CLASS']).toLowerCase();
        let boundById   = await this.indexerDb.createAddress(data['SOURCE']);
        if(String(data['UNBIND']) === '1'){
            // The drop schedules at block + the live bind's committed cooldown; the controller
            // keeps gating until then. effective is non-null + a live bind (validated above).
            let effective   = await this.indexerDb.getEffectiveTokenController(tickId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let cooldown    = Number(effective.cooldown_blocks) || 0;
            let cooldownEnd = parseInt(data['BLOCK_INDEX']) + cooldown;
            await this.indexerDb.recordTokenControllerEvent({
                action_index: data['ACTION_INDEX'], tick_id: tickId, action_class: actionClass,
                contract_index: effective.contract_index, bound_by_id: boundById, is_unbind: 1,
                cooldown_blocks: cooldown, cooldown_end_block: cooldownEnd, block_index: data['BLOCK_INDEX']
            });
        } else {
            let cooldown = (this.util.isNull(issue['COOLDOWN_BLOCKS'])) ? 0 : parseInt(issue['COOLDOWN_BLOCKS']);
            await this.indexerDb.recordTokenControllerEvent({
                action_index: data['ACTION_INDEX'], tick_id: tickId, action_class: actionClass,
                contract_index: issue['CONTROLLER'], bound_by_id: boundById, is_unbind: 0,
                cooldown_blocks: cooldown, cooldown_end_block: null, block_index: data['BLOCK_INDEX']
            });
        }
    }
}

module.exports = { validateControllerContract, validateControllerBinding, recordControllerEvent };
