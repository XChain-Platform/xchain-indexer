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
 * XChain Platform Action - BATCH
 *
 * This action batch executes multiple `ACTION` commands in a single transaction
 *
 * PARAMS:
 * - VERSION - Format Version
 * - COMMAND - Any valid `ACTION` with `PARAMS`
 *
 * FORMATS:
 * - 0 = Full (VERSION|COMMAND;COMMAND)
 *
 * The entry and the sub-command dispatch. The handler's other parts sit beside this
 * file, one behaviour each: limits.js (the caps and cost weights), sub_command.js
 * (reading one sub-command), mint_cap.js (the per-token MINT cap), fees.js (the
 * aggregate gas pre-check), validate.js (whole-batch validation) and probe.js (the
 * public pre-flight collectors).
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
// The probe-path sub-action refusal is NOT required from actions/index.js here: that loader
// requires this handler while it is still being evaluated, so a top-level require would bind an
// empty exports object, and one action never requires another. The loader instance this class
// is constructed with carries the predicate instead (this.actions.isBatchProbeForbiddenSubAction).

const limits     = require('./limits.js');
const subCommand = require('./sub_command.js');
const mintCap    = require('./mint_cap.js');
const fees       = require('./fees.js');
const validate   = require('./validate.js');
const probe      = require('./probe.js');

class Batch {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Setup alias to protocol changes class
        this.protocolChanges = action.protocolChanges;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|COMMAND';

        // The per-BATCH caps and cost weights (limits.js), then the tables the gas pre-check
        // prices from (fees.js), each installed with this instance as `this` and in the order
        // these fields have always been created, so the instance's own keys enumerate unchanged.
        limits.installCountCaps.call(this);
        limits.installCostWeights.call(this);
        fees.installFeeTables.call(this);

        // Counting bucket for child (dotted-TICK) ISSUE sub-commands. Deliberately not a
        // legal ACTION name, so it can never collide with an entry in actionLimits and
        // child issuance stays uncapped no matter what actions are added later.
        this.childIssueKey = 'ISSUE.CHILD';
    }
}

// Handle parsing the BATCH transaction: judge the BATCH as a whole (validate.js), record it,
// and, when it is valid, dispatch every sub-command through the loader in list order.
async function parse(params, data, error){
    let gates = await validate.resolveGates.call(this, data);
    // Clone before mutation: this raw copy is what gets stored in the batches table.
    let batch = structuredClone(data);

    let checked  = await validate.checkBatch.call(this, data, error, gates);
    let commands = checked.commands;
    error = checked.error;

    // Determine final status
    let status = (error) ? error : 'valid';
    data['STATUS'] = batch['STATUS'] = status;

    // Print status message
    getLogger().info("\t BATCH : " + data['SOURCE'] + ' : ' + data['STATUS']);

    // Create record in batches table
    await this.indexerDb.createBatch(batch);

    // Store the SOURCE in addresses list
    this.util.addAddressTicker(data['SOURCE']);

    // Create action mappings
    await this.mapper.createMappings(data);

    if(status=='valid'){
        data['SIBLING_ACTIONS'] = preParseSiblings.call(this, commands, gates.normalize);
        seedValueLedger(data, gates.limitsActive);
        let isProbe = probe.seedProbeCollectors(data);
        await dispatchSubCommands.call(this, commands, data, error, gates.normalize, isProbe);
    }

    // Probe only: the dispatch loop leaves data['STATUS'] holding the LAST sub-command's
    // verdict, so restore the BATCH's own. Without this the pre-flight would answer for
    // whichever command happened to come last - which reads as a verdict on the batch and
    // is not one. Per-sub-command verdicts are reported separately in PROBE_SUB_VERDICTS.
    if(data['FEE_PROBE'] === true) data['STATUS'] = status;
}

// Pre-parse all sibling commands so child handlers can inspect them
// (e.g. SEND verifying a paired MESSAGE for gated token transfers).
// See xchain-documentation/protocol/token-gated-content.md.
function preParseSiblings(commands, normalize){
    let siblings = [];
    for(let command of commands){
        let parts  = String(command).split('|');
        let name   = String(parts[0]).toUpperCase();
        let sibParams = parts.slice(1);
        if(normalize)
            name = this.normalizeSubAction(name, sibParams);
        siblings.push({ action: name, params: sibParams, raw: command });
    }
    return siblings;
}

// Batch-cumulative value ledger (BATCH_ISSUANCE_LIMITS).
//
// TX_OUTPUTS and the transaction's settlement values are TRANSACTION-level
// state: the dispatch loop preserves them across every sub-command, and each
// per-command check read them UNTOUCHED. Sub-command i asked "does this
// transaction carry enough to cover me?", passed, and sub-command i+1 asked the
// same question of the same untouched value, so ONE command's worth of native
// fee satisfied all N (and one COINPAY payment settled N obligations).
//
// This object is the running tally of what earlier sub-commands already spent.
// It is seeded HERE, before the dispatch loop's baseKeys snapshot, precisely so the
// field-clearing loop there treats it as transaction-level and preserves it;
// seeded after the snapshot it would be deleted before the second sub-command
// ran, which is the bug wearing a ledger. Consumers live in the SHARED
// validators (util.validateNativeCoinFee and the COINPAY/DISPENSE value reads)
// so all twelve fee-bearing handlers are covered by one change rather than
// twelve; a handler that never sees this key (any non-BATCH transaction, or a
// pre-flag-day BATCH) behaves byte-identically to before.
//
// Amounts are decimal STRINGS accumulated with bcadd at 8dp, never JS numbers.
// The three fields cover the three transaction-level values a sub-command can
// consume: the native fee output paying FEE_DESTINATION, the settlement value
// COINPAY/DISPENSE draw down, and the per-oracle fee outputs a DISPENSER pays.
// oracleFeeConsumed is keyed BY ORACLE ADDRESS, not a scalar: one batch can
// reference several oracles, and one oracle's exhausted output must not
// invalidate a sub-command paying a different one.
function seedValueLedger(data, limitsActive){
    if(limitsActive)
        data['BATCH_VALUE_LEDGER'] = {
            nativeFeeConsumed:  '0',
            coinAmountConsumed: '0',
            oracleFeeConsumed:  {}
        };
}

// Dispatch every sub-command through the loader, in list order, one ACTION_INDEX each.
async function dispatchSubCommands(commands, data, error, normalize, isProbe){
    // Snapshot the transaction-level field names. Anything a sub-action
    // adds beyond these is action-specific and must be cleared before the
    // next sub-action runs, otherwise it bleeds across commands (e.g. a
    // FILE leaves FORMAT=0 + ENCRYPTION_METHOD set, and a following
    // MESSAGE v2 then parses under FILE's v0 format (its ciphertext lands
    // in ENCRYPTION_METHOD) and is wrongly rejected).
    let baseKeys = new Set(Object.keys(data));

    let batchPosition = -1;
    for(let command of commands){
        batchPosition++;
        let { action, params } = await prepareSubCommand.call(this, command, data, baseKeys, normalize, batchPosition);

        // STRUCTURAL VM REFUSAL on the public pre-flight path (spec row 46). This is
        // what lets BATCH be pre-flighted at all without lifting it out of
        // FEE_QUOTE_DENYLIST: the batch runs for real here, minus the commit, while
        // holding the block-loop transaction mutex, so dispatching a sub-command that
        // enters the VM would hand an unauthenticated caller exactly the block-loop-
        // stalling compute primitive that denylist exists to close.
        //
        // Placed HERE, immediately above the dispatch, on the SAME `action` variable
        // processAction receives - after the uppercase and after normalizeSubAction's
        // alias rewrite. A pre-scan of the wire string (actions/index.js
        // _batchProbeForbiddenSubAction) refuses the batch earlier and more cheaply,
        // but only this one is impossible to spell around, because there is no further
        // transformation between the check and the call.
        if(isProbe && this.actions.isBatchProbeForbiddenSubAction(action)){
            data['PROBE_SUB_VERDICTS'].push({
                position: batchPosition,
                action:   action,
                status:   null,
                refused:  'VM action not dispatched on the public pre-flight'
            });
            continue;
        }

        // Probe only: clear the previous sub-command's verdict so a handler that
        // returns without recording one (a settlement leg that skips, e.g. coinpay.js
        // on an unmatched payee) reports null rather than inheriting its predecessor's
        // status. STATUS is a base key, so the field clear above never touches it.
        if(isProbe) delete data['STATUS'];

        // Process the specific ACTION commands
        await this.actions.processAction(action, params, data, error);

        if(isProbe)
            probe.recordSubVerdict.call(this, data, action, batchPosition);
    }
}

// Ready `data` for ONE sub-command; returns the canonical ACTION and the params it runs with.
async function prepareSubCommand(command, data, baseKeys, normalize, batchPosition){
    // Parse command into params
    let params = String(command).split('|');
    // Extract ACTION from params
    let action = String(params.shift()).toUpperCase();

    // Normalize the sub-action like a top-level action would be
    // (alias rewrite + legacy VERSION 0 injection) so FORMAT
    // derivation and handler dispatch below see canonical input.
    if(normalize)
        action = this.normalizeSubAction(action, params);

    // Clear action-specific fields left by the previous sub-action.
    for(let key of Object.keys(data))
        if(!baseKeys.has(key)) delete data[key];

    // Update ACTION transaction data object. FORMAT must be derived
    // from THIS command's version (params[0]) rather than left stale.
    data['ACTION']  = action;
    data['TX_DATA'] = command;
    data['FORMAT']  = this.util.getFormatVersion(params[0]);

    // Each command gets its own ACTION_INDEX.
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(data, true);

    // This subcommand's 0-based position in the BATCH's command list.
    // Every subcommand is its own ROOT action but they all share the
    // transaction's single TX_VOUT, so the position is the only
    // content-derived value that tells two same-contract EXECUTE
    // subcommands apart in the ATTEST request_id / XCALL call_id
    // preimages (src/consensus/batch_root_discriminator.js; whether it actually
    // enters a preimage is decided by that gate, not here). Set after
    // the clear above, which drops every non-base key each iteration.
    data['BATCH_POSITION'] = batchPosition;
    return { action, params };
}

// Every method a Batch instance answers, in the order the handler has always declared them,
// installed the way a class body installs its methods: non-enumerable, writable and
// configurable, so suites can stub them through the prototype and for-in stays empty. Each
// is a plain function from its part, so its name, arity and async-ness are the original's.
const METHODS = {
    normalizeSubAction:        subCommand.normalizeSubAction,
    classifyLimitAction:       subCommand.classifyLimitAction,
    probeTokenInfo:            fees.probeTokenInfo,
    subCommandTick:            subCommand.subCommandTick,
    probeTickerId:             mintCap.probeTickerId,
    maxMintsPerDistinctTick:   mintCap.maxMintsPerDistinctTick,
    nominalIssueFee:           fees.nominalIssueFee,
    nominalDurationFee:        fees.nominalDurationFee,
    nominalExecuteFee:         fees.nominalExecuteFee,
    isGasProvablyUnaffordable: fees.isGasProvablyUnaffordable,
    subCommandWeight:          subCommand.subCommandWeight,
    batchWeight:               subCommand.batchWeight,
    parse,
};
const descriptors = Object.getOwnPropertyDescriptors(METHODS);
for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
Object.defineProperties(Batch.prototype, descriptors);

module.exports = Batch;
