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
            'BTC:testnet': gateRegistry.UNARMED,
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
        for (const block of [0, 1, 156230, 9999999998]) {
            assert.strictEqual(activeAtSnapshot('testnet', block), false, 'testnet ' + block);
        }
    });

    it('is active on regtest from snapshot block 0', function () {
        for (const block of [0, 1, 500]) {
            assert.strictEqual(activeAtSnapshot('regtest', block), true, 'regtest ' + block);
        }
    });

    it('resolves the BTC:testnet slot before the bare testnet fallback', function () {
        assert.strictEqual(gateRegistry.get(KEY)['DOGE:testnet'], undefined);
        assert.strictEqual(gateRegistry.get(KEY)['BTC:testnet'], gateRegistry.UNARMED);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'BTC', gateRegistry.UNARMED, null), true,
            'the sentinel itself is the only testnet height that reads active');
    });

    it('is the last SHARED_GATES entry, so every earlier digest preimage row holds', function () {
        assert.deepStrictEqual(SHARED_GATES[SHARED_GATES.length - 1],
            ['checkpoint_supersede_activation', ['CHECKPOINT_SUPERSEDE_ACTIVATION']]);
        assert.strictEqual(SHARED_GATES.filter(([stem]) => stem === 'checkpoint_supersede_activation').length, 1);
    });
});
