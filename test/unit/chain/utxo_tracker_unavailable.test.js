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
// UtxoTracker.call() outage tagging: a call the tracker never answered carries
// code UTXO_TRACKER_UNAVAILABLE so the DISPENSER freshness caller halts and
// retries the block; a JSON-RPC error body is the tracker's answer and stays
// untagged, so it keeps reading as not fresh.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert      = require('assert');
const sinon       = require('sinon');
const UtxoTracker = require('../../../src/chain/utxo_tracker.js');
const { rethrowIfInfraFault } = require('../../../src/consensus/fault_guard.js');

const TAG = 'UTXO_TRACKER_UNAVAILABLE';

// Build a fake fetch that resolves with the given JSON body.
function makeFetch(body, opts){
    opts = opts || {};
    return sinon.stub().resolves({
        ok:     opts.ok !== undefined ? opts.ok : true,
        status: opts.status || 200,
        json:   async () => body
    });
}

// Match a rejection that carries the tag and a message matching `re`.
const tagged = (re) => (e) => e.code === TAG && re.test(e.message);

describe('UtxoTracker call() unavailable tagging @regression @tier1', function(){
    let origFetch;
    beforeEach(function(){ origFetch = global.fetch; });
    afterEach(function(){ global.fetch = origFetch; sinon.restore(); });

    it('tags an unconfigured client', async function(){
        await assert.rejects(() => new UtxoTracker().call('get_first_seen', {}), tagged(/not configured/));
    });

    it('tags a rejected fetch and keeps the cause', async function(){
        let cause = new Error('ECONNREFUSED');
        global.fetch = sinon.stub().rejects(cause);
        await assert.rejects(() => new UtxoTracker('localhost', 3005).call('get_first_seen', {}),
            (e) => tagged(/ECONNREFUSED/)(e) && e.cause === cause);
    });

    it('tags a non-2xx response (503 busy, 500)', async function(){
        for(const status of [503, 500]){
            global.fetch = makeFetch({}, { ok: false, status: status });
            await assert.rejects(() => new UtxoTracker('localhost', 3005).call('get_first_seen', {}),
                tagged(new RegExp('HTTP error: ' + status)));
        }
    });

    it('tags an unreadable body', async function(){
        global.fetch = sinon.stub().resolves({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
        await assert.rejects(() => new UtxoTracker('localhost', 3005).call('get_first_seen', {}), tagged(/unreadable response/));
    });

    it('does NOT tag a JSON-RPC error answer', async function(){
        global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Invalid address' } });
        await assert.rejects(() => new UtxoTracker('localhost', 3005).call('get_first_seen', {}),
            (e) => /RPC error/.test(e.message) && e.code === undefined);
    });

    it('does NOT tag the strictShape violation', async function(){
        global.fetch = makeFetch({ jsonrpc: '2.0', id: 1, result: { height: '100' } });
        await assert.rejects(() => new UtxoTracker('localhost', 3005).getFirstSeen('a', { strictShape: true }),
            (e) => /shape violation/.test(e.message) && e.code === undefined);
    });

    it('rethrowIfInfraFault halts on the tag and lets an RPC error answer through', function(){
        const outage = Object.assign(new Error('UTXO tracker HTTP error: 503'), { code: TAG });
        assert.throws(() => rethrowIfInfraFault(outage), (e) => e === outage);
        rethrowIfInfraFault(new Error('UTXO tracker RPC error: {"code":-32603}'));
    });
});
