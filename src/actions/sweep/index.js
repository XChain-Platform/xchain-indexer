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
 * XChain Platform Action - SWEEP
 * 
 * This action transfers all `TICK` balances and/or ownerships to a `DESTINATION` address.
 * 
 * PARAMS:
 * - VERSION     - Format Version
 * - DESTINATION - address where `token` shall be swept
 * - BALANCES    - Sweep `TICK` balances to DESTINATION (default=1)
 * - OWNERSHIPS  - Sweep `TICK` ownerships to DESTINATION (default=1)
 * - ORDERS      - Cancel open ORDERs and credit escrow to DESTINATION (default=0)
 * - SWAPS       - Cancel open SWAPs and credit escrow to DESTINATION (default=0)
 * - DISPENSERS  - Close open DISPENSERs and credit escrow to DESTINATION (default=0)
 * - MEMO        - Optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

// The handler's phases, grouped by concern and installed onto Sweep.prototype below
const validatePart        = require('./validate.js');
const feesPart            = require('./fees.js');
const controllerGuardPart = require('./controller_guard.js');
const settlePart          = require('./settle.js');

const { getLogger } = require('../../observability/index.js');
class Sweep {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO';
    }

    // Handle parsing the SWEEP transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // let str = '0|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|1|1|1|1|1|memo';
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string to number so comparisons below are mathematical, not lexical.
        if(!error)
            data = this.util.setNumberFormats(data);

        // Resolve a compacted ^<id> DESTINATION to its canonical address (sweep/validate.js)
        error = await this.resolveSweepDestination(data, error);

        // SOURCE's balances, ownerships and escrows, the fees object and the guard gas context
        let state = await this.loadSweepState(data);

        // FORMAT validations and the per-flag defaults (sweep/validate.js)
        error = this.validateSweepFormat(data, error);

        // Clone the raw data for storage in the sweeps table.
        let sweep = Object.assign({}, data);

        // SOURCE sleep and MEMO checks (sweep/validate.js)
        error = await this.validateSweepGeneral(data, error);

        // Price the FEE, then validate and reserve its payment (sweep/fees.js)
        await this.priceSweepFee(data, state);
        error = await this.validateSweepFeePayment(data, state, error);

        // Controller guards on the swept balances, then ownerships (sweep/controller_guard.js)
        error = await this.guardSweptBalances(data, state, error);
        error = await this.guardSweptOwnerships(data, state, error);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = sweep['STATUS'] = status;

        // Print status message
        getLogger().info("\t SWEEP : " + sweep['DESTINATION'] + ' : '+ sweep['STATUS']);

        // Create record in sweeps table
        await this.indexerDb.createSweep(sweep);

        // If this was a valid transaction, then mint any actual supply (sweep/settle.js)
        if(status=='valid')
            await this.settleSweep(data, sweep, state);
    }

    // Load what the SWEEP reads before it validates, in this order on every SWEEP, valid or
    // not: SOURCE's balances, preferences, token ownerships and escrows, the fees object, the
    // per-run ticker memo and the controller-guard gas context. parse() and the parts under
    // sweep/ read the returned state and update its balances, guardFee and escrow partition.
    async loadSweepState(data){
        // Get source address balances, preferences, and token ownerships
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let ownerships  = await this.indexerDb.getAddressOwnerships(data['SOURCE']);
        let escrowed    = await this.indexerDb.getAddressEscrows(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Per-run memo for tick_id -> ticker resolution. SWEEP resolves the same set of held
        // tick_ids twice (the BALANCES controller-guard loop below and the settlement balance-
        // transfer loop), one getTicker query per ticker each pass. tick_id -> ticker is
        // immutable within a block, so cache the first lookup and reuse it across both passes:
        // O(distinct held ticks) queries instead of 2x. Read-only, so it changes only how many
        // queries run, never which ticker a tick_id resolves to.
        let tickerCache = {};
        let resolveTicker = async (tickId) => {
            let key = Number(tickId);
            if(tickerCache[key] === undefined)
                tickerCache[key] = await this.indexerDb.getTicker(key);
            return tickerCache[key];
        };

        // Controller-bound token gas context. Any swept balance of a token whose `transfer` class is
        // bound to a controller runs that contract's `guard` before the sweep settles; SOURCE pays
        // the (bounded) cumulative guard gas in GAS. Loaded once; the per-tick guard loop below
        // reserves against the live `balances` view and any deny fails the whole SWEEP. Pre-flag-day
        // the guard is a strict no-op.
        let gasTick  = this.config['GAS'];
        let gasInfo  = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let guardFee = 0;

        return { balances, preferences, ownerships, escrowed, fees, resolveTicker, gasTick, gasInfo, guardFee };
    }
}

// Install the phase methods from sweep/ NON-ENUMERABLE, the shape the class body they came
// from produced: parse() reaches them as this.<method>, suites can stub them through
// Sweep.prototype, and for-in over a handler stays empty. Same install as collect.js and
// db/index.js use for their parts.
for(const part of [validatePart, feesPart, controllerGuardPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Sweep.prototype, descriptors);
}

module.exports = Sweep;