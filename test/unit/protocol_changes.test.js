// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');

describe('ProtocolChanges @regression @tier3', function () {
    let ProtocolChanges, pc, indexer;

    beforeEach(function () {
        indexer = createMockIndexer();
        // Set version for the indexer package
        process.env.npm_package_version = '1.0.0';
        process.env.INDEXER_NETWORK = 'regtest';
        ProtocolChanges = require('../../src/protocol_changes.js');
        pc = new ProtocolChanges(indexer);
    });

    describe('parseChanges()', function () {
        it('should define all 21 standard actions', function () {
            const expectedActions = [
                'ADDRESS', 'AIRDROP', 'BATCH', 'BROADCAST', 'CALLBACK',
                'DESTROY', 'DISPENSER', 'DIVIDEND', 'DISPENSE', 'FILE',
                'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
                'ORDER', 'SEND', 'SLEEP', 'SWAP', 'SWEEP',
            ];
            for (const action of expectedActions) {
                assert.ok(pc.changes[action], `${action} should be defined`);
            }
        });

        it('should parse version into major/minor/revision', function () {
            const change = pc.changes['SEND'];
            assert.strictEqual(change.version_major, 1);
            assert.strictEqual(change.version_minor, 0);
            assert.strictEqual(change.version_revision, 0);
        });

        it('should set all activation blocks to 0', function () {
            const change = pc.changes['ISSUE'];
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
        });

        it('should set all activation times to 0', function () {
            const change = pc.changes['MINT'];
            assert.strictEqual(change.mainnet_time, 0);
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
        });
    });

    describe('addChange()', function () {
        it('should add a new change successfully', function () {
            pc.addChange('TEST_ACTION', '2.0.0', 0, 0, 0, 100, 50, 0);
            assert.ok(pc.changes['TEST_ACTION']);
            assert.strictEqual(pc.changes['TEST_ACTION'].version_major, 2);
            assert.strictEqual(pc.changes['TEST_ACTION'].mainnet_block, 100);
        });

        it('should throw for duplicate name', function () {
            assert.throws(function () {
                pc.addChange('SEND', '1.0.0', 0, 0, 0, 0, 0, 0);
            });
        });

        it('should throw for non-string name', function () {
            assert.throws(function () {
                pc.addChange(123, '1.0.0', 0, 0, 0, 0, 0, 0);
            });
        });

        it('should throw for non-string version', function () {
            assert.throws(function () {
                pc.addChange('NEW_ACTION', 100, 0, 0, 0, 0, 0, 0);
            });
        });

        it('should throw for non-semantic version', function () {
            assert.throws(function () {
                pc.addChange('NEW_ACTION', '1.0', 0, 0, 0, 0, 0, 0);
            });
        });

        it('should throw for non-number time/block params', function () {
            assert.throws(function () {
                pc.addChange('NEW_ACTION', '1.0.0', 'abc', 0, 0, 0, 0, 0);
            });
        });
    });

    describe('isDefined()', function () {
        it('should return true for defined actions', function () {
            assert.strictEqual(pc.isDefined('SEND'), true);
            assert.strictEqual(pc.isDefined('ISSUE'), true);
        });

        it('should return false for undefined actions', function () {
            assert.strictEqual(pc.isDefined('BET'), false);
            assert.strictEqual(pc.isDefined('NONEXISTENT'), false);
        });

        it('should be case sensitive', function () {
            assert.strictEqual(pc.isDefined('send'), false);
            assert.strictEqual(pc.isDefined('Send'), false);
        });
    });

    describe('isEnabled()', function () {
        it('should return true for actions active from block 0 (regtest)', async function () {
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('SEND', 100);
            assert.strictEqual(enabled, true);
        });

        it('should return false for undefined action', async function () {
            const enabled = await pc.isEnabled('BET', 100);
            assert.strictEqual(enabled, false);
        });

        it('should return false when version is too high', async function () {
            pc.addChange('FUTURE_ACTION', '99.0.0', 0, 0, 0, 0, 0, 0);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('FUTURE_ACTION', 100);
            assert.strictEqual(enabled, false);
        });

        it('should return false when block_index is before activation', async function () {
            pc.addChange('LATE_ACTION', '1.0.0', 0, 0, 0, 0, 0, 999999);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('LATE_ACTION', 100);
            assert.strictEqual(enabled, false);
        });

        it('should return true when block_index equals activation block', async function () {
            pc.addChange('EXACT_BLOCK', '1.0.0', 0, 0, 0, 0, 0, 100);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('EXACT_BLOCK', 100);
            assert.strictEqual(enabled, true);
        });

        it('should return false when block_time is before activation time', async function () {
            pc.addChange('LATE_TIME', '1.0.0', 0, 0, 2000000000, 0, 0, 0);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('LATE_TIME', 100);
            assert.strictEqual(enabled, false);
        });

        it('should handle getBlockTime errors gracefully', async function () {
            indexer.decoderDb.getBlockTime.rejects(new Error('DB error'));
            const enabled = await pc.isEnabled('SEND', 100);
            assert.strictEqual(enabled, false);
        });

        it('should check version major/minor/revision correctly', async function () {
            // Current version is 1.0.0
            pc.addChange('V1_1', '1.1.0', 0, 0, 0, 0, 0, 0);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('V1_1', 100);
            // 1.1.0 > 1.0.0 → disabled (minor version too high)
            assert.strictEqual(enabled, false);
        });

        it('should enable when current version exceeds required', async function () {
            process.env.npm_package_version = '2.0.0';
            // Recreate to pick up new version
            pc = new ProtocolChanges(indexer);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('SEND', 100);
            assert.strictEqual(enabled, true);
        });
    });
});
