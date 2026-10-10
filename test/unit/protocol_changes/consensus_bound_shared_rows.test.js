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

    it('keeps the oracle and chain-margin entries at the shared digest tail', function () {
        assert.deepStrictEqual(SHARED_GATES.slice(-7), [
            ['oracle_price_age_hourly_activation', ['ORACLE_PRICE_AGE_HOURLY_ACTIVATION']],
            ['oracle_hourly_window_activation', ['ORACLE_HOURLY_WINDOW_FIRST_ROUND']],
            ['oracle_round_time_activation', ['ORACLE_ROUND_TIME_ACTIVATION']],
            [
                'price_scale_activation',
                ['PRICE_V1_CANONICAL_ACTIVATION', 'PRICE_V1_VALUE_MAX_LENGTH', 'PRICE_V1_FEE_MAX_LENGTH'],
            ],
            ['list_share_producer_activation', ['LIST_SHARE_PRODUCER_ACTIVATION']],
            ['list_meta_activation', ['LIST_META_ACTIVATION']],
            [
                'mirror_admission_margin_activation',
                ['ADMIT_CHAIN_MARGIN_ACTIVATION', 'ADMIT_CHAIN_MARGIN_BLOCKS'],
            ],
        ]);
    });

    it('resolves both mirror-admission chain-margin rows through the gate registry', function () {
        assert.deepStrictEqual(gateRegistry.get('mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION'), {
            mainnet: null,
            'DOGE:mainnet': null,
            'DOGE:testnet': 9999999999,
            regtest: 0,
        });
        assert.deepStrictEqual(gateRegistry.get('mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_BLOCKS'), {
            DOGE: {
                bridge_transfers: 14,
                cross_chain_calls: 14,
                cross_chain_matches: 14,
                list_snapshots: 14,
                policy_snapshots: 14,
                price_snapshots: 16,
            },
        });
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
