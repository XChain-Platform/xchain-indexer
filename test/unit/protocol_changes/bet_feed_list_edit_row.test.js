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
const { REGISTRY_ONLY_STEMS, modulePathFor } = require('../../helpers/gate_modules.js');

const KEY = 'bet_feed_list_edit_activation.BET_FEED_LIST_EDIT_ACTIVATION';
const PART = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes', 'gates_4.js');

describe('protocol_changes BET feed list edit row @regression @tier1', function () {
    it('registers an unarmed production height map with regtest active from genesis', function () {
        assert.deepStrictEqual(ProtocolChanges.get(KEY), {
            mainnet: ProtocolChanges.UNARMED,
            'BTC:testnet': ProtocolChanges.UNARMED,
            'LTC:testnet': ProtocolChanges.UNARMED,
            'DOGE:testnet': ProtocolChanges.UNARMED,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('stays inactive on production networks and activates at regtest genesis', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', coin, ProtocolChanges.UNARMED - 1, null), false);
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, ProtocolChanges.UNARMED - 1, null), false);
        }
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });

    it('is registry-only and keeps its registry part within the size limit', function () {
        assert.ok(REGISTRY_ONLY_STEMS.includes('bet_feed_list_edit_activation'));
        assert.strictEqual(modulePathFor('bet_feed_list_edit_activation'), null);
        const text = fs.readFileSync(PART, 'utf8');
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        assert.ok(lines <= 400, 'gates_4.js is ' + lines + ' lines');
    });
});
