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
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const { buildRpcController } = require('../../../../src/api/rpc/index.js');
const { buildListShareMirrorRpc } = require('../../../../src/api/rpc/list_share/list_share_mirror.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');
const { readApiSource } = require('../../../helpers/api_source.js');

function parseApiSet(source, name){
    const match = source.match(new RegExp('const\\s+' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)'));
    assert.ok(match, name + ' not found in src/api.js');
    return Array.from(match[1].matchAll(/['"]([a-z0-9_]+)['"]/gi), hit => hit[1]);
}

describe('getsharedlist JSON-RPC read', function(){
    afterEach(function(){ sinon.restore(); });

    it('is registered in the shared RPC method table and dispatches to this family', async function(){
        const view = recordingView({ getListShareMirror: null });
        const controller = buildRpcController({ indexer: fakeIndexer({ view }) });

        assert.strictEqual(typeof controller.getsharedlist, 'function');
        assert.deepStrictEqual(await controller.getsharedlist({ home_chain: 'LTC', list_index: 23 }),
            { error: 'no mirror of LTC list 23 on this chain' });
        assert.deepStrictEqual(view.calls, [['getListShareMirror', 'LTC', 23]]);
    });

    it('returns a foreign mirror at its applied sequence and latest local membership', async function(){
        const mirrorView = recordingView({
            getListSnapshotAtSeq: { origin_block: '75' }
        });
        const view = recordingView({
            getListShareMirror: { action_index: '44' },
            countAppliedListShareVersions: 3,
            getLatestBlockIndex: 120,
            getList: ['zebra', 'Alpha', 'apple']
        });
        view.mirrorDb = sinon.stub().returns(mirrorView);
        const indexerDb = { apiView: sinon.stub().returns(view) };
        const rpc = buildListShareMirrorRpc({
            indexer: fakeIndexer({ indexerDb, config: { COIN: 'BTC', NETWORK: 'testnet' } })
        });

        assert.deepStrictEqual(await rpc.getsharedlist({ home_chain: 'DOGE', list_index: 9 }), {
            home_chain: 'DOGE',
            home_list_index: 9,
            local_list_index: 44,
            seq: 3,
            origin_block: 75,
            members: ['Alpha', 'apple', 'zebra']
        });
        assert.ok(indexerDb.apiView.calledOnceWithExactly());
        assert.deepStrictEqual(view.calls, [
            ['getListShareMirror', 'DOGE', 9],
            ['countAppliedListShareVersions', 'DOGE', 9],
            ['getLatestBlockIndex'],
            ['getList', 44, 120]
        ]);
        assert.ok(view.mirrorDb.calledOnceWithExactly());
        assert.deepStrictEqual(mirrorView.calls, [
            ['getListSnapshotAtSeq', 'testnet', 'DOGE', 9, 3]
        ]);
    });

    it('returns a shared home-chain list without mirror metadata', async function(){
        const view = recordingView({
            doQuery: [{ shared: 1 }],
            getLatestBlockIndex: 88,
            getList: ['second', 'First']
        });
        const rpc = buildListShareMirrorRpc({
            indexer: fakeIndexer({ view, config: { COIN: 'LTC' } })
        });

        assert.deepStrictEqual(await rpc.getsharedlist({ home_chain: 'LTC', list_index: '12' }), {
            home_chain: 'LTC',
            home_list_index: 12,
            local_list_index: 12,
            seq: null,
            origin_block: null,
            members: ['First', 'second']
        });
        assert.deepStrictEqual(view.calls.map(call => call[0]), [
            'doQuery', 'getLatestBlockIndex', 'getList'
        ]);
        assert.deepStrictEqual(view.calls[2], ['getList', 12, 88]);
    });

    it('rejects an unshared home-chain list', async function(){
        const view = recordingView({ doQuery: [] });
        const rpc = buildListShareMirrorRpc({
            indexer: fakeIndexer({ view, config: { COIN: 'DOGE' } })
        });

        assert.deepStrictEqual(await rpc.getsharedlist({ home_chain: 'DOGE', list_index: 5 }),
            { error: 'list is not shared' });
        assert.deepStrictEqual(view.calls.map(call => call[0]), ['doQuery']);
    });

    it('reports an unknown foreign home-chain pair', async function(){
        const view = recordingView({ getListShareMirror: null });
        const rpc = buildListShareMirrorRpc({ indexer: fakeIndexer({ view }) });

        assert.deepStrictEqual(await rpc.getsharedlist({ home_chain: 'LTC', list_index: 404 }),
            { error: 'no mirror of LTC list 404 on this chain' });
        assert.deepStrictEqual(view.calls, [['getListShareMirror', 'LTC', 404]]);
    });

    it('returns null origin_block when the applied mirror snapshot row is absent', async function(){
        const mirrorView = recordingView({ getListSnapshotAtSeq: null });
        const view = recordingView({
            getListShareMirror: { action_index: 6 },
            countAppliedListShareVersions: 1,
            getLatestBlockIndex: 20,
            getList: []
        });
        view.mirrorDb = () => mirrorView;
        const rpc = buildListShareMirrorRpc({ indexer: fakeIndexer({ view }) });

        const result = await rpc.getsharedlist({ home_chain: 'LTC', list_index: 2 });
        assert.strictEqual(result.origin_block, null);
        assert.deepStrictEqual(result.members, []);
    });

    it('rejects bad parameters before opening the database view', async function(){
        const indexerDb = { apiView: sinon.stub() };
        const rpc = buildListShareMirrorRpc({ indexer: fakeIndexer({ indexerDb }) });
        const homeError = { error: 'home_chain must be BTC, LTC or DOGE' };
        const indexError = { error: 'list_index must be a positive integer' };

        for(const params of [null, {}, { home_chain: 'btc', list_index: 1 },
            { home_chain: 'ETH', list_index: 1 }])
            assert.deepStrictEqual(await rpc.getsharedlist(params), homeError);
        for(const list_index of [0, -1, 1.5, '01', 'x', null, Number.MAX_SAFE_INTEGER + 1])
            assert.deepStrictEqual(await rpc.getsharedlist({ home_chain: 'BTC', list_index }), indexError);
        assert.ok(indexerDb.apiView.notCalled);
    });

    it('keeps the read outside every authenticated API gate', function(){
        const source = readApiSource();
        for(const setName of ['WRITE_METHODS', 'FEDERATION_READ_METHODS', 'GATED_EXEC_METHODS'])
            assert.ok(!parseApiSet(source, setName).includes('getsharedlist'),
                setName + ' must not gate getsharedlist');
    });
});

require('./list_share/list_share_meta_answer.test.js');
require('./list_share/list_share_reads.test.js');
require('./list_share/list_share_tick_members.test.js');
