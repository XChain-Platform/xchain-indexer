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

const ProtocolChanges = require('../../../src/protocol_changes.js');
const { REGISTRY_ONLY_STEMS } = require('../../helpers/gate_modules.js');

const ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const PARTS = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes');
const KEYS = [
    'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION',
    'archive_section_verdict_activation.ARCHIVE_SECTION_VERDICT_STATE_HASH_ACTIVATION',
];

function withEnv(value, fn) {
    const saved = process.env[ENV];
    try {
        if (value === undefined) delete process.env[ENV];
        else process.env[ENV] = value;
        return fn();
    } finally {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    }
}

describe('protocol_changes anchor fold rows', function () {
    it('ships both activation maps inert on every network', function () {
        withEnv(undefined, () => {
            for (const key of KEYS) {
                assert.deepStrictEqual(ProtocolChanges.get(key), {
                    mainnet: 9999999999,
                    testnet: 9999999999,
                    regtest: null,
                });
            }
        });
    });

    it('arms both regtest entries from the shared venue variable', function () {
        for (const value of ['armed', '12']) {
            withEnv(value, () => {
                const expected = value === 'armed' ? 0 : 12;
                for (const key of KEYS) assert.strictEqual(ProtocolChanges.get(key).regtest, expected);
            });
        }
    });

    it('stays inactive below the sentinel on mainnet and testnet', function () {
        withEnv(undefined, () => {
            for (const key of KEYS) {
                assert.strictEqual(ProtocolChanges.activeAt(key, 'mainnet', 'DOGE', 99999999, 0), false);
                assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', 'DOGE', 99999999, 0), false);
            }
        });
    });

    it('classifies both stems as registry-only', function () {
        assert.ok(REGISTRY_ONLY_STEMS.includes('anchor_fold_activation'));
        assert.ok(REGISTRY_ONLY_STEMS.includes('archive_section_verdict_activation'));
    });

    it('keeps every shared row part at or under 400 lines', function () {
        const names = fs.readdirSync(PARTS).filter((name) => /^shared_rows_\d+\.js$/.test(name));
        for (const name of names) {
            const text = fs.readFileSync(path.join(PARTS, name), 'utf8');
            const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
            assert.ok(lines <= 400, name + ' is ' + lines + ' lines');
        }
    });
});
