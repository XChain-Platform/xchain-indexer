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

const KEY = 'bridge_policy_detach_activation.BRIDGE_POLICY_DETACH';
const ISSUE_KEY = 'issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH';
const PART = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes', 'gates_4.js');

describe('protocol_changes bridge policy detach row', function () {
    it('registers the destination-side height map', function () {
        assert.deepStrictEqual(ProtocolChanges.get(KEY), {
            mainnet: 9999999999,
            'BTC:testnet': 155001,
            'LTC:testnet': 4906040,
            'DOGE:testnet': 67962387,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('is inert below the sentinel on mainnet, armed at the v0.21.3 height on testnet and active on regtest at genesis', function () {
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', 'DOGE', 9999999998, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', 'DOGE', 67962386, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', 'DOGE', 67962387, null), true);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'DOGE', 0, null), true);
    });

    it('never arms ahead of issue policy list detach', function () {
        const row = ProtocolChanges.get(KEY);
        const issue = ProtocolChanges.get(ISSUE_KEY);
        for (const network of Object.keys(row)) {
            assert.ok(row[network] >= issue[network], network);
        }
    });

    it('is registry-only and keeps its part within the size limit', function () {
        assert.ok(REGISTRY_ONLY_STEMS.includes('bridge_policy_detach_activation'));
        const text = fs.readFileSync(PART, 'utf8');
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        assert.ok(lines <= 400, 'gates_4.js is ' + lines + ' lines');
    });
});
