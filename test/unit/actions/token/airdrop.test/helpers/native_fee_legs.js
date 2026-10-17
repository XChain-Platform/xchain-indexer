// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon = require('sinon');
const Utility = require('../../../../../../src/utility.js');
const Airdrop = require('../../../../../../src/actions/airdrop/index.js');
const {
    createMockDb,
    createBaseData,
    createTokenInfo,
} = require('../../../../../fixtures/mocks');

const FEE_DESTINATION = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const RECIPIENT = '1BitcoinEaterAddressDontSendf59kuE';

function nativeFeeAirdrop(opts = {}) {
    const coin = opts.coin || 'BTC';
    const enabledFlags = new Set(opts.enabledFlags || ['UNIFIED_FEES']);
    const baseConfig = new Utility().config;
    const config = Object.assign({}, baseConfig, {
        COIN: coin,
        NETWORK: 'mainnet',
        ADDRESS: Object.assign({}, baseConfig['ADDRESS'], { FEE_DESTINATION }),
        FEE_TOLERANCE_MIN: '0.95',
        FEE_TOLERANCE_MAX: '1.10',
        ORACLE_MAX_PRICE_AGE_SECONDS: 1800,
    });

    const util = new Utility(config);
    const decoderDb = createMockDb();
    const indexerDb = createMockDb();
    const mapper = { createMappings: sinon.stub().resolves() };
    const protocolChanges = {
        isDefined: sinon.stub().callsFake(name => enabledFlags.has(name)),
        isEnabled: sinon.stub().callsFake(async name => enabledFlags.has(name)),
    };
    const actionsCtx = {
        config,
        util,
        mapper,
        decoderDb,
        indexerDb,
        protocolChanges,
        processAction: sinon.stub().resolves(),
    };
    const indexer = { config, util, mapper, decoderDb, indexerDb, protocolChanges };
    const tokenInfo = createTokenInfo({
        TICK: 'TEST',
        TICK_ID: 1,
        DECIMALS: 0,
        SUPPLY: '1000000',
    });
    const gasInfo = createTokenInfo({
        TICK: config['GAS'],
        TICK_ID: 9,
        DECIMALS: 8,
        SUPPLY: '1000000',
    });

    indexerDb.getTokenInfo.callsFake(async tick => {
        if(tick === 'TEST') return tokenInfo;
        if(tick === config['GAS']) return gasInfo;
        return null;
    });
    indexerDb.getTickerId.withArgs(config['GAS']).resolves(gasInfo['TICK_ID']);
    indexerDb.getListType.resolves(2);
    indexerDb.getList.resolves([RECIPIENT]);
    indexerDb.getAddressBalances.resolves({ 1: '1000000', 9: '1000000' });
    indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexerDb.isActionAllowed.resolves(true);

    const prices = {
        'XCHAIN/USD': '1.00000000',
        [`${coin}/USD`]: '0.10000000',
    };
    indexerDb.getLatestPrice = sinon.stub().callsFake(async pair => {
        if(!(pair in prices) || prices[pair] === null) return null;
        return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
    });

    const data = createBaseData({
        ACTION: 'AIRDROP',
        FORMAT: 2,
        NETWORK: 'mainnet',
        COIN: coin,
        SOURCE: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
        COIN_DESTINATION: RECIPIENT,
        TX_OUTPUTS: [{ vout: 1000001, address: FEE_DESTINATION, value: opts.nativeFeeValue }],
    });

    util.resetLists();
    return { indexer, actionsCtx, handler: new Airdrop(actionsCtx), data };
}

module.exports = { nativeFeeAirdrop };
