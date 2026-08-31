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

const { installIndexerMetrics } = require('../../src/indexerMetrics.js');
const { installObservability }  = require('../../src/observability');

// Real registry from the vendored observability module, not a stub: the point of
// the gauge is that it renders on the actual scrape surface.
function realObservability(){
    return installObservability(null, {
        service: 'xchain-indexer',
        env:     { METRICS_ENABLED: 'true' }
    });
}

describe('indexer poll-freshness heartbeat metric (item 9bee49e8)', function () {

    // The observability registry is process-wide (one process is one service),
    // so a case asserting a series is ABSENT has to start from a clean registry
    // rather than inheriting the previous case's series.
    afterEach(function () { require('../../src/observability')._resetObservability(); });

    it('renders the last-commit timestamp on the scrape surface', function () {
        const observability = realObservability();
        const indexer = { lastBlockCommittedAt: 1754870400000 };
        assert.strictEqual(installIndexerMetrics(observability, indexer), true);

        const out = observability.registry.render();
        assert.match(out, /xchain_indexer_last_block_committed_timestamp_seconds 1754870400\b/,
            'the gauge must render epoch SECONDS, not the raw epoch-ms the indexer stores');
    });

    it('tracks the live indexer across scrapes so a wedged poller shows a growing age', function () {
        const observability = realObservability();
        const indexer = { lastBlockCommittedAt: 1754870400000 };
        installIndexerMetrics(observability, indexer);

        observability.registry.render();
        indexer.lastBlockCommittedAt = 1754870460000;
        assert.match(observability.registry.render(),
            /xchain_indexer_last_block_committed_timestamp_seconds 1754870460\b/,
            'the collector must read at scrape time; a value captured at registration would freeze');

        // A stalled poller stops updating the field, so the series stops
        // advancing and time() - <gauge> grows without bound. That is the whole
        // signal, so pin that a re-scrape after a stall repeats the old value.
        assert.match(observability.registry.render(),
            /xchain_indexer_last_block_committed_timestamp_seconds 1754870460\b/);
    });

    it('leaves the series absent until the first commit', function () {
        const observability = realObservability();
        installIndexerMetrics(observability, { lastBlockCommittedAt: null });
        // A zero here would render as a 1970 timestamp and page a healthy
        // still-starting indexer immediately.
        assert.ok(!/xchain_indexer_last_block_committed_timestamp_seconds \d/
            .test(observability.registry.render()),
            'a never-committed indexer is starting up, not stalled');
    });

    // Commit recency cannot tell a wedged poller from a quiet chain on its own: a
    // caught-up indexer commits nothing for hours and is healthy. The iteration
    // heartbeat is the discriminator, and the only signal a hung await moves.

    it('renders the poll heartbeat beside the commit timestamp', function () {
        const observability = realObservability();
        installIndexerMetrics(observability, { lastBlockCommittedAt: 1754870400000, lastPollAt: 1754870460000 });
        assert.match(observability.registry.render(),
            /xchain_indexer_last_poll_timestamp_seconds 1754870460\b/);
    });

    it('advances the heartbeat while the commit stamp stands still, which is the whole point', function () {
        // A caught-up indexer on a quiet chain: nothing to commit, loop iterating. Read
        // off the commit gauge alone this is indistinguishable from a wedge.
        const observability = realObservability();
        const indexer = { lastBlockCommittedAt: 1754870400000, lastPollAt: 1754870460000 };
        installIndexerMetrics(observability, indexer);
        observability.registry.render();

        indexer.lastPollAt = 1754870520000;
        const out = observability.registry.render();
        assert.match(out, /xchain_indexer_last_poll_timestamp_seconds 1754870520\b/);
        assert.match(out, /xchain_indexer_last_block_committed_timestamp_seconds 1754870400\b/);
    });

    it('leaves the heartbeat absent until the loop has iterated once', function () {
        const observability = realObservability();
        installIndexerMetrics(observability, { lastBlockCommittedAt: null, lastPollAt: 0 });
        assert.ok(!/xchain_indexer_last_poll_timestamp_seconds \d/
            .test(observability.registry.render()),
            'a booting indexer has not iterated yet, and a 0 would render as 1970');
    });

    it('still registers the series when metrics are off, where only the endpoint is gated', function () {
        // Gating the registry on METRICS_ENABLED would leave this counter absent
        // on the default fleet, which is every box: nothing could record into
        // it, so enabling metrics later starts from zero history instead of
        // revealing what happened.
        const off = installObservability(null, { service: 'xchain-indexer', env: {} });
        assert.strictEqual(off.enabled, false, 'the endpoint stays off');
        assert.ok(off.registry, 'the registry itself is not gated');
        assert.strictEqual(installIndexerMetrics(off, { lastBlockCommittedAt: Date.now() }), true);
    });

    it('refuses to register without a registry at all', function () {
        assert.strictEqual(installIndexerMetrics({ registry: null }, { lastBlockCommittedAt: Date.now() }), false);
    });
});
