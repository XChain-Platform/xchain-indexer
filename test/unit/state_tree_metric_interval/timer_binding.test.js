// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

describe('indexer state-tree metric timer binding', function () {
    it('arms the timer with the resolver output', function () {
        const modulePath = path.join(__dirname, '../../../src/XChainIndexer/background_jobs.js');
        const drive = [
            "global.setInterval = (fn, delay) => ({ delay, unref() {} });",
            "const jobs = require(process.argv[1]);",
            "const host = { _stateTreeMetricTimer: null, config: { COIN: 'BTC', NETWORK: 'regtest' }, indexerDb: {} };",
            "jobs.startStateTreeMetric.call(host);",
            "if (!host._stateTreeMetricTimer || host._stateTreeMetricTimer.delay !== 60000) process.exit(2);"
        ].join('\n');
        const result = spawnSync(process.execPath, ['-e', drive, modulePath], {
            env: {
                ...process.env,
                INDEXER_COIN: 'BTC',
                INDEXER_NETWORK: 'regtest',
                STATE_TREE_METRIC_INTERVAL_MS: '5'
            },
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    });
});
