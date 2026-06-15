// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.
//
// Direct-hub-DB call-presence barrier (_waitForDirectCallPresence).
//
// Regression guard for the live/replay fork: in single-host / direct-hub-DB mode
// the HubDbSync call barrier is skipped, so the indexer must independently ensure a
// freshly relayed cross_chain_calls row has landed before the cross-chain-call pass
// reads the table — otherwise a live node injects an XEXEC/callback a block later
// than a replaying node, shifting its action-index counter and forking the ledger.
// These tests pin the barrier's three exits: wall-clock gate (steady state), the
// coverage fast-path, and the bounded no-freeze timeout.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert         = require('assert');
const sinon          = require('sinon');
const XChainIndexer  = require('../../src/XChainIndexer.js');

const NOW_S = () => Math.floor(Date.now() / 1000);

// Build a minimal `this` context for the prototype method: only the fields it
// reads (hubDb, callPresenceTimeoutMs, util.sleep). doQuery is a sinon stub so we
// can assert how many times (and whether) the table was polled.
function ctx(opts){
    opts = opts || {};
    const doQuery = sinon.stub().callsFake(async () => opts.rows || [{ ts: null }]);
    return {
        hubDb: opts.noHubDb ? null : { doQuery },
        callPresenceTimeoutMs: opts.timeoutMs != null ? opts.timeoutMs : 10000,
        util: { sleep: (ms) => new Promise(r => setTimeout(r, ms)) },
        _doQuery: doQuery
    };
}

const run = (self, blockTime) =>
    XChainIndexer.prototype._waitForDirectCallPresence.call(self, blockTime);

describe('XChainIndexer._waitForDirectCallPresence (direct-hub-DB call barrier)', function(){

    afterEach(() => sinon.restore());

    it('returns immediately for a past/replay block without querying the hub DB', async function(){
        const self = ctx();
        await run(self, NOW_S() - 5000);                 // block_time well in the past
        assert.strictEqual(self._doQuery.called, false); // wall-clock gate → no query
    });

    it('returns immediately at the live tip (block_time at/just behind wall-clock)', async function(){
        const self = ctx();
        await run(self, NOW_S() - 1);
        assert.strictEqual(self._doQuery.called, false);
    });

    it('proceeds at once when the hub DB holds no finalized calls (nothing to wait on)', async function(){
        // Future block so the wall-clock gate does NOT short-circuit; forces the query path.
        const self = ctx({ rows: [{ ts: null }] });
        await run(self, NOW_S() + 600);
        assert.strictEqual(self._doQuery.calledOnce, true);
    });

    it('proceeds at once when a finalized row already covers this block (ts >= block_time)', async function(){
        const bt = NOW_S() + 600;
        const self = ctx({ rows: [{ ts: bt + 1 }] });
        await run(self, bt);
        assert.strictEqual(self._doQuery.calledOnce, true);
    });

    it('is bounded: a future block the hub never covers proceeds on timeout (never freezes)', async function(){
        // Hub always reports a max effective_time BELOW this block — the steady-state
        // "behind" signal that must NOT stall the chain forever.
        const bt = NOW_S() + 3600;                       // far enough that wall-clock never catches up in-test
        const self = ctx({ rows: [{ ts: bt - 50 }], timeoutMs: 60 });
        const started = Date.now();
        await run(self, bt);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 2000, 'must return shortly after the 60ms timeout, not hang: ' + elapsed + 'ms');
        assert.ok(self._doQuery.callCount >= 1, 'should have polled the hub DB at least once');
    });

    it('never throws when the hub DB query fails (treats it as not-ready, falls to timeout)', async function(){
        const self = ctx({ timeoutMs: 60 });
        self.hubDb.doQuery = sinon.stub().rejects(new Error('table not ready'));
        await run(self, NOW_S() + 3600);                 // resolves (no throw) within the bound
    });

    it('is a no-op when no hub DB connection exists', async function(){
        const self = ctx({ noHubDb: true });
        await run(self, NOW_S() + 3600);                 // returns immediately, no hubDb to read
    });
});
