// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveStateTreeMetricIntervalMs } = require('../../../src/state_commitment/metric_interval.js');

describe('state-tree metric interval resolver', function () {
    it('keeps the default, disable value, and accepted boundary', function () {
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs(undefined), {
            intervalMs: 14400000, disabled: false, adjusted: false
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs(''), {
            intervalMs: 14400000, disabled: false, adjusted: false
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs('0'), {
            intervalMs: 0, disabled: true, adjusted: false
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs('60000'), {
            intervalMs: 60000, disabled: false, adjusted: false
        });
    });

    it('falls back for invalid values and clamps both timer bounds', function () {
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs('-1'), {
            intervalMs: 14400000, disabled: false, adjusted: true
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs('abc'), {
            intervalMs: 14400000, disabled: false, adjusted: true
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs('5'), {
            intervalMs: 60000, disabled: false, adjusted: true
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs('59999'), {
            intervalMs: 60000, disabled: false, adjusted: true
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs('3000000000'), {
            intervalMs: 2147483647, disabled: false, adjusted: true
        });
    });

    it('treats numeric-prefix garbage as invalid, never as its leading digits', function () {
        const fallback = { intervalMs: 14400000, disabled: false, adjusted: true };
        for (const raw of ['60000garbage', '0garbage', '1e5', '12.5', '0x10', '- 5', 'NaN', ' ']) {
            assert.deepStrictEqual(resolveStateTreeMetricIntervalMs(raw), fallback, JSON.stringify(raw));
        }
    });

    it('accepts whole decimal integers with surrounding blanks or a plus sign', function () {
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs(' 120000 '), {
            intervalMs: 120000, disabled: false, adjusted: false
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs('+70000'), {
            intervalMs: 70000, disabled: false, adjusted: false
        });
        assert.deepStrictEqual(resolveStateTreeMetricIntervalMs(' 0 '), {
            intervalMs: 0, disabled: true, adjusted: false
        });
    });

    it('stays byte-identical to the peer service copy when the peer checkout is present', function () {
        const peer = path.join(__dirname, '../../../../xchain-sync',
            'src/state_commitment/metric_interval.js');
        if (!fs.existsSync(peer)) return this.skip();
        const own = path.join(__dirname, '../../../src/state_commitment/metric_interval.js');
        assert.strictEqual(fs.readFileSync(own, 'utf8'), fs.readFileSync(peer, 'utf8'),
            'metric_interval.js drifted between xchain-indexer and xchain-sync; the two copies must stay byte-identical');
    });
});
