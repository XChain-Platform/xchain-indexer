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

        it('should propagate getBlockTime errors (a DB fault must not read as disabled)', async function () {
            indexer.decoderDb.getBlockTime.rejects(new Error('DB error'));
            await assert.rejects(() => pc.isEnabled('SEND', 100), /DB error/);
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

    // ─── DEPLOY_BASE64_CODE — the consensus anti-fork gate ───────────────────
    // The inline-DEPLOY base64 cutover. A regression in its registration — a zeroed
    // or wrong mainnet flag-day, regtest/testnet flipped off genesis, or the version
    // bumped past the shipping node — silently changes how historical CODE_ENCODING
    // decodes → code_hash → contract_hash → the federation checkpoint, forking the
    // ledger. deploy.test.js stubs isEnabled(), so ONLY this block guards the REAL
    // registration. Keep these assertions in lockstep with protocol_changes.js.
    describe('DEPLOY_BASE64_CODE activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1798761600; // 2027-01-01 00:00:00 UTC — PLACEHOLDER (see protocol_changes.js)

        // The constructor reads INDEXER_NETWORK + npm_package_version fresh, so a new
        // instance per network/version is all that's needed (no module-cache reset).
        function pcFor(network, version = '2.0.0') {
            process.env.npm_package_version = version; // shipping consensus version
            process.env.INDEXER_NETWORK = network;
            return new ProtocolChanges(indexer);
        }

        it('is registered as a v2.0.0 change keyed on block_time, not block_index', function () {
            const change = pcFor('regtest').changes['DEPLOY_BASE64_CODE'];
            assert.ok(change, 'DEPLOY_BASE64_CODE must be defined');
            assert.strictEqual(change.version_major, 2);
            assert.strictEqual(change.version_minor, 0);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed (BTC/LTC/DOGE heights diverge by millions of blocks); all block gates stay 0.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            // testnet/regtest activate at genesis; mainnet on the coordinated flag-day.
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
            assert.strictEqual(change.mainnet_time, MAINNET_FLAG_DAY,
                'mainnet flag-day must match protocol_changes.js — a wrong value is a second fork');
        });

        it('regtest: enabled from genesis (every block decodes base64)', async function () {
            const pc2 = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1); // earliest plausible regtest block_time
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 0), true);
        });

        it('testnet: enabled from genesis', async function () {
            const pc2 = pcFor('testnet');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 0), true);
        });

        it('mainnet: DISABLED one second below the flag-day (historical DEPLOYs stay hex)', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY - 1);
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 100), false);
        });

        it('mainnet: ENABLED at exactly the flag-day boundary', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY);
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 100), true);
        });

        it('mainnet: ENABLED above the flag-day', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY + 86400);
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 100), true);
        });

        it('a pre-consensus (v1.x) node treats it as not-yet-active — no premature base64', async function () {
            const pc1 = pcFor('regtest', '1.9.9');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc1.isEnabled('DEPLOY_BASE64_CODE', 0), false,
                'below the 2.0.0 consensus version the gate is inactive — decode stays hex');
        });
    });

    // ─── VM_BALANCE_TOKENINFO — the consensus anti-fork gate ─────────────────
    // The VM getBalance()/getTokenInfo() reader. Below activation the gateway sees
    // balances:null / tokenInfo:null (original ≤2.7.10 behaviour); at/above it the
    // indexer feeds the buildVmBalancesAndTokenInfo snapshot. A regression in its
    // registration — a zeroed/wrong mainnet flag-day, regtest/testnet flipped off
    // genesis, or the version bumped past the shipping node — silently changes the
    // VM input on the first balance-reading contract → gas_used / emitted_count /
    // ledger movement → contract_hash → the federation checkpoint, forking the
    // ledger even within the 2.x line (2.2.0–2.7.10 lack the reader; 2.7.11+ have
    // it). execute.js/deploy.js call the REAL isEnabled() at all three VM call sites
    // (EXECUTE primary, EXECUTE controller-guard, DEPLOY constructor), so this block
    // guards the registration the call sites depend on. Keep in lockstep with
    // protocol_changes.js.
    describe('VM_BALANCE_TOKENINFO activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1798761600; // 2027-01-01 00:00:00 UTC — PLACEHOLDER (see protocol_changes.js)

        function pcFor(network, version = '2.0.0') {
            process.env.npm_package_version = version; // shipping consensus version
            process.env.INDEXER_NETWORK = network;
            return new ProtocolChanges(indexer);
        }

        it('is registered as a v2.0.0 change keyed on block_time, not block_index', function () {
            const change = pcFor('regtest').changes['VM_BALANCE_TOKENINFO'];
            assert.ok(change, 'VM_BALANCE_TOKENINFO must be defined');
            assert.strictEqual(change.version_major, 2);
            assert.strictEqual(change.version_minor, 0);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed (BTC/LTC/DOGE heights diverge by millions of blocks); all block gates stay 0.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            // testnet/regtest activate at genesis; mainnet on the coordinated flag-day.
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
            assert.strictEqual(change.mainnet_time, MAINNET_FLAG_DAY,
                'mainnet flag-day must match protocol_changes.js — a wrong value is a fork');
        });

        it('regtest: enabled from genesis (gateway gets real balances/token-info)', async function () {
            const pc2 = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1); // earliest plausible regtest block_time
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 0), true);
        });

        it('testnet: enabled from genesis', async function () {
            const pc2 = pcFor('testnet');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 0), true);
        });

        it('mainnet: DISABLED one second below the flag-day (gateway still sees null)', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY - 1);
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 100), false);
        });

        it('mainnet: ENABLED at exactly the flag-day boundary', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY);
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 100), true);
        });

        it('mainnet: ENABLED above the flag-day', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY + 86400);
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 100), true);
        });

        it('a pre-reader (v1.x) node treats it as not-yet-active — gateway stays null', async function () {
            const pc1 = pcFor('regtest', '1.9.9');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc1.isEnabled('VM_BALANCE_TOKENINFO', 0), false,
                'below the 2.0.0 consensus version the gate is inactive — gateway sees null');
        });
    });

    // ─── CONTROLLER_GUARD — the consensus anti-fork gate ─────────────────────
    // The programmable-policy controller guard. Below activation the bound controller's
    // `guard` method is NEVER run — every SEND/ORDER/SWAP/DISPENSER/DESTROY on a controlled
    // token settles with plain semantics, no allow/deny veto, no royalty payout_legs, no guard
    // contract_executions row — exactly like a node that lacks the controller layer. At/above
    // it the shared chokepoint (_invokeController) runs the guard, may DENY, and may attach
    // payout_legs the match-time split applies. A regression in its registration — a zeroed/
    // wrong mainnet flag-day, regtest/testnet flipped off genesis, or the version bumped past
    // the shipping node — makes a controller-layer node and a non-controller node settle the
    // SAME guarded action differently → ledger + per-block contract_hash → federation
    // checkpoint, forking on the first guarded action. utility.js _invokeController calls the
    // REAL isEnabled() at the single shared chokepoint, so this block guards the registration
    // that gate depends on. Keep in lockstep with protocol_changes.js.
    describe('CONTROLLER_GUARD activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1798761600; // 2027-01-01 00:00:00 UTC — PLACEHOLDER (see protocol_changes.js)

        function pcFor(network, version = '2.0.0') {
            process.env.npm_package_version = version; // shipping consensus version
            process.env.INDEXER_NETWORK = network;
            return new ProtocolChanges(indexer);
        }

        it('is registered as a v2.0.0 change keyed on block_time, not block_index', function () {
            const change = pcFor('regtest').changes['CONTROLLER_GUARD'];
            assert.ok(change, 'CONTROLLER_GUARD must be defined');
            assert.strictEqual(change.version_major, 2);
            assert.strictEqual(change.version_minor, 0);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed (BTC/LTC/DOGE heights diverge by millions of blocks); all block gates stay 0.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            // testnet/regtest activate at genesis; mainnet on the coordinated flag-day.
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
            assert.strictEqual(change.mainnet_time, MAINNET_FLAG_DAY,
                'mainnet flag-day must match protocol_changes.js — a wrong value is a fork');
        });

        it('regtest: enabled from genesis (guard runs)', async function () {
            const pc2 = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1); // earliest plausible regtest block_time
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 0), true);
        });

        it('testnet: enabled from genesis', async function () {
            const pc2 = pcFor('testnet');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 0), true);
        });

        it('mainnet: DISABLED one second below the flag-day (guard is a strict no-op)', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY - 1);
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 100), false);
        });

        it('mainnet: ENABLED at exactly the flag-day boundary', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY);
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 100), true);
        });

        it('mainnet: ENABLED above the flag-day', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY + 86400);
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 100), true);
        });

        it('a pre-guard (v1.x) node treats it as not-yet-active — guard stays off', async function () {
            const pc1 = pcFor('regtest', '1.9.9');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc1.isEnabled('CONTROLLER_GUARD', 0), false,
                'below the 2.0.0 consensus version the gate is inactive — guard never runs');
        });
    });
});
