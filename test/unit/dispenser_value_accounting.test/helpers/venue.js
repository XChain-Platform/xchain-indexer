/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/dispenser_value_accounting.test/helpers/venue.js
 *
 * The DISPENSE venue every dispenser_value_accounting suite runs the real
 * handler in: a stub indexer db, the BATCH_ISSUANCE_LIMITS gate, and readers for
 * the rows the handler wrote.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility  = require('../../../../src/utility.js');
const Dispense = require('../../../../src/actions/dispense.js');

const DISPENSER_ADDRESS = 'dispenserAddress11111111111';
const BUYER             = 'buyerAddress';

// What batch.js seeds, verbatim, once BATCH_ISSUANCE_LIMITS is enabled.
function seedLedger(){
    return { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} };
}

function makeUtil(){
    let util = new Utility();
    util.config['COIN']              = 'BTC';
    util.config['NETWORK']           = 'regtest';
    util.config['FEE_TOLERANCE_MIN'] = '0.95';
    return util;
}

// A dispenser giving 10 tokens per fill at 1 coin a fill, with escrow for exactly
// ONE fill. The one-fill cap is what makes attribution observable: each settlement
// draws exactly the fill price, never the whole payment.
function dispenserRow(extra){
    return Object.assign({
        ACTION_INDEX:   500,
        SOURCE:         'dispenserOwner',
        GET_ADDRESS:    DISPENSER_ADDRESS,
        GET_COIN:       'BTC',
        GET_TICK:       'BTC',
        GET_AMOUNT:     '1.00000000',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'TOKEN',
        GIVE_AMOUNT:    '10',
        GIVE_REMAINING: '10',
        GIVE_OWNERSHIP: 0,
        FIAT:           null,
        FIAT_AMOUNT:    null,
        ORACLE_ADDRESS: null,
        ALLOW_LIST:     null,
        BLOCK_LIST:     null
    }, extra || {});
}

/**
 * A DISPENSE venue.
 *
 * opts.dispenserIds : the action_indexes findMatchingDispensers returns. More than
 *                     one is the several-dispensers-behind-one-address shape (row 19).
 * opts.limits       : false pins BATCH_ISSUANCE_LIMITS OFF (the replay case).
 * opts.dispenser    : dispenser-row overrides applied to every id.
 */
function makeVenue(opts){
    opts = opts || {};
    let util  = makeUtil();
    let calls = { created: [], gateQueries: [] };
    // The ledger write must not depend on the balance-writing plumbing.
    util.processTransactionLedgerChanges = async () => {};
    let ids = opts.dispenserIds || [500];
    let indexerDb = {
        findMatchingDispensers:      async () => ids.slice(),
        // A FRESH row per id, so nothing but the value accounting can stop a later
        // dispenser in the loop (the persisted escrow decrement is out of scope here).
        getDispenserInfo:            async (coin, action_index) =>
                                        dispenserRow(Object.assign({ ACTION_INDEX: action_index },
                                                                   opts.dispenser || {})),
        getClosedDispenserAtAddress: async () => null,
        deleteActionIndex:           async () => {},
        createActionIndex:           async () => 42,
        getTokenInfo:                async () => null,
        getList:                     async () => [],
        createDispense:              async (d) => { calls.created.push(Object.assign({}, d)); },
        updateBalances:              async () => {},
        getDispenserDispenseCount:   async () => 0,
        getOraclePricesInTimeRange:  async () => opts.oraclePrices || [],
        getPricesInTimeRange:        async () => opts.snapshots    || []
    };
    let actions = {
        config:          util.config,
        decoderDb:       {},
        indexerDb:       indexerDb,
        util:            util,
        mapper:          { createMappings: async () => {} },
        protocolChanges: {
            isEnabled: async (name) => {
                calls.gateQueries.push(name);
                if(name === 'BATCH_ISSUANCE_LIMITS')
                    return opts.limits !== false;
                return true;
            }
        },
        processAction: async () => {}
    };
    return { dispense: new Dispense(actions), calls: calls, util: util, actions: actions };
}

function dispenseData(extra){
    return Object.assign({
        ACTION_INDEX:     1,
        BLOCK_INDEX:      100,
        BLOCK_TIME:       1000,
        TX_INDEX:         7,
        COIN:             'BTC',
        SOURCE:           BUYER,
        COIN_AMOUNT:      '3.00000000',
        COIN_DESTINATION: DISPENSER_ADDRESS
    }, extra || {});
}

function statuses(calls){
    return calls.created.map(d => d['STATUS']);
}

function getAmounts(calls){
    return calls.created.map(d => String(d['GET_AMOUNT']));
}

module.exports = {
    DISPENSER_ADDRESS, BUYER, seedLedger, makeUtil, dispenserRow, makeVenue,
    dispenseData, statuses, getAmounts
};
