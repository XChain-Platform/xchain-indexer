// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');

const observability = require('../../../src/observability');
const { readLogEnv } = require('../../../src/observability/logShipper');

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];

describe('observability console patching and environment parsing', function () {
    afterEach(function () {
        observability._resetObservability();
    });

    it('patches every console method, formats arguments, and restores the originals', function () {
        const originals = Object.fromEntries(CONSOLE_METHODS.map(name => [name, console[name]]));
        const handle = observability.patchConsole({
            service: 'xchain-indexer',
            env: { XCHAIN_LOG_PATCH: '1' }
        });

        assert.strictEqual(handle.patched, true);
        for (const name of CONSOLE_METHODS) {
            assert.notStrictEqual(console[name], originals[name], `${name} must be patched`);
        }

        const calls = [];
        handle.logger.log = (...args) => calls.push(args);
        console.error('x %s', 'y');
        assert.deepStrictEqual(calls, [['error', 'x y']]);

        handle.unpatch();
        for (const name of CONSOLE_METHODS) {
            assert.strictEqual(console[name], originals[name], `${name} must be restored exactly`);
        }
        assert.strictEqual(console.log, originals.log);
    });

    it('returns the existing patch handle without wrapping console twice', function () {
        const first = observability.patchConsole({
            service: 'xchain-indexer',
            env: { XCHAIN_LOG_PATCH: '1' }
        });
        const wrapped = Object.fromEntries(CONSOLE_METHODS.map(name => [name, console[name]]));

        const second = observability.patchConsole({
            service: 'another-service',
            env: { XCHAIN_LOG_PATCH: '1' }
        });

        assert.strictEqual(second, first);
        for (const name of CONSOLE_METHODS) {
            assert.strictEqual(console[name], wrapped[name], `${name} must not be wrapped twice`);
        }
    });

    it('normalizes the metrics path and delegates log environment parsing unchanged', function () {
        const env = {
            METRICS_ENABLED: '1',
            METRICS_PATH: 'metrics',
            LOG_FORMAT: 'json',
            LOG_LEVEL: 'warn',
            LOG_SHIP_BATCH_SIZE: '17'
        };

        const config = observability.readObservabilityEnv(env);
        assert.strictEqual(config.metricsPath, '/metrics');
        assert.deepStrictEqual(config.log, readLogEnv(env));
    });

    it('defaults metrics off and enables HTTP metrics only with metrics', function () {
        const defaults = observability.readObservabilityEnv({});
        assert.strictEqual(defaults.metricsEnabled, false);
        assert.strictEqual(defaults.httpMetrics, false);
        assert.strictEqual(observability.readObservabilityEnv({ METRICS_HTTP: '1' }).httpMetrics, false);
        assert.strictEqual(observability.readObservabilityEnv({ METRICS_ENABLED: '1' }).httpMetrics, true);
        assert.strictEqual(observability.readObservabilityEnv({
            METRICS_ENABLED: '1', METRICS_HTTP: '0'
        }).httpMetrics, false);
    });

    it('uses Express route patterns and caps distinct unmatched route labels', function () {
        assert.strictEqual(observability.routeLabel({
            baseUrl: '/api',
            route: { path: '/widgets/:id' },
            originalUrl: '/api/widgets/42'
        }), '/api/widgets/:id');

        for (let i = 0; i < 20; i += 1) {
            assert.strictEqual(
                observability.routeLabel({ originalUrl: `/segment-${i}/rest?x=1` }),
                `/segment-${i}`
            );
        }
        assert.strictEqual(observability.routeLabel({ url: '/segment-20/rest' }), '/_unmatched');
    });
});
