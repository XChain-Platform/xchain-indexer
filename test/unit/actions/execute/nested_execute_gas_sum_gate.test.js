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
const sinon = require('sinon');
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { KEY, boundedAt, bankUnusedGas } = require('../../../../src/actions/execute/nested_gas_sum.js');
const { stubGate } = require('../../../helpers/gate_modules.js');

describe('actions/execute/nested_gas_sum: the bounded nested refund sum @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('is a registry-only height row, armed only on regtest', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        assert.strictEqual(boundedAt({ NETWORK: 'regtest', COIN: 'BTC' }, { BLOCK_INDEX: 0 }), true);
        assert.strictEqual(boundedAt({ NETWORK: 'mainnet', COIN: 'BTC' }, { BLOCK_INDEX: 900000 }), false);
    });

    it('sums unbounded before the gate', function () {
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: 500 }, false, 100), 510);
        assert.strictEqual(bankUnusedGas(0, { gasUnusedSubtree: undefined }, false, 100), 0);
    });

    it('caps the sum at the caller metered gas after the gate', function () {
        assert.strictEqual(bankUnusedGas(60, { gasUnusedSubtree: 70 }, true, 100), 100);
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: 20 }, true, 100), 30);
    });

    it('drops negative and non-finite addends after the gate', function () {
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: -5 }, true, 100), 10);
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: Infinity }, true, 100), 10);
        assert.strictEqual(bankUnusedGas(10, { gasUnusedSubtree: 5 }, true, undefined), 0);
    });

    it('boundedAt follows the registry answer', function () {
        stubGate(sinon, KEY, true);
        assert.strictEqual(boundedAt({ NETWORK: 'mainnet', COIN: 'BTC' }, { BLOCK_INDEX: 1 }), true);
        stubGate(sinon, KEY, false);
        assert.strictEqual(boundedAt({ NETWORK: 'regtest', COIN: 'BTC' }, { BLOCK_INDEX: 1 }), false);
    });
});
