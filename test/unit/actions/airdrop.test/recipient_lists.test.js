// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// AIRDROP recipient allow/block list membership: which recipients survive the
// gates, the order credits are built in, duplicate recipients, and one read of
// each list per recipient loop. Part of the AIRDROP suite; see
// ../airdrop.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { freshAirdrop } = require('./helpers/airdrop_fixtures.js');

let indexer, actionsCtx, handler;

const ADDR_A = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
const ADDR_B = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';
const ADDR_C = 'mr5CBpzjw2QLYwCZEBYMxbrPcS7pwLSDwF';

const ALLOW_LIST_INDEX = 50;
const BLOCK_LIST_INDEX = 51;
const RECIPIENT_LIST_INDEX = 1;

// Wires an ADDRESS-type recipient list plus optional allow/block lists, each
// served from its own action index, and returns a spy over the ledger-changes
// call so a test can read the credits array the recipient loop produced.
function setupLists({ recipients, allowList = null, blockList = null }) {
    const tokenInfo = createTokenInfo({
        TICK: 'TEST',
        TICK_ID: 1,
        DECIMALS: 0,
        SUPPLY: '100000',
        ALLOW_LIST: (allowList === null) ? null : ALLOW_LIST_INDEX,
        BLOCK_LIST: (blockList === null) ? null : BLOCK_LIST_INDEX,
    });
    indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
    indexer.indexerDb.getListType.resolves(2);
    indexer.indexerDb.getList.callsFake((actionIndex) => {
        if(Number(actionIndex) === ALLOW_LIST_INDEX) return Promise.resolve(allowList || []);
        if(Number(actionIndex) === BLOCK_LIST_INDEX) return Promise.resolve(blockList || []);
        return Promise.resolve(recipients);
    });
    indexer.indexerDb.getAddressBalances.resolves({ 1: '100000' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.isActionAllowed.resolves(true);
    return sinon.spy(indexer.util, 'processTransactionLedgerChanges');
}

// The credits array also carries fee credits; only the airdropped TICK's rows
// reflect the recipient loop.
function creditedAddresses(spy) {
    assert.ok(spy.called, 'processTransactionLedgerChanges should be called');
    const credits = spy.lastCall.args[2] || [];
    return credits.filter(c => c[0] === 'TEST').map(c => c[2]);
}

async function runAirdrop() {
    const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
    await handler.parse(['0', 'TEST', '10', String(RECIPIENT_LIST_INDEX), null], data, null);
    return data;
}

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    // the recipient allow/block gates are Set membership probes, not array
    // scans. These pin the observable behaviour the conversion must not move: which
    // addresses survive the gates, and the order the surviving credits are built in
    // (recipient iteration order, never the list's own order).
    describe('recipient allow/block list membership', function () {
        it('ALLOW_LIST credits only listed recipients', async function () {
            const spy = setupLists({ recipients: [ADDR_A, ADDR_B, ADDR_C], allowList: [ADDR_B, ADDR_C] });

            const data = await runAirdrop();

            assert.strictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(creditedAddresses(spy), [ADDR_B, ADDR_C]);
        });

        it('BLOCK_LIST drops listed recipients and keeps the rest', async function () {
            const spy = setupLists({ recipients: [ADDR_A, ADDR_B, ADDR_C], blockList: [ADDR_B] });

            const data = await runAirdrop();

            assert.strictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(creditedAddresses(spy), [ADDR_A, ADDR_C]);
        });

        it('ALLOW_LIST and BLOCK_LIST together: the block list still wins', async function () {
            const spy = setupLists({
                recipients: [ADDR_A, ADDR_B, ADDR_C],
                allowList:  [ADDR_A, ADDR_B, ADDR_C],
                blockList:  [ADDR_C],
            });

            const data = await runAirdrop();

            assert.deepStrictEqual(creditedAddresses(spy), [ADDR_A, ADDR_B]);
        });

        it('an EMPTY ALLOW_LIST approves nobody', async function () {
            const spy = setupLists({ recipients: [ADDR_A, ADDR_B], allowList: [] });

            const data = await runAirdrop();

            assert.strictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(creditedAddresses(spy), []);
        });
    });
});

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('recipient allow/block list membership', function () {
        it('credit order follows recipient order, not allow-list order', async function () {
            // The allow list is deliberately the reverse of the recipient order: a
            // set-backed membership test must leave the credits in recipient order.
            const spy = setupLists({
                recipients: [ADDR_A, ADDR_B, ADDR_C],
                allowList:  [ADDR_C, ADDR_B, ADDR_A],
            });

            await runAirdrop();

            assert.deepStrictEqual(creditedAddresses(spy), [ADDR_A, ADDR_B, ADDR_C]);
        });
    });

    describe('recipient allow/block list membership', function () {
        it('duplicate recipients are credited once, in first-seen order', async function () {
            const spy = setupLists({ recipients: [ADDR_B, ADDR_A, ADDR_B], allowList: [ADDR_A, ADDR_B] });

            await runAirdrop();

            assert.deepStrictEqual(creditedAddresses(spy), [ADDR_B, ADDR_A]);
        });

        it('each list is fetched once for the whole recipient loop', async function () {
            setupLists({
                recipients: [ADDR_A, ADDR_B, ADDR_C],
                allowList:  [ADDR_A, ADDR_B, ADDR_C],
                blockList:  [],
            });

            await runAirdrop();

            const allowCalls = indexer.indexerDb.getList.getCalls().filter(c => Number(c.args[0]) === ALLOW_LIST_INDEX);
            const blockCalls = indexer.indexerDb.getList.getCalls().filter(c => Number(c.args[0]) === BLOCK_LIST_INDEX);
            assert.strictEqual(allowCalls.length, 1, 'ALLOW_LIST should be read once, not per recipient');
            assert.strictEqual(blockCalls.length, 1, 'BLOCK_LIST should be read once, not per recipient');
        });
    });
});
