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

describe('protocol_changes consensus-bound indexer rows @regression @tier1', function () {
    it('pins the archive MATCH_COUNT activation map', function () {
        assert.deepStrictEqual(
            ProtocolChanges.get('archive_match_count_activation.ARCHIVE_MATCH_COUNT_ACTIVATION'),
            { mainnet: 9999999999, 'BTC:testnet': 155001, 'LTC:testnet': 4906040, 'DOGE:testnet': 67962387, testnet: 9999999999, regtest: 0 },
        );
    });

    it('pins the BROADCAST FEE length flag day', function () {
        assert.strictEqual(ProtocolChanges.BROADCAST_FEE_LENGTH_MAINNET_TIME, 9999999999);
        assert.strictEqual(ProtocolChanges.BROADCAST_FEE_LENGTH_TESTNET_TIME, 1791061097);
        assert.deepStrictEqual(ProtocolChanges.get('protocol_changes.changes.BROADCAST_FEE_LENGTH'), {
            version_major: 0,
            version_minor: 2,
            version_revision: 0,
            mainnet_time: 9999999999,
            testnet_time: 1791061097,
            regtest_time: 0,
            mainnet_block: 0,
            testnet_block: 0,
            regtest_block: 0,
        });
    });

    it('keeps gates_1.js at or under 400 lines', function () {
        const file = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes', 'gates_1.js');
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        assert.ok(lines <= 400, 'gates_1.js is ' + lines + ' lines');
    });
});
