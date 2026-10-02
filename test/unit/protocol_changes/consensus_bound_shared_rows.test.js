'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const gateRegistry = require('../../../src/consensus/gate_registry');
const { SHARED_GATES } = require('../../../src/consensus_rules_digest');

const SHARED_ROWS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes');

describe('protocol_changes consensus-bound shared rows', function () {
    it('keeps the first three shared row parts at or under 400 lines', function () {
        for (const name of ['shared_rows_1.js', 'shared_rows_2.js', 'shared_rows_3.js']) {
            const text = fs.readFileSync(path.join(SHARED_ROWS_DIR, name), 'utf8');
            const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
            assert.ok(lines <= 400, name + ' is ' + lines + ' lines');
        }
    });

    it('holds the anchor bundle order entry exactly once', function () {
        const entries = SHARED_GATES.filter(([stem, names]) =>
            stem === 'anchor_bundle_order_activation' &&
            names.length === 1 && names[0] === 'ANCHOR_BUNDLE_ORDER_ACTIVATION');
        assert.deepStrictEqual(entries, [
            ['anchor_bundle_order_activation', ['ANCHOR_BUNDLE_ORDER_ACTIVATION']],
        ]);
    });

    it('keeps the hourly oracle entries before the PRICE v1 canonical bounds at the shared digest tail', function () {
        assert.deepStrictEqual(SHARED_GATES.slice(-5), [
            ['oracle_price_age_hourly_activation', ['ORACLE_PRICE_AGE_HOURLY_ACTIVATION']],
            ['oracle_hourly_window_activation', ['ORACLE_HOURLY_WINDOW_FIRST_ROUND']],
            [
                'price_scale_activation',
                ['PRICE_V1_CANONICAL_ACTIVATION', 'PRICE_V1_VALUE_MAX_LENGTH', 'PRICE_V1_FEE_MAX_LENGTH'],
            ],
            ['list_share_producer_activation', ['LIST_SHARE_PRODUCER_ACTIVATION']],
            ['list_meta_activation', ['LIST_META_ACTIVATION']],
        ]);
    });

    it('resolves the existing price scale rows through the gate registry', function () {
        const names = [
            'PRICE_SCALE_ACTIVATION',
            'PRICE_SCALE_MAX_DECIMALS',
            'PRICE_VALUE_RE_LEGACY',
            'PRICE_VALUE_RE_CANONICAL',
        ];
        for (const name of names) {
            const key = 'price_scale_activation.' + name;
            assert.notStrictEqual(gateRegistry.get(key), undefined, key + ' did not resolve');
        }
    });
});
