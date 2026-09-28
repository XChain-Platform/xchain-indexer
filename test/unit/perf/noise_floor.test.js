'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const { shouldTrustRatioGate } = require('../../perf/scenarios/helpers/noise_floor');

describe('performance ratio noise floor', function () {
    it('rejects a 1.91ms baseline at the new 5ms floor', function () {
        assert.strictEqual(shouldTrustRatioGate(1.91, 5), false);
    });

    it('accepts the same baseline at the old 1ms floor', function () {
        assert.strictEqual(shouldTrustRatioGate(1.91, 1), true);
    });

    it('rejects missing and non-finite baselines', function () {
        assert.strictEqual(shouldTrustRatioGate(null, 5), false);
        assert.strictEqual(shouldTrustRatioGate(NaN, 5), false);
    });

    it('accepts values at or above the floor', function () {
        assert.strictEqual(shouldTrustRatioGate(5, 5), true);
        assert.strictEqual(shouldTrustRatioGate(5.01, 5), true);
    });
});
