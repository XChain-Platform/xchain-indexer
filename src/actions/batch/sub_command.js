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
 * XChain Platform Action - BATCH: reading one sub-command
 *
 * How the handler reads a single sub-command off the wire before anything runs: its
 * canonical ACTION name, the limit class it counts under, the TICK its handler will
 * parse, and its cost weight (plus the batch's total weight). These are Batch
 * prototype methods, installed by index.js, so each runs with the instance as `this`.
 *
 ********************************************************************/

// Normalize a sub-action the same way the top-level dispatcher (actions/index.js)
// does: rewrite ACTION aliases, then (when params are given) inject the
// implied legacy VERSION 0 for BTNS-style ISSUE/MINT/SEND params so FORMAT
// derivation sees a version field. Mutates params in place; returns the
// canonical ACTION name. Callers only invoke this at/after the
// BATCH_SUBACTION_NORMALIZATION flag-day; before it, sub-actions keep the
// historical un-normalized behaviour (aliased names invalidate the BATCH,
// legacy-format params misparse) for byte-identical replay.
function normalizeSubAction(action, params){
    for(let alias in this.actions.actionAliases){
        if(action == alias)
            action = this.actions.actionAliases[alias];
    }
    if(params && ['ISSUE','MINT','SEND'].includes(action) && this.util.isLegacyActionFormat(params))
        params.splice(0,0,0);
    return action;
}

// Classify a sub-command for the per-ACTION limit scan (BATCH_ISSUANCE_LIMITS).
//
// Only ISSUE is reclassified: a CHILD issuance (dotted TICK, e.g. JDOG.1) is exempt
// from the top-level limit of 1, so one BATCH may register a parent plus any number
// of its children, while an undotted TICK still consumes the single top-level slot.
// The dot test runs on the TICK the EXECUTOR will see: params[1] in all seven ISSUE
// formats, read off a private split copy after the same normalizeSubAction the
// dispatch loop applies (that call injects the implied legacy VERSION 0 in place, so
// it must never touch the caller's array).
//
// Caret TICKs (^<id>[.<n>]) are NEVER exempt: the caret form is an id reference and
// its dot is a decimal, not a namespace separator, so it counts as top-level.
// A malformed command with no TICK is likewise counted as top-level: exemption is
// granted on positive evidence only. Never throws - a classifier crash here would
// halt block processing - so any surprise falls back to the unclassified name, which
// is the pre-flag behaviour.
function classifyLimitAction(action, command, normalize){
    if(action !== 'ISSUE')
        return action;
    try {
        let params = String(command).split('|').slice(1);
        // Mirror the dispatch loop exactly: it normalizes params only under the
        // normalization flag, and classification must read TICK from the same shape
        // the handler will parse.
        if(normalize)
            this.normalizeSubAction(action, params);
        let tick = params[1];
        if(tick === undefined || tick === null)
            return action;
        tick = String(tick);
        if(tick.charAt(0) == '^')
            return action;
        if(tick.includes('.'))
            return this.childIssueKey;
        return action;
    } catch(e) {
        return action;
    }
}

// Read the TICK a sub-command's handler will parse (BATCH_ISSUANCE_LIMITS per-token MINT cap).
//
// TICK sits at params[1] in ALL SEVEN ISSUE formats and in MINT's SINGLE format
// (VERSION|TICK|AMOUNT|DESTINATION|MEMO, mint.js:41), so positional extraction is not
// format-fragile for either action and no per-action position rule is needed. It must be
// read AFTER the same normalizeSubAction the dispatch loop applies: that call injects the
// implied legacy VERSION 0 for BTNS-style params, and an un-normalized legacy MINT carries
// its TICK one position earlier (MINT|TICK|AMOUNT|DESTINATION).
//
// Runs on a PRIVATE split copy because normalizeSubAction splices params in place and must
// never reach the caller's array. Returns '' when there is no TICK at all, which callers
// read as "no positive evidence", never as a token named the empty string. The trim mirrors
// the gas pre-check's probe: an untrimmed spelling the executor would reject can only
// COLLAPSE into a real tick's bucket here, which is the safe direction (it rejects, never
// admits). Never throws, because a classifier crash here would halt block processing.
//
// classifyLimitAction above deliberately keeps its own copy of the extraction rather than
// calling this helper: it is consensus code already driven green on chain, so it is not
// re-derived through a new shared path just for tidiness.
function subCommandTick(action, command, normalize){
    try {
        let params = String(command).split('|').slice(1);
        if(normalize)
            this.normalizeSubAction(action, params);
        let tick = params[1];
        if(tick === undefined || tick === null)
            return '';
        return String(tick).trim();
    } catch(e) {
        return '';
    }
}

// Cost weight of ONE sub-command (BATCH_COST_WEIGHTING).
//
// THE INVARIANT, and every future weight class must preserve it: the return is an integer
// >= 1. It is what makes the cheap count pre-filter in parse() a sound bound on this scan
// (count > budget implies weight sum > budget, so an oversized batch is refused without
// weighing anything), and a weight of 0 would let a batch carry unbounded sub-commands of
// that action for free, which is the exact failure the budget exists to prevent.
//
// `action` arrives already alias-normalized by the caller, matching the dispatch loop.
// `data` and `normalize` are unused by the default and table paths and are threaded through
// for the fan-out classes (AIRDROP, DIVIDEND), whose weight is 1 + recipients and whose
// recipient count is NOT on the wire: AIRDROP carries a LIST_ACTION_INDEX and DIVIDEND
// carries only a TICK, so both need an as-of read. Those reads must be as-of
// (BLOCK_INDEX, ACTION_INDEX) and resolve-only, the discipline probeTokenInfo and
// probeTickerId already set in this handler, or two nodes will weigh the same batch
// differently and fork.
//
// Async from the outset for that reason: adding the first fan-out class must not change
// this signature, because the signature is what parse() and every other weight class are
// written against.
//
// Never throws. A weight crash here would halt block processing, and the safe fallback is
// the default 1, which is the pre-flag behaviour for that sub-command.
async function subCommandWeight(action, command, data, normalize){
    try {
        let weight = this.commandWeights[action];
        if(weight === undefined)
            return 1;
        // Chunk-carrier DEPLOY (format 4) takes the default row-write weight rather than
        // DEPLOY's VM weight: since DEPLOY_DEFERRED_ASSEMBLY the carrier that completes a
        // group does run the constructor, but the one-DEPLOY-per-batch name cap already
        // bounds a batch to one constructor whichever piece completes it. The format comes from the same
        // util.getFormatVersion(params[0]) derivation the dispatcher uses (see the
        // commandWeights['DEPLOY'] note in limits.js); anything unparseable falls through to the
        // full weight, which is the safe (over-charging) direction.
        if(action === 'DEPLOY' && this.util.getFormatVersion(String(command).split('|')[1]) === 4)
            return 1;
        return (Number.isInteger(weight) && weight >= 1) ? weight : 1;
    } catch(e) {
        return 1;
    }
}

// Total cost weight of a BATCH (BATCH_COST_WEIGHTING).
//
// Plain integer arithmetic, not the bc* helpers: these are small counts, not token amounts,
// and the surrounding cap logic has always compared counts with `>`. The loop is bounded by
// the count pre-filter in parse(), which is why that filter runs first.
//
// Actions are read and alias-normalized exactly as the two scans in validate.js do it, off
// the raw sub-command string, so the weight scan and the dispatch loop can never disagree
// about what a sub-command IS.
async function batchWeight(commands, data, normalize){
    let total = 0;
    for(let command of commands){
        let action = String(command).split('|')[0];
        if(normalize)
            action = this.normalizeSubAction(action);
        total += await this.subCommandWeight(action, command, data, normalize);
    }
    return total;
}

module.exports = { normalizeSubAction, classifyLimitAction, subCommandTick, subCommandWeight, batchWeight };
