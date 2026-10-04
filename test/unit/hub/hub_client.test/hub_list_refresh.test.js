// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const sinon = require('sinon');
const { createHubListRefresher } = require('../../../../src/hub/hub_client/hub_list_refresh.js');

describe('createHubListRefresher()', function(){
    it('merges two valid hubs in order', async function(){
        let merge = sinon.stub().resolves();
        let refresher = createHubListRefresher({
            fetchList: async () => ({ hubs: [
                { api_url: 'https://first.example.com' },
                { api_url: 'http://second.example.com:8080' }
            ] }),
            merge,
            warn: sinon.stub()
        });

        assert.deepStrictEqual(await refresher.refresh(), { outcome: 'merged', count: 2 });
        assert.strictEqual(merge.calledOnce, true);
        assert.deepStrictEqual(merge.firstCall.args[0], [
            'https://first.example.com',
            'http://second.example.com:8080'
        ]);
    });

    it('drops a refused address before the merge', async function(){
        let merge = sinon.stub().resolves();
        let refresher = createHubListRefresher({
            fetchList: async () => ({ hubs: [
                { api_url: 'https://hub.example.com/private' },
                { api_url: 'https://accepted.example.com' }
            ] }),
            merge,
            warn: sinon.stub()
        });

        assert.deepStrictEqual(await refresher.refresh(), { outcome: 'merged', count: 1 });
        assert.deepStrictEqual(merge.firstCall.args[0], ['https://accepted.example.com']);
    });

    it('merges no empty or malformed result and warns once across three refreshes', async function(){
        let fetchList = sinon.stub();
        fetchList.onCall(0).resolves({ hubs: [] });
        fetchList.onCall(1).resolves({ hubs: 'not-an-array' });
        fetchList.onCall(2).resolves(null);
        let merge = sinon.stub();
        let warn = sinon.stub();
        let refresher = createHubListRefresher({ fetchList, merge, warn });

        for(let i = 0; i < 3; i++){
            assert.deepStrictEqual(await refresher.refresh(), { outcome: 'empty', count: 0 });
        }

        assert.strictEqual(merge.called, false);
        assert.strictEqual(warn.calledOnce, true);
    });

    it('merges no unknown-method result under either error field and warns once', async function(){
        let fetchList = sinon.stub();
        fetchList.onCall(0).rejects(Object.assign(new Error('unsupported'), { rpcCode: -32601 }));
        fetchList.onCall(1).rejects(Object.assign(new Error('unsupported'), { code: -32601 }));
        fetchList.onCall(2).rejects(Object.assign(new Error('unsupported'), { rpcCode: -32601 }));
        let merge = sinon.stub();
        let warn = sinon.stub();
        let refresher = createHubListRefresher({ fetchList, merge, warn });

        for(let i = 0; i < 3; i++){
            assert.deepStrictEqual(await refresher.refresh(), { outcome: 'unknown-method', count: 0 });
        }

        assert.strictEqual(merge.called, false);
        assert.strictEqual(warn.calledOnce, true);
    });

    it('warns on every socket error', async function(){
        let fetchList = sinon.stub().rejects(new Error('socket closed'));
        let warn = sinon.stub();
        let refresher = createHubListRefresher({ fetchList, merge: sinon.stub(), warn });

        for(let i = 0; i < 3; i++){
            assert.deepStrictEqual(await refresher.refresh(), { outcome: 'error', count: 0 });
        }

        assert.strictEqual(warn.callCount, 3);
    });

    it('resolves with an error outcome when merge throws', async function(){
        let failure = new Error('merge failed');
        let warn = sinon.stub();
        let refresher = createHubListRefresher({
            fetchList: async () => ({ hubs: [{ api_url: 'https://hub.example.com' }] }),
            merge: () => { throw failure; },
            warn
        });

        assert.deepStrictEqual(await refresher.refresh(), { outcome: 'error', count: 0 });
        assert.strictEqual(warn.calledOnce, true);
        assert.strictEqual(warn.firstCall.args[1], failure);
    });
});
