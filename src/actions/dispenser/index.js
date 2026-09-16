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
 * XChain Platform Action - DISPENSER
 * 
 * This action creates a dispenser (vending machine) to dispense `TICK` when triggered
 * 
 * PARAMS:
 * VERSION                - Format Version
 * GIVE_COIN              - `COIN` name (BTC, LTC, DOGE, etc)
 * GIVE_TICK              - Ticker name or Ticker ID
 * GIVE_AMOUNT            - Quantity of `GIVE_TICK` to `DISPENSE` when triggered (empty when GIVE_OWNERSHIP=1)
 * GIVE_OWNERSHIP         - 1 = dispense GIVE_TICK ownership (single-shot); GIVE_AMOUNT / GIVE_ESCROW must be empty (default 0)
 * GIVE_ESCROW            - Quantity of `GIVE_TICK` to escrow in dispenser (empty when GIVE_OWNERSHIP=1)
 * GET_COIN               - `COIN` name (BTC, LTC, DOGE, etc)
 * GET_TICK               - Ticker name or Ticker ID
 * GET_AMOUNT             - Quantity of `GET_COIN` or `GET_TICK` required to `DISPENSE`
 * GET_ADDRESS             - Address for dispenser to operate on (default=`SOURCE`)
 * FIAT_CODE              - Code for `FIAT` currency your dispenser is priced in (USD, JPY, GPB, etc.)
 * FIAT_AMOUNT            - Amount of `FIAT` currency required to trigger a `DISPENSE` (ignored when ORACLE_ADDRESS is set)
 * ORACLE_ADDRESS         - Optional address of a user oracle (PRICE v1) that prices the dispensed token in `FIAT_CODE`
 * EXPIRATION             - Timestamp of when dispenser should close, in Unix time
 * ALLOW_LIST             - `ACTION_INDEX` of a `LIST` of addresses allowed to trigger dispenser       
 * BLOCK_LIST             - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to trigger a dispenser 
 * MEMO                   - An optional memo to include                                                
 * DISPENSER_ACTION_INDEX - `ACTION_INDEX` of existing `DISPENSER`                                     
 * 
 * FORMATS:
 * - 0 = Create Dispenser
 * - 1 = Cancel Dispenser
 * - 2 = Edit Dispenser
 *
 ********************************************************************/

// This handler's phases live in dispenser/, grouped by concern and installed onto
// Dispenser.prototype below. parse() calls them in the order they ran inline, threading
// one ctx object that carries every local the single long scope holds between phases.
//
// The GET_ADDRESS permission gate and the owner-authority gate stay HERE on purpose, as
// methods of this class rather than parts: bin/check-flagday-deploy.sh greps this exact
// path for the literal dispenser_freshness_activation, and
// test/unit/escrow_journal_writer.test.js reads this path for the owner-authority
// comparison that forces the DISPENSER family to resolve through the dispenser row.
// Both are content pins on this FILE, not on the handler, so moving either block out
// would retire a guard silently rather than fail.
const gateRegistry = require('../../consensus/gate_registry');

const contextPart = require('./context.js');
const validatePart = require('./validate.js');
const validateFormatPart = require('./validate_format.js');
const feesPart = require('./fees.js');
const controllerGuardPart = require('./controller_guard.js');
const settlePart = require('./settle.js');

const { getLogger } = require('../../observability/index.js');
class Dispenser {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions     = action;
        this.config      = action.config;
        this.decoderDb   = action.decoderDb;
        this.indexerDb   = action.indexerDb;
        this.util        = action.util;
        this.mapper      = action.mapper;
        this.utxoTracker = action.utxoTracker || null;
        
        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';
        this.formats[1] = 'VERSION|DISPENSER_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';

        // Define array of supported list types (1=Tick, 2=Address)
        this.listTypes = [2];
    }

    // Report a below-gate fresh-address verdict that rests on a null get_first_seen
    // from a tracker whose own view is lagging, halted, or of unknown lag.
    //
    // Deliberately a SECOND call rather than switching the verdict itself onto
    // get_first_seen_status: that verdict is replay-frozen (it decides DISPENSER
    // validity already baked into hashed history), so the call feeding it must not
    // change method. A tracker deployed before the sibling existed answers -32601,
    // and the caller's catch turns any throw into isFresh=false, i.e. a rejection
    // of a create the chain already accepted. This call cannot reach that path: it
    // runs after the verdict is fixed, swallows everything, and is skipped entirely
    // when the client has no getFirstSeenStatus.
    //
    // Log-only, in the shape of dispenserDivergenceMetrics: no DB write, no
    // influence on validation, never an input to block hashing.
    async logStaleFreshness(data){
        try {
            if(!this.utxoTracker || typeof this.utxoTracker.getFirstSeenStatus !== 'function')
                return;
            let status = await this.utxoTracker.getFirstSeenStatus(data['GET_ADDRESS']);
            let sync   = (status && status.sync) || null;
            // Unknown lag is never treated as zero, and an absent sync surface is
            // itself untrustworthy: both mean the tracker could not vouch for the
            // null answer the verdict above rests on.
            if(sync && sync.synced === true && sync.halted !== true && sync.lag !== null)
                return;
            getLogger().info('DISPENSER_FRESHNESS_STALE : addr=' + data['GET_ADDRESS'] +
                        ' block=' + data['BLOCK_INDEX'] +
                        ' synced=' + (sync ? sync.synced : 'unknown') +
                        ' halted=' + (sync ? (sync.halted === true) : 'unknown') +
                        ' lag=' + (sync ? sync.lag : 'unknown') +
                        ' tracker_height=' + (sync ? sync.tracker_height : 'unknown'));
        } catch (e) {
            // Diagnostic only: a failure here must never disturb the frozen verdict.
        }
    }

    // Handle parsing the DISPENSER transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // let str    = "0|BTC|JDOG|1|10|BTC||0.01|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating JDOG dispensers at 0.01 BTC each";
        // let str    = "1|1234|Closing JDOG Dispenser";
        // let str    = "2|1234|100||||Refilling with 100";
        // let str    = "2|1234|||9876|5432|Updating allow/block lists";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known

        // Every local the pass threads, built by dispenser/context.js: format resolution,
        // param parsing, the dispenser and token lookups, balances, preferences and fees.
        let ctx = await this.resolveDispenserContext(params, data, error);

        await this.validateTickCoinFiat(ctx);
        await this.validateAmountFields(ctx);
        await this.validateAddressAndExpirationFields(ctx);
        await this.validateOraclePrecondition(ctx);
        await this.validateOracleUsageFee(ctx);
        await this.validateGeneralRules(ctx);
        await this.checkGetAddressPermission(ctx);
        await this.checkDispenserAuthority(ctx);
        await this.validateDispenserEditRules(ctx);
        await this.validateExpirationListsAndEscrow(ctx);
        await this.priceDispenserFees(ctx);
        await this.runControllerGuard(ctx);
        await this.settleDispenser(ctx);
    }

    // Kept in this entry rather than in a dispenser/ part because it carries this path's flag-day
    // marker: bin/check-flagday-deploy.sh greps the deployed src/actions/dispenser/index.js for
    // the literal dispenser_freshness_activation, and a missing path reads UNKNOWN rather
    // than failing, so moving this block would retire that row silently.
    async checkGetAddressPermission(ctx){
    let { data, error, format } = ctx;

        // Verify SOURCE may open a dispenser on GET_ADDRESS.
        // SOURCE == GET_ADDRESS: always allowed (owner self-opening).
        // Otherwise: GET_ADDRESS must either set DISPENSER_PREFERENCE=2 (anyone),
        // be a fresh address (no prior on-chain activity as of BLOCK_INDEX − 1),
        // or (DISPENSER_ORIGIN_STANDING) SOURCE must be the address's established
        // origin: the SOURCE of a prior VALID dispenser create on GET_ADDRESS.
        // Freshness is spent after the first create; origin standing is what
        // lets the same main address keep opening dispensers on its sub-address.
        if(!error && format==0 && data['GET_ADDRESS']!=data['SOURCE']){
            let getPrefs = await this.indexerDb.getAddressPreferences(data['GET_ADDRESS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(Number(getPrefs['DISPENSER_PREFERENCE']) !== 2){
                let isFresh = false;
                // Freshness causality flag-day (see the dispenser_freshness_activation row in src/protocol_changes/).
                // At/after the gate the verdict derives from
                // deterministic indexer-local chain state (no XChain activity strictly
                // before BLOCK_INDEX); the external utxo-tracker is NEVER consulted. Below
                // the gate the legacy tracker HTTP path runs byte-identically so historical
                // replay is preserved.
                if(gateRegistry.activeAt('dispenser_freshness_activation.DISPENSER_FRESHNESS_ACTIVATION', this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null)){
                    isFresh = !(await this.indexerDb.hasXChainActivityBefore(data['GET_ADDRESS'], data['BLOCK_INDEX']));
                } else if(this.utxoTracker && this.utxoTracker.enabled){
                    try {
                        // Oracle-shape flag-day (the dispenser_freshness_shape_activation row).
                        // At/after it a non-null get_first_seen answer with no numeric height
                        // throws and the catch below reads as not fresh; below it that answer
                        // is the legacy null, which grants the exception. Passed in because
                        // the gate is keyed on this chain's block_index and the client has no
                        // block context.
                        let strictShape = gateRegistry.activeAt(
                            'dispenser_freshness_shape_activation.DISPENSER_FRESHNESS_SHAPE_ACTIVATION',
                            this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null);
                        let firstSeen = await this.utxoTracker.getFirstSeen(data['GET_ADDRESS'], { strictShape: strictShape });
                        isFresh = !firstSeen || firstSeen.height >= data['BLOCK_INDEX'];
                        // get_first_seen answers null both for "never appeared on chain"
                        // and for "this tracker has not indexed that far yet, or is halted
                        // on an unwinding reorg", so a fresh-by-null verdict computed
                        // against a lagging tracker is a false positive that leaves no
                        // trace (the catch below only fires on a hard RPC failure, not on
                        // a stale-but-successful answer). Record when that happened.
                        // Log-only, and never an input to isFresh.
                        if(isFresh && !firstSeen)
                            await this.logStaleFreshness(data);
                    } catch (err) {
                        getLogger().info('WARNING: utxo-tracker get_first_seen failed for ' + data['GET_ADDRESS'] + ': ', err);
                    }
                }
                let hasStanding = false;
                if(!isFresh && await this.actions.protocolChanges.isEnabled('DISPENSER_ORIGIN_STANDING', data['BLOCK_INDEX']))
                    hasStanding = await this.indexerDb.hasDispenserOriginStanding(data['SOURCE'], data['GET_ADDRESS'], data['ACTION_INDEX']);
                if(!isFresh && !hasStanding)
                    error = 'invalid: GET_ADDRESS (dispenser not permitted)';
            }
        }

    ctx.data = data;
    ctx.error = error;
    }

    // Kept in this file for the same reason: test/unit/escrow_journal_writer.test.js reads
    // src/actions/dispenser/index.js and asserts the owner-authority comparison below is still
    // what it was, because that gate is why the whole DISPENSER family must resolve its
    // escrow attribution through the dispenser row rather than the escrow row's address.
    async checkDispenserAuthority(ctx){
    let { data, error, format, dispenserInfo } = ctx;

        // Validate DISPENSER_ACTION_INDEX is valid dispenser
        if(!error && (format==1 || format==2) && !dispenserInfo)
            error = 'invalid: DISPENSER_ACTION_INDEX (unknown)';

        // Verify SOURCE address is owner of the DISPENSER_ACTION_INDEX dispenser
        if(!error && format!=0 && data['SOURCE']!=dispenserInfo['SOURCE'] && data['SOURCE']!=dispenserInfo['GET_ADDRESS'])
            error = 'invalid: SOURCE (not owner)';

        // Validate DISPENSER_ACTION_INDEX is valid dispenser with a status of open
        if(!error && format!=0 && dispenserInfo['DISPENSER_STATUS']!='open')
            error = 'invalid: DISPENSER_ACTION_INDEX (dispenser not open)';

    ctx.data = data;
    ctx.error = error;
    }
}

// Install the phase methods from dispenser/ NON-ENUMERABLE, the shape the class body they
// came from produced: parse() reaches them as this.<method>, suites can stub them through
// Dispenser.prototype, and for-in over a handler stays empty. Same install as
// dispenser_close.js and db/index.js use.
for(const part of [contextPart, validatePart, validateFormatPart, feesPart, controllerGuardPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Dispenser.prototype, descriptors);
}

module.exports = Dispenser;
