/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const gateRegistry = require('../../../../../src/consensus/gate_registry');
const { policyHash } = require('../../../../../src/consensus/bridge_settle/policy_membership.js');
const { buildTokenPolicyRpc, bridgePolicyHash } = require('../../../../../src/api/rpc/token_policy.js');

const PRODUCER_GATE = 'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION';
const ORIGIN_BLOCK = 100;
const SNAPSHOT_BLOCK = 500;
const ALLOW_MEMBERS = ['allowA', 'allowB'];
const BLOCK_MEMBERS = ['blockA'];

function buildRpc({ tokenInfo, sharedLists = [], mirrors = {}, roots = {}, coin = 'BTC' }){
    const db = {
        getTokenInfo: sinon.stub().resolves(tokenInfo),
        getListAtBlock: sinon.stub().callsFake(async index =>
            index === tokenInfo.ALLOW_LIST ? ALLOW_MEMBERS : BLOCK_MEMBERS),
        isTickSleepingAtBlock: sinon.stub().resolves(true),
        doQuery: sinon.stub().resolves(sharedLists),
        getListRootIndex: sinon.stub().callsFake(async index => roots[index] || index),
        getListShareMirrorByIndex: sinon.stub().callsFake(async root => mirrors[root] || null)
    };
    const indexer = {
        config: { NETWORK: 'regtest', COIN: coin },
        indexerDb: { apiView: sinon.stub().returns(db) }
    };
    return { db, rpc: buildTokenPolicyRpc({ indexer }) };
}

describe('gettokenpolicy shared-list references', function () {
    afterEach(function () { sinon.restore(); });

    it('answers a home-shared list and a pre-existing mirror by reference after activation', async function () {
        sinon.stub(gateRegistry, 'activeAt').returns(true);
        const { db, rpc } = buildRpc({
            tokenInfo: { ALLOW_LIST: 15, BLOCK_LIST: 40, BRIDGED: 0 },
            roots: { 15: 12 },
            sharedLists: [{ root_index: 12, share_action_index: 20, share_block: 80 }],
            mirrors: {
                40: { action_index: 40, home_chain: 'DOGE', home_list_index: 2701, block_index: 90 }
            }
        });

        const result = await rpc.gettokenpolicy({
            tick: 'FUFU', origin_block: ORIGIN_BLOCK, snapshot_block: SNAPSHOT_BLOCK
        });

        assert.deepStrictEqual(result, {
            allow_list: 'BTC:12',
            block_list: 'DOGE:2701',
            sleeping: true,
            policy_hash: policyHash(ALLOW_MEMBERS, BLOCK_MEMBERS, true,
                { allow: 'BTC:12', block: 'DOGE:2701' }),
            bridged: false,
            origin_block: ORIGIN_BLOCK,
            allow_list_ref: 'BTC:12',
            block_list_ref: 'DOGE:2701'
        });
        assert.strictEqual(result.policy_hash,
            bridgePolicyHash(ALLOW_MEMBERS, BLOCK_MEMBERS, true,
                { allow: 'BTC:12', block: 'DOGE:2701' }));
        sinon.assert.calledOnceWithExactly(gateRegistry.activeAt,
            PRODUCER_GATE, 'regtest', 'BTC', SNAPSHOT_BLOCK, null);
        sinon.assert.calledWithExactly(db.getListRootIndex.firstCall, 15, 16, ORIGIN_BLOCK);
        sinon.assert.calledWithExactly(db.getListRootIndex.secondCall, 40, 16, ORIGIN_BLOCK);
    });

    it('labels a list shared on a DOGE indexer with DOGE, not BTC', async function () {
        sinon.stub(gateRegistry, 'activeAt').returns(true);
        const { rpc } = buildRpc({
            coin: 'DOGE',
            tokenInfo: { ALLOW_LIST: null, BLOCK_LIST: 15, BRIDGED: 1 },
            roots: { 15: 12 },
            sharedLists: [{ root_index: 12, share_action_index: 20, share_block: 80 }]
        });

        const result = await rpc.gettokenpolicy({
            tick: 'FUFU', origin_block: ORIGIN_BLOCK, snapshot_block: SNAPSHOT_BLOCK
        });

        assert.strictEqual(result.block_list, 'DOGE:12');
        assert.strictEqual(result.block_list_ref, 'DOGE:12');
        sinon.assert.calledOnceWithExactly(gateRegistry.activeAt,
            PRODUCER_GATE, 'regtest', 'BTC', SNAPSHOT_BLOCK, null);
    });

    it('keeps an after-origin share and an unshared local list as full membership', async function () {
        sinon.stub(gateRegistry, 'activeAt').returns(true);
        const { rpc } = buildRpc({
            tokenInfo: { ALLOW_LIST: 15, BLOCK_LIST: 41, BRIDGED: 1 },
            roots: { 15: 12 },
            sharedLists: [{ root_index: 12, share_action_index: 20, share_block: 101 }]
        });

        const result = await rpc.gettokenpolicy({
            tick: 'FUFU', origin_block: ORIGIN_BLOCK, snapshot_block: SNAPSHOT_BLOCK
        });

        assert.deepStrictEqual(result, {
            allow_list: ALLOW_MEMBERS,
            block_list: BLOCK_MEMBERS,
            sleeping: true,
            policy_hash: policyHash(ALLOW_MEMBERS, BLOCK_MEMBERS, true,
                { allow: null, block: null }),
            bridged: true,
            origin_block: ORIGIN_BLOCK
        });
        assert.ok(!Object.prototype.hasOwnProperty.call(result, 'allow_list_ref'));
        assert.ok(!Object.prototype.hasOwnProperty.call(result, 'block_list_ref'));
    });

    it('keeps the legacy response unchanged at an unarmed snapshot block', async function () {
        sinon.stub(gateRegistry, 'activeAt').returns(false);
        const { db, rpc } = buildRpc({
            tokenInfo: { ALLOW_LIST: 15, BLOCK_LIST: 41, BRIDGED: 1 },
            roots: { 15: 12 },
            sharedLists: [{ root_index: 12, share_action_index: 20, share_block: 80 }]
        });
        const expected = {
            allow_list: ALLOW_MEMBERS,
            block_list: BLOCK_MEMBERS,
            sleeping: true,
            policy_hash: policyHash(ALLOW_MEMBERS, BLOCK_MEMBERS, true),
            bridged: true,
            origin_block: ORIGIN_BLOCK
        };

        const result = await rpc.gettokenpolicy({
            tick: 'FUFU', origin_block: ORIGIN_BLOCK, snapshot_block: SNAPSHOT_BLOCK
        });

        assert.strictEqual(JSON.stringify(result), JSON.stringify(expected));
        sinon.assert.notCalled(db.doQuery);
        sinon.assert.notCalled(db.getListRootIndex);
        sinon.assert.notCalled(db.getListShareMirrorByIndex);
    });

    it('keeps the legacy response unchanged when snapshot_block is omitted', async function () {
        const gate = sinon.spy(gateRegistry, 'activeAt');
        const { db, rpc } = buildRpc({
            tokenInfo: { ALLOW_LIST: 15, BLOCK_LIST: null, BRIDGED: 1 },
            roots: { 15: 12 },
            sharedLists: [{ root_index: 12, share_action_index: 20, share_block: 80 }]
        });
        const expected = {
            allow_list: ALLOW_MEMBERS,
            block_list: null,
            sleeping: true,
            policy_hash: policyHash(ALLOW_MEMBERS, null, true),
            bridged: true,
            origin_block: ORIGIN_BLOCK
        };

        const result = await rpc.gettokenpolicy({ tick: 'FUFU', origin_block: ORIGIN_BLOCK });

        assert.strictEqual(JSON.stringify(result), JSON.stringify(expected));
        sinon.assert.notCalled(gate);
        sinon.assert.notCalled(db.doQuery);
        sinon.assert.notCalled(db.getListRootIndex);
        sinon.assert.notCalled(db.getListShareMirrorByIndex);
    });
});
