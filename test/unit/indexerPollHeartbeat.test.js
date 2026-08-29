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
 **********************************************************************
 * test/unit/indexerPollHeartbeat.test.js
 *
 * The block-poll loop had no per-iteration timestamp, so a loop that hung
 * inside an await rendered 'healthy' forever.
 *
 * The awaits at the top of the loop (getLastProcessedReorgId, getReorgsSince,
 * getBlockIndex) can black-hole on a dead socket or an exhausted pool without
 * ever rejecting. Nothing then flips liveness -- indexerRunning is only cleared
 * from the api.js .catch() -- and every freshness field the health payload reads
 * is WRITTEN INSIDE the loop, so all of them freeze at their last good values
 * while stallReason stays null because no barrier was hit. buildHealthResponse
 * therefore kept answering status 'healthy', stallClass 'none', lag 0.
 *
 * lastBlockCommittedAt cannot stand in for the heartbeat: it moves only on a
 * COMMIT, so on a caught-up or quiet chain it is old in the healthy case too.
 * That ambiguity is the reason this signal has to be its own field.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');

const XChainIndexer = require('../../src/XChainIndexer.js');
const { buildHealthResponse } = require('../../src/health');

describe('XChainIndexer#isPollSilent()', function () {

    it('is false before the loop has iterated once, so a booting indexer is never dead', function () {
        const indexer = new XChainIndexer();
        assert.strictEqual(indexer.lastPollAt, 0);
        assert.strictEqual(indexer.isPollSilent(), false);
    });

    it('is false while the loop is iterating', function () {
        const indexer = new XChainIndexer();
        indexer.lastPollAt = Date.now();
        assert.strictEqual(indexer.isPollSilent(), false);
    });

    it('is false at the window edge and true past it', function () {
        const indexer = new XChainIndexer();
        indexer.lastPollAt = Date.now() - indexer.pollSilentMs;
        assert.strictEqual(indexer.isPollSilent(), false, 'the edge is not yet silent');
        indexer.lastPollAt = Date.now() - (indexer.pollSilentMs + 1000);
        assert.strictEqual(indexer.isPollSilent(), true);
    });

    it('sizes the window well above one barrier-timeout cycle', function () {
        // A single iteration can hold across several sequential barrier waits, so a
        // window at or below the stall grace would call a merely slow block dead.
        const indexer = new XChainIndexer();
        assert.ok(indexer.pollSilentMs > indexer.healthStallGraceMs,
            'a window inside the stall grace would fire on legitimate barrier defers');
    });

    it('is stamped by BOTH loops, since a catch-up stays inside the inner one for hours', function () {
        // The inner catch-up loop only breaks out to the outer loop every
        // REORG_RECHECK_BLOCKS blocks, so an initial sync legitimately does not return
        // to the outer loop top for hours. An outer-loop-only stamp would report a
        // healthy catching-up indexer dead for exactly as long as it works hardest.
        // The loops need a live decoder DB to drive, so this is a source-level guard.
        const source = fs.readFileSync(require.resolve('../../src/XChainIndexer.js'), 'utf-8');
        const stamps = source.match(/this\.lastPollAt = Date\.now\(\);/g) || [];
        assert.strictEqual(stamps.length, 2, 'exactly the outer and the inner loop stamp the heartbeat');
        assert.ok(
            /while \(true\)\{[\s\S]{0,400}?this\.lastPollAt = Date\.now\(\);[\s\S]{0,200}?if\(this\.stopFlag\)/.test(source),
            'the outer stamp must precede the stopFlag check, so it records the pass whatever the body does'
        );
        assert.ok(
            /this\.util\.bclt\(lastIndexerBlock, lastDecoderBlock\) \)\{[\s\S]{0,600}?this\.lastPollAt = Date\.now\(\);/.test(source),
            'the inner catch-up loop must stamp too or a long initial sync reads as a dead loop'
        );
    });
});

describe('health payload carries loop liveness as its own axis', function () {

    function makeIndexer(overrides = {}){
        return Object.assign({
            decoderDb:            { circuitState: 'closed' },
            indexerDb:            { circuitState: 'closed' },
            lastDecoderBlock:     200,
            lastHubConfigFetchAt: null,
            stallReason:          null,
            lastBlockCommittedAt: null,
            lastPollAt:           0,
            isSynced:             () => true,
            isPollSilent:         () => false
        }, overrides);
    }

    function call(indexer, opts = {}){
        return buildHealthResponse(Object.assign({
            indexer,
            indexerRunning:   true,
            indexerError:     null,
            lastIndexedBlock: 200,
            now:              1_000_000
        }, opts));
    }

    it('publishes pollSilent and the last iteration stamp', async function () {
        const res = await call(makeIndexer({ lastPollAt: 1754870460000 }));
        assert.strictEqual(res.pollSilent, false);
        assert.strictEqual(res.lastPollAt, 1754870460000);
    });

    // The headline case, and the control the fix is measured against: a caught-up
    // indexer whose loop is gone. Every pre-existing field still reads healthy.
    it('reports a hung loop that every other field renders as healthy', async function () {
        const res = await call(makeIndexer({ isPollSilent: () => true, lastPollAt: 1754870460000 }));
        assert.strictEqual(res.pollSilent, true);
        assert.strictEqual(res.status, 'healthy',   'control: status is blind to a hung loop');
        assert.strictEqual(res.stallReason, null,   'control: no barrier was hit, so nothing is stalled');
        assert.strictEqual(res.stallClass, 'none',  'control: the stall discriminator sees nothing');
        assert.strictEqual(res.lag, 0,              'control: lag is frozen at caught-up');
    });

    it('reports not-silent on a quiet chain whose last commit is ancient', async function () {
        // The ambiguity lastBlockCommittedAt cannot resolve: nothing to commit for hours
        // is the healthy steady state, and only the heartbeat separates it from a wedge.
        const res = await call(makeIndexer({ lastBlockCommittedAt: 1, lastPollAt: Date.now() }));
        assert.strictEqual(res.pollSilent, false);
        assert.strictEqual(res.status, 'healthy');
    });

    it('reads not-silent from an indexer double that predates the accessor', async function () {
        const stub = makeIndexer();
        delete stub.isPollSilent;
        const res = await call(stub);
        assert.strictEqual(res.pollSilent, false);
        assert.strictEqual(res.lastPollAt, null);
    });

    it('does not fold loop liveness into status, which drives container restarts', async function () {
        // Deliberate: /status 503 is the xchain-node http_get healthcheck, and a single
        // iteration can hold across several sequential barrier waits. Restarting a
        // container mid-block is the wrong answer to a slow block, so the signal is
        // reported here and alerted on by the monitor instead.
        const res = await call(makeIndexer({ isPollSilent: () => true }));
        assert.strictEqual(res.status, 'healthy');
        assert.strictEqual(res.degraded, false);
    });
});
