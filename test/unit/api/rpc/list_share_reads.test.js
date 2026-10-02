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
const crypto = require('crypto');
const sinon = require('sinon');

const observability = require('../../../../src/observability/index.js');
const { buildListShareRpc } = require('../../../../src/api/rpc/list_share.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');
const { readApiSource } = require('../../../helpers/api_source.js');

function sha256(value){
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseApiSet(source, name){
    const match = source.match(new RegExp('const\\s+' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)'));
    assert.ok(match, name + ' not found in src/api.js');
    return Array.from(match[1].matchAll(/['"]([a-z0-9_]+)['"]/gi), hit => hit[1]);
}

describe('JSON-RPC list share reads @regression @tier1', function(){
    afterEach(function(){ sinon.restore(); });

    it('reads membership at the requested pre-edit block and hashes the documented string', async function(){
        const beforeEdit = [
            'bcrt1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpvxat9t',
            'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC'
        ];
        const afterEdit = beforeEdit.concat('n4SYP6TJyNMuY7xKx4L6B9J7jMRNQ6jGxL');
        const view = recordingView({
            getListRootIndex: listIndex => listIndex,
            getListType: 2,
            getListAtBlock: (listIndex, block) => block <= 40 ? beforeEdit : afterEdit,
            getListMeta: null
        });
        const rpc = buildListShareRpc({ indexer: fakeIndexer({ view }) });

        assert.deepStrictEqual(await rpc.getlistat({ list_index: 17, block: 40 }), {
            type: 2,
            members: beforeEdit,
            hash: sha256('MEMBERS|2|' + beforeEdit.join('|')),
            name: null,
            description: null,
            meta_hash: ''
        });
        assert.deepStrictEqual(view.calls, [
            ['getListRootIndex', 17, null, 40],
            ['getListType', 17, 40],
            ['getListAtBlock', 17, 40],
            ['getListMeta', 17, 40]
        ]);

        const current = await rpc.getlistat({ list_index: 17, block: 41 });
        assert.deepStrictEqual(current.members, afterEdit);
        assert.notStrictEqual(current.hash, sha256('MEMBERS|2|' + beforeEdit.join('|')));
    });

    it('changes metadata without changing root membership after a later rename', async function(){
        const members = ['bc1q-list-member', '1LegacyListMember'];
        const membershipHash = sha256('MEMBERS|2|' + members.join('|'));
        const view = recordingView({
            getListRootIndex: listIndex => listIndex === 117 ? 100 : listIndex,
            getListType: 2,
            getListAtBlock: members,
            getListMeta: (rootIndex, block) => block < 60
                ? { name: 'Initial name', description: null }
                : { name: 'Renamed list', description: 'New label only' }
        });
        const rpc = buildListShareRpc({ indexer: fakeIndexer({ view }) });

        const before = await rpc.getlistat({ list_index: 117, block: 59 });
        const after = await rpc.getlistat({ list_index: 117, block: 60 });

        assert.strictEqual(before.name, 'Initial name');
        assert.strictEqual(before.description, null);
        assert.strictEqual(after.name, 'Renamed list');
        assert.strictEqual(after.description, 'New label only');
        assert.strictEqual(before.meta_hash, sha256('LISTMETA|Initial name|'));
        assert.strictEqual(after.meta_hash, sha256('LISTMETA|Renamed list|New label only'));
        assert.deepStrictEqual(after.members, before.members);
        assert.strictEqual(before.hash, membershipHash);
        assert.strictEqual(after.hash, membershipHash);
        assert.deepStrictEqual(view.calls, [
            ['getListRootIndex', 117, null, 59],
            ['getListType', 100, 59],
            ['getListAtBlock', 100, 59],
            ['getListMeta', 100, 59],
            ['getListRootIndex', 117, null, 60],
            ['getListType', 100, 60],
            ['getListAtBlock', 100, 60],
            ['getListMeta', 100, 60]
        ]);
    });

    it('hashes an empty membership as MEMBERS|0 and reports tick-list type 1', async function(){
        const view = recordingView({
            getListRootIndex: listIndex => listIndex,
            getListType: listIndex => listIndex === 2 ? 1 : 2,
            getListAtBlock: listIndex => listIndex === 2 ? ['DOGE', 'PEPE'] : [],
            getListMeta: null
        });
        const rpc = buildListShareRpc({ indexer: fakeIndexer({ view }) });

        assert.deepStrictEqual(await rpc.getlistat({ list_index: 1, block: 0 }), {
            type: 2,
            members: [],
            hash: sha256('MEMBERS|0'),
            name: null,
            description: null,
            meta_hash: ''
        });
        assert.deepStrictEqual(await rpc.getlistat({ list_index: 2, block: 8 }), {
            type: 1,
            members: ['BTC:DOGE', 'BTC:PEPE'],
            hash: sha256('MEMBERS|2|BTC:DOGE|BTC:PEPE'),
            name: null,
            description: null,
            meta_hash: ''
        });
    });

    it('returns distinct errors for unknown, rejected, and malformed list reads', async function(){
        const view = recordingView({
            getListRootIndex: listIndex => listIndex,
            getListType: listIndex => listIndex === 404 ? false : 2,
            getListAtBlock: listIndex => listIndex === 9 ? null : [],
            getListMeta: null
        });
        const rpc = buildListShareRpc({ indexer: fakeIndexer({ view }) });

        assert.deepStrictEqual(await rpc.getlistat({ list_index: 404, block: 1 }), { error: 'list not found' });
        assert.deepStrictEqual(await rpc.getlistat({ list_index: 9, block: 1 }), { error: 'list reference rejected' });
        for(const list_index of [0, -1, 1.5, '01', 'x', null, Number.MAX_SAFE_INTEGER + 1])
            assert.deepStrictEqual(await rpc.getlistat({ list_index, block: 1 }),
                { error: 'list_index must be a positive integer' });
        for(const block of [-1, 1.5, '01', 'x', null, Number.MAX_SAFE_INTEGER + 1])
            assert.deepStrictEqual(await rpc.getlistat({ list_index: 1, block }),
                { error: 'block must be a non-negative integer' });
        assert.deepStrictEqual(await rpc.getlistat(null), { error: 'list_index must be a positive integer' });
    });

    it('lists a shared root with its owner after a transfer', async function(){
        const view = {
            doQuery: sinon.stub().callsFake(async (sql, args) => {
                if(/FROM lists l/.test(sql)){
                    assert.deepStrictEqual(args, []);
                    return [{ root_index: 100, share_block: 20, share_action_index: 200 }];
                }
                assert.match(sql, /FROM list_transfers lt/);
                assert.deepStrictEqual(args, [100]);
                return [{ address: 'transferred-owner' }];
            }),
            getListMeta: sinon.stub().resolves({ name: 'Shared watchlist', description: null }),
            getListSource: sinon.stub().rejects(new Error('transfer owner must win'))
        };
        const indexerDb = { apiView: sinon.stub().returns(view) };
        const rpc = buildListShareRpc({ indexer: fakeIndexer({ indexerDb }) });

        assert.deepStrictEqual(await rpc.getsharedlists({ network: 'regtest' }), [{
            root_index: 100,
            name: 'Shared watchlist',
            owner: 'transferred-owner',
            share_block: 20,
            share_action_index: 200
        }]);
        assert.strictEqual(view.doQuery.callCount, 2);
        assert.ok(view.getListMeta.calledOnceWithExactly(100, null));
        assert.ok(indexerDb.apiView.calledOnceWithExactly());
    });

    it('rejects a foreign network before opening the database view', async function(){
        const indexerDb = { apiView: sinon.stub() };
        const rpc = buildListShareRpc({ indexer: fakeIndexer({ indexerDb }) });

        assert.deepStrictEqual(await rpc.getsharedlists({ network: 'mainnet' }),
            { error: 'network does not match this indexer' });
        assert.deepStrictEqual(await rpc.getsharedlists({}),
            { error: 'network does not match this indexer' });
        assert.ok(indexerDb.apiView.notCalled);
    });

    it('refuses without a database and logs lookup failures', async function(){
        const log = sinon.stub(observability.getLogger(), 'error');
        const notReady = buildListShareRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        const throwingDb = { apiView: () => { throw new Error('database fault'); } };
        const throwing = buildListShareRpc({ indexer: fakeIndexer({ indexerDb: throwingDb }) });

        assert.deepStrictEqual(await notReady.getlistat({ list_index: 1, block: 1 }),
            { error: 'indexer database not ready' });
        assert.deepStrictEqual(await notReady.getsharedlists({ network: 'regtest' }),
            { error: 'indexer database not ready' });
        assert.deepStrictEqual(await throwing.getlistat({ list_index: 1, block: 1 }),
            { error: 'failed to look up list' });
        assert.deepStrictEqual(await throwing.getsharedlists({ network: 'regtest' }),
            { error: 'failed to look up shared lists' });
        assert.strictEqual(log.callCount, 2);
    });

    it('keeps both reads outside every authenticated API gate', function(){
        const source = readApiSource();
        for(const setName of ['WRITE_METHODS', 'GATED_EXEC_METHODS', 'FEDERATION_READ_METHODS']){
            const methods = parseApiSet(source, setName);
            assert.ok(!methods.includes('getlistat'), setName + ' must not gate getlistat');
            assert.ok(!methods.includes('getsharedlists'), setName + ' must not gate getsharedlists');
        }
    });
});
