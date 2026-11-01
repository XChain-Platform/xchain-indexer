/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { SHARED_GATES } = require('../../../../src/consensus_rules_digest.js');

const KEY = 'checkpoint_supersede_activation.CHECKPOINT_SUPERSEDE_ACTIVATION';
// Every side reads the gate at the checkpoint's BTC snapshot_block with coin BTC.
const activeAtSnapshot = (network, snapshotBlock) => gateRegistry.activeAt(KEY, network, 'BTC', snapshotBlock, null);

describe('checkpoint_supersede_activation registry row @regression @tier1', function () {
    it('is a height row: mainnet unpinned, BTC:testnet and testnet on the sentinel, regtest 0', function () {
        // A height row compares the snapshot block and ignores the time argument.
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'BTC', 0, gateRegistry.UNARMED), false);
        assert.deepStrictEqual({ ...gateRegistry.get(KEY) }, {
            mainnet: null,
            'BTC:testnet': 158557,
            'LTC:testnet': 4949697,
            'DOGE:testnet': 68035864,
            testnet: gateRegistry.UNARMED,
            regtest: 0,
        });
        assert.strictEqual(gateRegistry.UNARMED, 9999999999);
        assert.strictEqual(gateRegistry.UNPINNED, null);
    });

    it('is inactive on mainnet at every snapshot block', function () {
        for (const block of [0, 1, 950000, 9999999998, 9999999999]) {
            assert.strictEqual(activeAtSnapshot('mainnet', block), false, 'mainnet ' + block);
        }
    });

    it('is inactive on testnet below the sentinel until a cut arms it', function () {
        for (const block of [0, 1, 156230, 158556]) {
            assert.strictEqual(activeAtSnapshot('testnet', block), false, 'testnet ' + block);
        }
        for (const block of [158557, 158558, 9999999998]) {
            assert.strictEqual(activeAtSnapshot('testnet', block), true, 'testnet ' + block);
        }
    });

    it('is active on regtest from snapshot block 0', function () {
        for (const block of [0, 1, 500]) {
            assert.strictEqual(activeAtSnapshot('regtest', block), true, 'regtest ' + block);
        }
    });

    it('resolves the BTC:testnet slot before the bare testnet fallback', function () {
        assert.strictEqual(gateRegistry.get(KEY)['BTC:testnet'], 158557);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'BTC', 158557, null), true);
        // A DOGE-coin read lands on the DOGE:testnet slot, which sits far above any BTC height.
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'DOGE', 158557, null), false);
    });

    it('is the last SHARED_GATES entry, so every earlier digest preimage row holds', function () {
        assert.deepStrictEqual(SHARED_GATES[SHARED_GATES.length - 1],
            ['checkpoint_supersede_activation', ['CHECKPOINT_SUPERSEDE_ACTIVATION']]);
        assert.strictEqual(SHARED_GATES.filter(([stem]) => stem === 'checkpoint_supersede_activation').length, 1);
    });
});
