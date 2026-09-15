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
 * XChain Platform Action - BATCH: whole-batch validation
 *
 * Every check that judges a BATCH as a whole, before any sub-command runs, in the
 * order that decides which error string a batch breaking several rules reports. Each
 * check is guarded by `!error`, so the FIRST failing check names the verdict and the
 * call order in checkBatch is consensus. parse() in index.js calls these with the
 * Batch instance as `this`.
 *
 ********************************************************************/

// The three flag-day verdicts a BATCH is judged under, each resolved ONCE per BATCH.
async function resolveGates(data){
    // BATCH_SUBACTION_NORMALIZATION flag-day: when active, sub-actions get the same
    // alias rewrite + legacy VERSION 0 injection as top-level actions. Resolved once
    // per BATCH so every scan below gates identically.
    let normalize = await this.protocolChanges.isEnabled('BATCH_SUBACTION_NORMALIZATION', data['BLOCK_INDEX']);
    // BATCH_ISSUANCE_LIMITS flag-day: the global command cap, the dotted-TICK
    // exemption and the batch-cumulative value ledger below. Resolved once per BATCH,
    // like `normalize`, so every gated site in this handler and every sub-command the
    // dispatch loop runs sees ONE verdict. The gate is registered at or after
    // BATCH_SUBACTION_NORMALIZATION (asserted in test/unit/protocol/batch_issuance_limits_gate.test.js),
    // so wherever this is true, sub-command params are already normalized.
    let limitsActive = await this.protocolChanges.isEnabled('BATCH_ISSUANCE_LIMITS', data['BLOCK_INDEX']);
    // BATCH_COST_WEIGHTING flag-day: the flat command cap becomes a budget over per-action
    // cost weights. Resolved once per BATCH like the two above, so every gated site sees ONE
    // verdict. Registered at or after BATCH_ISSUANCE_LIMITS (asserted in
    // test/unit/fees/batch_cost_weighting_gate.test.js), so wherever this is true the classification
    // and normalization the weight scan reads from are already in force.
    let weightsActive = await this.protocolChanges.isEnabled('BATCH_COST_WEIGHTING', data['BLOCK_INDEX']);
    return { normalize, limitsActive, weightsActive };
}

// Judge the BATCH as a whole. Returns its command list and the first error found, or the
// error it was handed; the order of the calls below is the consensus error precedence.
async function checkBatch(data, error, gates){
    let commands;
    ({ commands, error } = readCommands.call(this, data, error));
    error = await commandCapError.call(this, commands, data, error, gates);
    let tally = tallyActions.call(this, commands, gates);

    /*****************************************************************
     * General Validations
     ****************************************************************/
    error = await activationError.call(this, commands, data, error, gates.normalize);
    error = await actionCapError.call(this, tally, error, gates.limitsActive);

    // Verify SOURCE is not sleeping
    if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    error = await gasError.call(this, commands, data, error, gates);
    return { commands, error };
}

// Verify the FORMAT and split TX_DATA into its sub-commands, stripping the BATCH|VERSION prefix.
function readCommands(data, error){
    /*****************************************************************
     * DEBUGGING - Force params
     ****************************************************************/
    // Example payloads by FORMAT version:
    // data['TX_DATA'] = "BATCH|0|MINT|0|GAS|60;ISSUE|0|JDOGTEST";
    // params = String(str).split('|');
    // data['FORMAT'] = this.util.getFormatVersion(params[0]);

    // Validate that format is known
    let format = data['FORMAT'];
    // Verify VERSION is a format this action recognizes
    if(!error && (format===null || this.formats[format] === undefined ))
        error = 'invalid: VERSION (unknown)';

    // Get list of commands
    let commands = String(data['TX_DATA']).split(';');
    // Verify the batch contains at least one command
    if(!error && (this.util.isNull(commands) || commands.length < 1)){
        error = 'invalid: COMMAND (unknown)';
    } else {
        // The first command still carries the BATCH|VERSION prefix; strip it.
        commands[0] = commands[0].replace('BATCH|' + format + '|','');
    }
    return { commands, error };
}

// Global command cap (BATCH_ISSUANCE_LIMITS), FIRST of the command checks.
// It is the only check that bounds the two O(N) scans below, and running it
// first PINS error precedence: a batch that breaks this rule and others reports
// the cap, never the rule a later loop would have found. Counting semantics are
// consensus-pinned: the raw ';'-split list AFTER the BATCH|<version>| prefix
// strip, EMPTY elements included (an empty element already whole-batch-rejects
// via the activation scan, so charging it a slot is consistent). Over-limit
// takes the existing whole-batch shape: one invalid record, no sub-command runs.
//
// BATCH_COST_WEIGHTING replaces the count with a WEIGHT BUDGET in this same position,
// for the same reason it had to be first, and reports the SAME string: the error is
// still "this batch is too much work", only measured better.
//
// The count test survives as a PRE-FILTER rather than being deleted, and it is load
// bearing twice over. Every weight is >= 1 (see subCommandWeight), so a batch whose raw
// count already exceeds the budget cannot possibly weigh in under it: rejecting it here
// is exact, not conservative. And weighing is not free - the fan-out classes need an
// as-of read per sub-command - so without this filter the envelope lane's ~35,000
// sub-commands would each buy a database read BEFORE anything bounded them, which is
// the denial-of-service the budget exists to close rather than open.
async function commandCapError(commands, data, error, gates){
    let { normalize, limitsActive, weightsActive } = gates;
    if(!error && limitsActive){
        if(commands.length > (weightsActive ? this.weightBudget : this.commandLimit)){
            error = 'invalid: COMMAND (limit)';
        } else if(weightsActive && await this.batchWeight(commands, data, normalize) > this.weightBudget){
            error = 'invalid: COMMAND (limit)';
        }
    }
    return error;
}

// Count each ACTION's uses in the BATCH, in first-appearance order, collecting MINT TICKs.
function tallyActions(commands, gates){
    let { normalize, limitsActive } = gates;
    // Define list of ACTIONS and count of usage within BATCH
    let actions = {};

    // The DISTINCT keys of `actions`, in the order their FIRST sub-command appears in the
    // command list. That order is DECLARED: among per-ACTION caps, a batch breaking two of
    // them reports the action whose first sub-command comes earliest, and that string is
    // consensus. It is kept as its own list rather than read back off `actions` because the
    // tally is a plain object whose iteration order is a property of key INSERTION (and of
    // integer-like keys, which an unknown ACTION can produce), not a stated rule: a later
    // tidy-up to a Map, a sort, or a second counting pass would silently move a consensus
    // string. First-appearance is the order this loop and the SDK mirror both produce, so
    // declaring it moves no verdict; do not "simplify" the cap loop
    // in actionCapError back into an iteration over the tally.
    let actionOrder = [];

    // TICKs of this batch's MINT sub-commands, in list order, collected in the SAME pass
    // that counts them so the two can never disagree about which commands are MINTs
    // (MINTs are capped per DISTINCT token, so the count alone is not the whole story).
    // Populated only under the flag: below it nothing reads it and no work is done.
    let mintTicks = [];

    // Build out array of ACTIONs and count of times used in BATCH
    for(let command of commands){
        let action = String(command).split('|')[0];
        if(normalize)
            action = this.normalizeSubAction(action);
        if(limitsActive){
            action = this.classifyLimitAction(action, command, normalize);
            if(action === 'MINT')
                mintTicks.push(this.subCommandTick(action, command, normalize));
        }
        if(this.util.isNull(actions[action])){
            actions[action] = 0;
            // First sighting, and this IS the list walk, so pushing here is what makes the
            // cap loop's order list-driven rather than tally-driven.
            actionOrder.push(action);
        }
        actions[action]++;
    }
    return { actions, actionOrder, mintTicks };
}

// The activation scan: every sub-command's ACTION must be enabled at this block.
async function activationError(commands, data, error, normalize){
    // Verify all ACTION commands are valid
    for(let command of commands){
        let action = String(command).split('|')[0];
        if(normalize)
            action = this.normalizeSubAction(action);
        // Verify this sub-command's action is currently enabled on the network
        if(!error && await this.protocolChanges.isEnabled(action, data['BLOCK_INDEX']) == false)
            error = 'invalid: ACTION (unknown)';
    }
    return error;
}

// The per-ACTION usage caps, walked in first-appearance order off the tally.
async function actionCapError(tally, error, limitsActive){
    let { actions, actionOrder, mintTicks } = tally;
    // Per-ACTION caps in force for THIS batch. Below the flag this IS the pre-flag table,
    // by identity, so nothing about an old batch can move; at/after it the gated caps
    // (the DEPLOY cap) are merged into a COPY, never into either stored table.
    let actionLimits = limitsActive ? Object.assign({}, this.actionLimits, this.gatedActionLimits) : this.actionLimits;

    // Walked in first-appearance order, which is why `actionOrder` exists: the action
    // that names the error must be decided by the command LIST, never by however the tally
    // object happens to enumerate.
    for(let action of actionOrder){
        let count = actions[action];
        // MINT is capped per DISTINCT TOKEN rather than per batch, so what the cap is
        // compared against is the largest number of MINTs naming ONE token, not the raw
        // occurrence count. Guarded by !error because it is the only branch in this loop
        // that touches the database: an already-invalid batch keeps its cheaper verdict
        // and pays for no reads, exactly as the gas pre-check below does.
        if(!error && limitsActive && action === 'MINT')
            count = await this.maxMintsPerDistinctTick(mintTicks);
        // Verify ACTION command limits
        if(!error && Object.keys(actionLimits).includes(action) && count > actionLimits[action])
            error = 'invalid: ' + action  + ' (limit)';
    }
    return error;
}

// Aggregate gas pre-check (BATCH_ISSUANCE_LIMITS, ruled 2026-08-13).
// LAST of the checks by design: it is the only one that costs database reads (one per
// DISTINCT new TICK plus one balance read), so every cheaper verdict above short-circuits
// it through `!error`, and the 250-command cap - still the FIRST check - is what bounds
// its loop. Precedence therefore stays exactly as the error-order tests pin it: a batch that breaks
// the cap, the per-ACTION limits or the activation scan reports THAT error, never this
// one. See isGasProvablyUnaffordable for why the predicate is the cheapest sub-command
// and not the sum.
//
// `weightsActive` is threaded in so that at/after BATCH_COST_WEIGHTING the predicate
// can also price an ORDER/SWAP/DISPENSER create, so an all-ORDER no-gas batch collapses
// to one invalid record the same way an all-ISSUE one does. Below that flag the
// argument is false and the predicate is byte-identical to its unweighted form.
async function gasError(commands, data, error, gates){
    let { normalize, limitsActive, weightsActive } = gates;
    if(!error && limitsActive && await this.isGasProvablyUnaffordable(commands, data, normalize, weightsActive))
        error = 'invalid: GAS (insufficient)';
    return error;
}

module.exports = { resolveGates, checkBatch };
