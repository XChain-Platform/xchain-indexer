'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { prelaunchAdmits } = require('../../../../src/consensus/gates/mainnet_launch_gate.js');

const LAUNCH = 1000;
const SEEDS = { 'BTC:mainnet': ['1Seed'] };
const opts = { launchTime: LAUNCH, seedSources: SEEDS };
const base = { network: 'mainnet', coin: 'BTC', blockTime: LAUNCH - 1, data: 'SEND|0|x', source: '1Other' };

describe('prelaunchAdmits', function () {
    it('refuses an ordinary mainnet transaction before launch', function () {
        assert.strictEqual(prelaunchAdmits(base, opts), false);
        assert.strictEqual(prelaunchAdmits(base), false);
    });

    it('admits any non-mainnet network', function () {
        for (const network of ['testnet', 'regtest']) {
            assert.strictEqual(prelaunchAdmits({ ...base, network }, opts), true);
        }
        assert.strictEqual(prelaunchAdmits({ ...base, network: undefined }, opts), false);
        assert.strictEqual(prelaunchAdmits({ ...base, network: '' }, opts), false);
    });

    it('admits at or after the launch time, not before', function () {
        assert.strictEqual(prelaunchAdmits({ ...base, blockTime: LAUNCH }, opts), true);
        assert.strictEqual(prelaunchAdmits({ ...base, blockTime: LAUNCH + 1 }, opts), true);
        assert.strictEqual(prelaunchAdmits({ ...base, blockTime: LAUNCH - 1 }, opts), false);
        assert.strictEqual(prelaunchAdmits({ ...base, blockTime: '2000' }, opts), false);
        assert.strictEqual(prelaunchAdmits({ ...base, blockTime: 2000 }, { seedSources: SEEDS }), false);
    });

    it('admits the validator action set before launch', function () {
        for (const data of ['ANCHOR|0', 'ANCHOR|3', 'PRICE|0', 'NODEPROOF', 'ROLLCALL|1', 'ATTEST|1', 'ATTEST|3', 'ATTEST|4']) {
            assert.strictEqual(prelaunchAdmits({ ...base, data }, opts), true, data);
        }
        for (const data of ['PRICE|1', 'ANCHOR|4', 'SEND|0', 'ATTEST|2', undefined]) {
            assert.strictEqual(prelaunchAdmits({ ...base, data }, opts), false, String(data));
        }
    });

    it('admits a pinned seed source only', function () {
        assert.strictEqual(prelaunchAdmits({ ...base, source: '1Seed' }, opts), true);
        assert.strictEqual(prelaunchAdmits({ ...base, source: '1Seed', coin: 'LTC' }, opts), false);
        assert.strictEqual(prelaunchAdmits({ ...base, source: '1Seed' }, { launchTime: LAUNCH }), false);
    });

    it('throws on a non-object input', function () {
        assert.throws(() => prelaunchAdmits(null, opts), TypeError);
        assert.throws(() => prelaunchAdmits('tx', opts), TypeError);
    });
});
