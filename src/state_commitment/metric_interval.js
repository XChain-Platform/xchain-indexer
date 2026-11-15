// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 2147483647;

const INTEGER_TEXT = /^[+-]?\d+$/;

// Only a whole decimal integer is a number here: parseInt alone would accept
// "60000garbage" as 60000 and read "0garbage" as the disable value.
function resolveStateTreeMetricIntervalMs(raw) {
    if (raw === undefined || raw === null || raw === '')
        return { intervalMs: DEFAULT_INTERVAL_MS, disabled: false, adjusted: false };
    const text = String(raw).trim();
    const parsed = INTEGER_TEXT.test(text) ? parseInt(text, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0)
        return { intervalMs: DEFAULT_INTERVAL_MS, disabled: false, adjusted: true };
    if (parsed === 0)
        return { intervalMs: 0, disabled: true, adjusted: false };
    if (parsed < MIN_INTERVAL_MS)
        return { intervalMs: MIN_INTERVAL_MS, disabled: false, adjusted: true };
    if (parsed > MAX_INTERVAL_MS)
        return { intervalMs: MAX_INTERVAL_MS, disabled: false, adjusted: true };
    return { intervalMs: parsed, disabled: false, adjusted: false };
}

module.exports = {
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
    resolveStateTreeMetricIntervalMs
};
