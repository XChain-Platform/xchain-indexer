// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, makeOrderContext } = require('./order.test/helpers/order_context.js');
const { createDispenserHarness } = require('./dispenser.test/helpers/dispenser_harness.js');

const Swap = require('../../../../src/actions/swap/index.js');

function installTokenInfoProxies(indexer, tokenRows) {
    const reads = new Set();
    const tokens = new Map(tokenRows.map((overrides) => {
        const token = createTokenInfo(overrides);
        delete token.SUPPLY;
        const proxy = new Proxy(token, {
            get(target, property, receiver) {
                reads.add(String(property));
                return Reflect.get(target, property, receiver);
            },
            has(target, property) {
                reads.add(String(property));
                return Reflect.has(target, property);
            },
        });
        return [overrides.TICK, proxy];
    }));

    indexer.indexerDb.getTokenInfo.resetBehavior();
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) => tokens.get(tick) || null);
    return reads;
}

function assertSupplyUnread(action, data, reads) {
    assert.strictEqual(data['STATUS'], 'valid', `${action} create must be valid`);
    assert.ok(reads.has('TICK_ID') || reads.has('DECIMALS'), `${action} must read token info through the proxy`);
    assert.ok(!reads.has('SUPPLY'), `${action} must not read SUPPLY`);
}

describe('DEX create token info reads @regression @tier2', function () {
    it('ORDER does not read SUPPLY', async function () {
        const { indexer, order } = makeOrderContext();
        const reads = installTokenInfoProxies(indexer, [
            { TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0 },
            { TICK: 'PEPECASH', TICK_ID: 20, DECIMALS: 0 },
            { TICK: indexer.config['GAS'], TICK_ID: 99, DECIMALS: 8 },
        ]);
        indexer.indexerDb.getAddressBalances.resolves({ 10: '100', 20: '999999', 99: '100' });
        const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
        const data = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

        await order.parse(params, data, false);

        assertSupplyUnread('ORDER', data, reads);
    });

    it('SWAP does not read SUPPLY', async function () {
        const indexer = createMockIndexer();
        const actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        const swap = new Swap(actionsCtx);
        indexer.util.resetLists();
        const reads = installTokenInfoProxies(indexer, [
            { TICK: 'GIVE', TICK_ID: 1, DECIMALS: 0 },
            { TICK: 'GET', TICK_ID: 2, DECIMALS: 0 },
            { TICK: indexer.config['GAS'], TICK_ID: 99, DECIMALS: 8 },
        ]);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000', 99: '1000' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
        const params = ['0', 'BTC', 'GIVE', '10', '', 'BTC', 'GET', '5', '', '', '9999999999', '', '', ''];
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });

        await swap.parse(params, data, null);

        assertSupplyUnread('SWAP', data, reads);
    });

    it('DISPENSER does not read SUPPLY', async function () {
        const { indexer, dispenser } = createDispenserHarness();
        const reads = installTokenInfoProxies(indexer, [
            { TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null },
            { TICK: 'PAY', TICK_ID: 20, DECIMALS: 0 },
            { TICK: indexer.config['GAS'], TICK_ID: 99, DECIMALS: 8 },
        ]);
        indexer.indexerDb.getAddressBalances.resolves({ 10: '1000', 99: '1000' });
        const params = makeParams(`0|BTC|JDOG|1||10|BTC|PAY|1|${OWNER_ADDR}||||${EXPIRATION}|||`);
        const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

        await dispenser.parse(params, data, false);

        assertSupplyUnread('DISPENSER', data, reads);
    });
});
