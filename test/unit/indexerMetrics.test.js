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

    it('registers nothing when metrics are off', function () {
        const off = installObservability(null, { service: 'xchain-indexer', env: {} });
        assert.strictEqual(off.registry, null);
        assert.strictEqual(installIndexerMetrics(off, { lastBlockCommittedAt: Date.now() }), false);
    });
});
