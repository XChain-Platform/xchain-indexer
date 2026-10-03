'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ISSUE format 5 policy detachment: `0` clears an attached list only while the
// activation is on, blank fields inherit, and effective token state reads a
// detached list as null.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../../../fixtures/mocks');
const { makeFormat0Params, makeData, buildIssue } = require('./helpers/fixture.js');
const tokenInfoMixin = require('../../../../../src/db/issues/token_info.js');
const gateRegistry   = require('../../../../../src/consensus/gate_registry');
const Utility        = require('../../../../../src/utility.js');

const GATE_KEY = 'issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH';
const POLICY_INHERITANCE_KEY = 'token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION';
const OWNER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OTHER = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

function disableDetachGate() {
    const activeAt = gateRegistry.activeAt;
    sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
        key === GATE_KEY ? false : activeAt(key, ...args));
}

async function runPolicyUpdate(allowList, blockList, source = OWNER, tokenOverrides = {}) {
    const { indexer, handler } = buildIssue();
    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({
        TICK: 'MYTOKEN', OWNER, ALLOW_LIST: 7, BLOCK_LIST: 8, ...tokenOverrides,
    }));
    indexer.indexerDb.isValidList.callsFake(async (value) => Number(value) > 0);
    const data = makeData({ FORMAT: 5, BLOCK_INDEX: 100, SOURCE: source });
    await handler.parse(['5', 'MYTOKEN', allowList, blockList, ''], data, null);
    return { data, indexer };
}

function issueRow(overrides = {}) {
    return Object.assign({
        max_supply: '1000', max_mint: '100', decimals: 0, description: 'policy token',
        lock_max_supply: null, lock_mint_supply: null, lock_mint: null,
        lock_max_mint: null, lock_description: null, lock_sleep: null,
        lock_callback: null, callback_block: null, callback_amount: null,
        mint_address_max: null, mint_start_block: null, mint_stop_block: null,
        allow_list: null, block_list: null, bridge_chains: null, min_depth: null,
        lock_bridge: null, action_index: 1, block_index: 1, tick: 'MYTOKEN',
        callback_tick: null, owner: OWNER, transfer: null, bridged: 0,
    }, overrides);
}

async function replayPolicy(rows) {
    const db = {
        util: new Utility(),
        createTicker: async () => 1,
        doQuery: async () => rows,
        getTokenSupply: async () => '0',
    };
    return tokenInfoMixin.getTokenInfo.call(db, 'MYTOKEN', 100, 100);
}

describe('ISSUE_POLICY_LIST_DETACH @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('at the flag day format 5 stores 0 while effective token state has no lists', async function () {
        const { data, indexer } = await runPolicyUpdate('0', '0');

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(indexer.indexerDb.createIssue.firstCall.args[0].ALLOW_LIST, '0');
        assert.strictEqual(indexer.indexerDb.createIssue.firstCall.args[0].BLOCK_LIST, '0');
        assert.strictEqual(indexer.indexerDb.createToken.firstCall.args[0].ALLOW_LIST, null);
        assert.strictEqual(indexer.indexerDb.createToken.firstCall.args[0].BLOCK_LIST, null);
        assert.strictEqual(indexer.indexerDb.isValidList.callCount, 0);
    });

    it('at the flag day a blank still inherits while 0 detaches the other list', async function () {
        const { data, indexer } = await runPolicyUpdate('', '0');

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(indexer.indexerDb.createToken.firstCall.args[0].ALLOW_LIST, 7);
        assert.strictEqual(indexer.indexerDb.createToken.firstCall.args[0].BLOCK_LIST, null);
    });

    it('below the flag day format 5 still rejects 0 as a bad list', async function () {
        disableDetachGate();
        const { data } = await runPolicyUpdate('0', '');

        assert.strictEqual(data.STATUS, 'invalid: ALLOW_LIST (bad list)');
    });

    it('the flag day does not admit 0 on format 0', async function () {
        const { indexer, handler } = buildIssue();
        const data = makeData({ FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(makeFormat0Params({ TICK: 'MYTOKEN', ALLOW_LIST: '0' }), data, null);

        assert.strictEqual(data.STATUS, 'invalid: ALLOW_LIST (bad list)');
    });

    it('the owner check still rejects a format 5 detach from another address', async function () {
        const { data } = await runPolicyUpdate('0', '', OTHER);
        assert.strictEqual(data.STATUS, 'invalid: issued by another address');
    });
});

describe('ISSUE_POLICY_LIST_DETACH registry and replay @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('registers the sentinel on mainnet, the v0.21.3 heights on testnet and genesis on regtest', function () {
        assert.deepStrictEqual(gateRegistry.get(GATE_KEY), {
            mainnet: 9999999999,
            'BTC:testnet': 154939, 'LTC:testnet': 4905307, 'DOGE:testnet': 67960786,
            testnet: 9999999999, regtest: 0,
        });
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'mainnet', 'BTC', 9999999998, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', 'BTC', 154938, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', 'BTC', 154939, null), true);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('replays a stored 0 as null and leaves it detached across blank updates', async function () {
        const info = await replayPolicy([
            issueRow({ allow_list: 7, block_list: 8, action_index: 1 }),
            issueRow({ allow_list: 0, block_list: null, action_index: 2 }),
            issueRow({ allow_list: null, block_list: '', action_index: 3 }),
        ]);

        assert.strictEqual(info.ALLOW_LIST, null);
        assert.strictEqual(info.BLOCK_LIST, 8);
    });

    it('reads a detach-only update as policy-free for bridged-token validation', async function () {
        const activeAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === POLICY_INHERITANCE_KEY ? false : activeAt(key, ...args));

        const { data } = await runPolicyUpdate('0', '', OWNER, { BRIDGED: 1 });
        assert.strictEqual(data.STATUS, 'valid');
    });
});
