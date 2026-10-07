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

const KEY = 'anchor_archive_fold_term_activation.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION';
const PART = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes', 'gates_1.js');

describe('protocol_changes anchor archive fold-term row', function () {
    it('ships a sealed height map unarmed on live networks and active on regtest from genesis', function () {
        assert.deepStrictEqual(ProtocolChanges.get(KEY), {
            mainnet: 9999999999,
            'BTC:testnet': 9999999999,
            'LTC:testnet': 9999999999,
            'DOGE:testnet': 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('stays inactive below the live sentinel and activates at regtest genesis', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, 9999999998, null), false);
        }
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', 'BTC', 9999999998, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('is registry-only and keeps its part within the size limit', function () {
        assert.ok(REGISTRY_ONLY_STEMS.includes('anchor_archive_fold_term_activation'));
        const text = fs.readFileSync(PART, 'utf8');
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        assert.ok(lines <= 400, 'gates_1.js is ' + lines + ' lines');
    });
});
