'use strict';

// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');

const {
    SOURCE, TICK, CONTRACT_ADDRESS, makeToken, makeWithdrawContext,
} = require('./withdraw_context.js');

const DENY_CONTROLLER  = 11;
const ALLOW_CONTROLLER = 12;

function bindingForClass(binding, actionClass){
    if(!binding || (binding.actionClass !== actionClass && binding.actionClass !== 'all'))
        return null;
    return binding;
}

function installProtocolGate(actionsCtx, custodyGuard){
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        return name === 'CONTROLLER_CUSTODY_GUARD' ? custodyGuard : true;
    });
}

function installGuardRunner(actionsCtx, guardCalls, verdicts){
    actionsCtx.actionExecute = {
        runControllerGuard: sinon.stub().callsFake(async (request) => {
            guardCalls.push(request);
            return verdicts[request.controllerIndex];
        }),
    };
}

function installTokenAndBalanceLookups(indexer, balances){
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) => {
        if(tick === TICK) return makeToken();
        if(tick === indexer.config['GAS'])
            return makeToken({ TICK: tick, TICK_ID: 2, DECIMALS: 8 });
        return null;
    });
    indexer.indexerDb.getAddressBalances.callsFake(async (address) => {
        return Object.assign({}, balances[address] || {});
    });
}

function installControllerLookups(indexer, opts){
    indexer.indexerDb.getAddressId.callsFake(async (address) => {
        if(address === SOURCE) return 42;
        if(address === CONTRACT_ADDRESS) return 43;
        return null;
    });
    indexer.indexerDb.getEffectiveTokenControllerForGuard.callsFake(async (_tickId, actionClass) => {
        return bindingForClass(opts.tokenBinding, actionClass);
    });
    indexer.indexerDb.getEffectiveAddressControllerForGuard.callsFake(async (addressId, actionClass) => {
        if(addressId !== 42) return null;
        return bindingForClass(opts.addressBinding, actionClass);
    });
}

function makeWithdrawCustodyContext(opts = {}){
    const { indexer, actionsCtx, handler } = makeWithdrawContext();
    const guardCalls = [];
    const verdicts = Object.assign({
        [DENY_CONTROLLER]:  { allow: false, reason: 'policy denied', gasBilled: 0 },
        [ALLOW_CONTROLLER]: { allow: true, gasBilled: 1000 },
    }, opts.verdicts || {});
    const balances = Object.assign({
        [CONTRACT_ADDRESS]: { 1: '1000' },
        [SOURCE]:           { 2: '100' },
    }, opts.balances || {});

    installProtocolGate(actionsCtx, opts.custodyGuard === undefined ? false : opts.custodyGuard);
    installGuardRunner(actionsCtx, guardCalls, verdicts);
    if(!indexer.indexerDb.config) indexer.indexerDb.config = indexer.config;
    installTokenAndBalanceLookups(indexer, balances);
    installControllerLookups(indexer, opts);

    const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');
    return { indexer, actionsCtx, handler, guardCalls, ledgerSpy };
}

module.exports = { DENY_CONTROLLER, ALLOW_CONTROLLER, makeWithdrawCustodyContext };
