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
const fs     = require('fs');
const path   = require('path');

const ProtocolChanges = require('../../../src/protocol_changes.js');
const { SHARED_GATES } = require('../../../src/consensus_rules_digest.js');

const PARTS = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes');

describe('protocol_changes anchor bundle order row', function () {
    it('pins the activation map', function () {
        assert.deepStrictEqual(
            ProtocolChanges.get('anchor_bundle_order_activation.ANCHOR_BUNDLE_ORDER_ACTIVATION'),
            { mainnet: 9999999999, testnet: 9999999999, regtest: 0 },
        );
    });

    it('keeps all three shared parts at or under 400 lines and rollcall out of part 2', function () {
        for (const name of ['shared_rows_1.js', 'shared_rows_2.js', 'shared_rows_3.js']) {
            const text = fs.readFileSync(path.join(PARTS, name), 'utf8');
            const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
            assert.ok(lines <= 400, name + ' is ' + lines + ' lines');
            if (name === 'shared_rows_2.js') assert.ok(!text.includes("addGate('rollcall_activation."));
        }
    });

    it('lists the activation in SHARED_GATES exactly once', function () {
        const hits = SHARED_GATES.filter(([mod]) => mod === 'anchor_bundle_order_activation');
        assert.deepStrictEqual(hits,
            [['anchor_bundle_order_activation', ['ANCHOR_BUNDLE_ORDER_ACTIVATION']]]);
    });
});
