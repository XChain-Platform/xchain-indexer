'use strict';

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
 ********************************************************************/

const sinon = require('sinon');
const { createMockIndexer } = require('../../../../../fixtures/mocks');
const Deposit = require('../../../../../../src/actions/deposit.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CONTRACT_INDEX = '7';
const CUSTODY = 'C:BTC:7';
const DENY_CONTROLLER = 11;
const ALLOW_CONTROLLER = 12;

function bindingFor(binding, expectedId, actualId, actionClass) {
    if(!binding || actualId !== expectedId)
        return null;
    return binding.actionClass === actionClass || binding.actionClass === 'all' ? binding : null;
}

function configureDepositDb(indexer, opts) {
    const db = indexer.indexerDb;
    const gasTick = indexer.config['GAS'];
    const balances = opts.balances || { [SOURCE]: { 1: '1000', 2: '100' } };
    if(!db.config)
        db.config = indexer.config;
    db.getContract = sinon.stub().resolves({ contract_index: Number(CONTRACT_INDEX), status_id: 1 });
    db.getStatusString = sinon.stub().resolves('valid');
    db.createDeposit = sinon.stub().resolves();
    db.getTokenInfo.callsFake(async (tick) => {
        if(tick === 'TEST') return { TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 };
        if(tick === gasTick) return { TICK: gasTick, TICK_ID: 2, DECIMALS: 8 };
        return null;
    });
    db.getTickerId.callsFake(async (tick) => tick === 'TEST' ? 1 : (tick === gasTick ? 2 : null));
    db.getAddressBalances.callsFake(async (address) => ({ ...(balances[address] || {}) }));
    db.getAddressId.callsFake(async (address) => address === SOURCE ? 42 : (address === CUSTODY ? 43 : null));
    db.getEffectiveTokenControllerForGuard.callsFake(async (tickId, actionClass) =>
        bindingFor(opts.tokenBinding, 1, tickId, actionClass));
    db.getEffectiveAddressControllerForGuard.callsFake(async (addressId, actionClass) =>
        bindingFor(opts.addressBinding, 42, addressId, actionClass));
}

function makeActionsCtx(indexer, opts, guardCalls) {
    const verdicts = {
        [DENY_CONTROLLER]: { allow: false, reason: 'policy denied', gasBilled: 0 },
        [ALLOW_CONTROLLER]: { allow: true, gasBilled: 1000 },
        ...(opts.verdicts || {}),
    };
    return {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().callsFake(async (name) =>
                name === 'CONTROLLER_CUSTODY_GUARD' ? (opts.custodyGuard ?? false) : true),
        },
        actionExecute: {
            runControllerGuard: sinon.stub().callsFake(async (request) => {
                guardCalls.push(request);
                return verdicts[request.controllerIndex];
            }),
        },
    };
}

function makeDepositCustodyContext(opts = {}) {
    const indexer = createMockIndexer();
    const guardCalls = [];
    configureDepositDb(indexer, opts);
    const actionsCtx = makeActionsCtx(indexer, opts, guardCalls);
    const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');
    const handler = new Deposit(actionsCtx);
    return { indexer, actionsCtx, handler, guardCalls, ledgerSpy };
}

module.exports = {
    SOURCE,
    CONTRACT_INDEX,
    CUSTODY,
    DENY_CONTROLLER,
    ALLOW_CONTROLLER,
    makeDepositCustodyContext,
};
