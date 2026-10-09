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

const SOURCE_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'protocol_changes');
const BARE_SENTINEL = /\b9999999999\b/;
const TARGET_GATES = {
    'shared_rows_1.js': [
        'archive_rollback_author_scope_activation.ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION',
    ],
    'shared_rows_5.js': [
        'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION',
        'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION',
        'list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION',
        'list_meta_activation.LIST_META_ACTIVATION',
    ],
};

function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function gateCall(source, key) {
    const start = source.indexOf("addGate('" + key + "'");
    assert.notStrictEqual(start, -1, 'missing gate row ' + key);
    const end = source.indexOf('\n});', start);
    assert.notStrictEqual(end, -1, 'unterminated gate row ' + key);
    return source.slice(start, end + 4);
}

function hasBareSentinel(source) {
    return BARE_SENTINEL.test(stripComments(source));
}

describe('protocol_changes unarmed rows use the named sentinel @regression @tier1', function () {
    it('detects a stray all-nines value without treating prose as a value', function () {
        assert.strictEqual(hasBareSentinel('mainnet: 9999999999,'), true);
        assert.strictEqual(hasBareSentinel('mainnet: UNARMED, // 9999999999'), false);
    });

    it('has no bare sentinel in the bridge, list, or archive rollback rows', function () {
        const offenders = [];
        for (const [file, keys] of Object.entries(TARGET_GATES)) {
            const source = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8');
            for (const key of keys) {
                const row = gateCall(source, key);
                if (hasBareSentinel(row) || !/\bUNARMED\b/.test(stripComments(row))) {
                    offenders.push(file + ':' + key);
                }
            }
        }
        assert.deepStrictEqual(offenders, [], 'write UNARMED instead of the bare sentinel in: ' + offenders.join(', '));
    });

    it('names the supply-zero mainnet time sentinel', function () {
        const source = stripComments(fs.readFileSync(path.join(SOURCE_DIR, 'flag_times.js'), 'utf8'));
        const assignment = source.match(/const UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME\s*=\s*([^;]+);/);
        assert.ok(assignment, 'missing UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME assignment');
        assert.strictEqual(assignment[1].trim(), 'UNARMED');
        assert.strictEqual(hasBareSentinel(assignment[0]), false);
    });
});
