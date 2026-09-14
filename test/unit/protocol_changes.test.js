// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');

// The activation gates and the consensus pins live beside this file under
// test/unit/protocol_changes.test/. Every part repeats the suite title below, so each
// full test title is unchanged.

// The registry under test and the mock indexer it reads, rebuilt before every
// test so a test that swaps pc or mutates indexer.config never leaks into the next.
let ProtocolChanges, pc, indexer;

function freshRegistry() {
    indexer = createMockIndexer();
    // Set version for the indexer package
    process.env.INDEXER_NETWORK = 'regtest';
    ProtocolChanges = require('../../src/protocol_changes.js');
    // Consensus version is passed explicitly now that it is a compiled pin.
    pc = new ProtocolChanges(indexer, '0.1.0');
}

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

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
            assert.strictEqual(change.version_major, 0);
            assert.strictEqual(change.version_minor, 1);
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
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

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
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('isDefined()', function () {
        it('should return true for defined actions', function () {
            assert.strictEqual(pc.isDefined('SEND'), true);
            assert.strictEqual(pc.isDefined('ISSUE'), true);
            assert.strictEqual(pc.isDefined('BET'), true); // BET registered, genesis-active
        });

        it('should return false for undefined actions', function () {
            assert.strictEqual(pc.isDefined('FAKEACTION'), false);
            assert.strictEqual(pc.isDefined('NONEXISTENT'), false);
        });

        it('should be case sensitive', function () {
            assert.strictEqual(pc.isDefined('send'), false);
            assert.strictEqual(pc.isDefined('Send'), false);
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('isEnabled()', function () {
        it('should return true for actions active from block 0 (regtest)', async function () {
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('SEND', 100);
            assert.strictEqual(enabled, true);
        });

        it('should return false for undefined action', async function () {
            const enabled = await pc.isEnabled('FAKEACTION', 100);
            assert.strictEqual(enabled, false);
        });

        it('should return false when version is too high', async function () {
            pc.addChange('FUTURE_ACTION', '99.0.0', 0, 0, 0, 0, 0, 0);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('FUTURE_ACTION', 100);
            assert.strictEqual(enabled, false);
        });

        it('should return false when block_index is before activation', async function () {
            pc.addChange('LATE_ACTION', '0.1.0', 0, 0, 0, 0, 0, 999999);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('LATE_ACTION', 100);
            assert.strictEqual(enabled, false);
        });

        it('should return true when block_index equals activation block', async function () {
            pc.addChange('EXACT_BLOCK', '0.1.0', 0, 0, 0, 0, 0, 100);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('EXACT_BLOCK', 100);
            assert.strictEqual(enabled, true);
        });

        it('should return false when block_time is before activation time', async function () {
            pc.addChange('LATE_TIME', '0.1.0', 0, 0, 2000000000, 0, 0, 0);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('LATE_TIME', 100);
            assert.strictEqual(enabled, false);
        });

        it('should propagate getBlockTime errors (a DB fault must not read as disabled)', async function () {
            indexer.decoderDb.getBlockTime.rejects(new Error('DB error'));
            await assert.rejects(() => pc.isEnabled('SEND', 100), /DB error/);
        });

        it('should check version major/minor/revision correctly', async function () {
            // Current version is 0.1.0
            pc.addChange('V1_1', '0.2.0', 0, 0, 0, 0, 0, 0);
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('V1_1', 100);
            // 0.2.0 > 0.1.0 → disabled (minor version too high)
            assert.strictEqual(enabled, false);
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('isEnabled()', function () {
        it('should enable when current version exceeds required', async function () {
            // Recreate with an explicit consensus version (the pin means the
            // environment no longer supplies one).
            pc = new ProtocolChanges(indexer, '0.2.0');
            indexer.decoderDb.getBlockTime.resolves(1700000000);
            const enabled = await pc.isEnabled('SEND', 100);
            assert.strictEqual(enabled, true);
        });
    });

    // isEnabled must FAIL CLOSED on an unrecognized network. The mainnet/testnet/regtest
    // gate branches have no else, so an unknown network (unset/typo'd INDEXER_NETWORK) would
    // apply no time/block gate and leave every flag-day change enabled from genesis - a
    // mis-networked node would activate gated consensus rules early and fork the fleet.
    describe('isEnabled network fail-closed (consensus backstop)', function () {
        it('throws on an unrecognized network instead of enabling every gated change', async function () {
            indexer.config.NETWORK = 'mainnett'; // typo, from the validated config
            const bad = new ProtocolChanges(indexer, '0.2.0');
            indexer.decoderDb.getBlockTime.resolves(1);
            await assert.rejects(() => bad.isEnabled('CONTROLLER_GUARD', 100), /unrecognized network/);
        });

        it('still evaluates normally for each valid network', async function () {
            for (const net of ['mainnet', 'testnet', 'regtest']) {
                indexer.config.NETWORK = net;
                const pc2 = new ProtocolChanges(indexer, '0.2.0');
                indexer.decoderDb.getBlockTime.resolves(1);
                // SEND is genesis-active (1.0.0, all-zero gates), enabled on every valid network.
                assert.strictEqual(await pc2.isEnabled('SEND', 0), true, net + ' should evaluate');
            }
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    // Locks in: the activation gate must read its network from the validated
    // config (config.NETWORK), NOT re-read the raw process.env.INDEXER_NETWORK. Boot
    // validates the network once and stores it on config; a second env read could
    // diverge if the env is mutated post-boot, silently mis-gating consensus rules.
    describe('network source is the validated config, not process.env', function () {
        it('reads this.network from config.NETWORK even when process.env.INDEXER_NETWORK disagrees', function () {
            indexer.config.NETWORK = 'mainnet';
            process.env.INDEXER_NETWORK = 'regtest'; // stale/mutated env must be ignored
            const pc2 = new ProtocolChanges(indexer, '0.2.0');
            assert.strictEqual(pc2.network, 'mainnet');
        });

        it('gates on config.NETWORK: mainnet flag-day applies even if env still says regtest', async function () {
            const MAINNET_FLAG_DAY = 1786060800;
            indexer.config.NETWORK = 'mainnet';
            process.env.INDEXER_NETWORK = 'regtest'; // env would (wrongly) enable from genesis
            const pc2 = new ProtocolChanges(indexer, '0.2.0');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY - 1);
            // Under config.NETWORK='mainnet' the gate is DISABLED below the flag-day; a stale
            // env read would have returned true (regtest genesis-active) and forked the ledger.
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 100), false);
        });
    });
});
