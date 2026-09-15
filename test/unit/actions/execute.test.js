// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The EXECUTE handler's validation and fee gates. The VM, emission, slash and
// cross-contract suites are the parts in execute.test/, over the shared fixture
// in execute.test/helpers/fixture.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { CONTRACT, executeData, buildExecute } = require('./execute.test/helpers/fixture.js');

// Rebuilt by setUp before every test. Module-level so the same-title sibling
// suites below, split only to fit the function-length limit with every full
// test title unchanged, share one fixture.
let indexer, actionsCtx, handler;

function setUp() {
    ({ indexer, actionsCtx, handler } = buildExecute());
}

function tearDown() {
    sinon.restore();
}

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── Format validation ────────────────────────────────────────────────

    describe('format validation', function () {

        it('rejects unknown VERSION', async function () {
            const data = executeData({ FORMAT: 9 });
            await handler.parse(['9', String(CONTRACT), 'run', 'arg1'], data, null);
            assert.ok(String(data['STATUS']).includes('VERSION'));
        });

        it('accepts FORMAT 0', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });
});

// ─── Contract validations ─────────────────────────────────────────────
describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);
    describe('contract validations', function () {
        it('rejects missing CONTRACT_ACTION_INDEX', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', '', 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX'));
        });

        it('rejects a non-numeric CONTRACT_ACTION_INDEX as (format), not a crash', async function () {
            // Regression twin of stake/deposit.test.js: without this check, junk here
            // reaches the BIGINT row write and wedges block processing under strict SQL mode.
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', 'null', 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX (format)'));
        });

        // a leading-zero index passed the old /^\d+$/ gate, resolved to the same
        // contract through the integer-coercing DB lookup, then hashed two different ways:
        // the VM Number()s it into the attestation request_id preimage while the host
        // re-hashes the raw EMITTER string, so the host rejected an ATTEST the VM accepted.
        // Gated on CONTRACT_INDEX_CANONICAL, the flag-day STAKE/UNSTAKE/DELEGATE already use
        // for the same index-canonicality tightening.
        it('rejects a leading-zero CONTRACT_ACTION_INDEX at/after CONTRACT_INDEX_CANONICAL', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', '007', 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX (format)'));
        });

        it('rejects a CONTRACT_ACTION_INDEX past the safe-integer range', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', '9007199254740993', 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX (format)'));
        });

        it('still accepts a canonical CONTRACT_ACTION_INDEX at/after the flag-day', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('preserves the legacy /^\\d+$/ gate below CONTRACT_INDEX_CANONICAL', async function () {
            // Byte-identical replay below the flag-day: a leading-zero index stays valid
            // there, so an old block re-indexes to the status it originally recorded.
            indexer.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
                name !== 'CONTRACT_INDEX_CANONICAL');
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', '007', 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects when contract does not exist', async function () {
            indexer.indexerDb.getContract.resolves(null);
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX'));
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('contract validations', function () {
        it('rejects when contract is not active', async function () {
            indexer.indexerDb.getStatusString.resolves('invalid');
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('not active'));
        });

        it('rejects missing METHOD', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), '', ''], data, null);
            assert.ok(String(data['STATUS']).includes('METHOD'));
        });

    });

    // ─── SOURCE sleeping ──────────────────────────────────────────────────

    describe('source sleeping', function () {

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('no VM configured: fail closed, never a committed no-op', function () {

        // A node whose require('xchain-vm') failed used to record this EXECUTE
        // 'valid' with base gas and no state changes while the rest of the fleet
        // applied real ones - a host-condition-induced ledger fork. It must now
        // halt the block instead, exactly as DEPLOY does.
        it('throws EXECUTOR_UNAVAILABLE instead of committing a valid no-op', async function () {
            delete actionsCtx.vm;
            const data = executeData({ FORMAT: 0 });
            await assert.rejects(
                handler.parse(['0', String(CONTRACT), 'run', ''], data, null),
                (e) => e && e.code === 'EXECUTOR_UNAVAILABLE',
                'a VM-less EXECUTE must halt the block, not commit a no-op'
            );
            assert.ok(indexer.indexerDb.createContractExecution.notCalled,
                'no execution row may be written when the executor is unavailable');
        });

        // The gate is scoped to runs that would otherwise reach the VM: an EXECUTE
        // already rejected by a VM-independent rule still records the same verdict
        // a healthy node records, so a VM-less node does not halt on it.
        it('does not fire when the run already failed a VM-independent rule', async function () {
            delete actionsCtx.vm;
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });

    // ─── Valid execution (no VM) ──────────────────────────────────────────

    describe('valid execution commit path', function () {

        it('createContractExecution always called', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createContractExecution.calledOnce);
        });

        it('updateBalances and updateTokens called after parse', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('mapper.createMappings called after parse', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── Gas-fee payment modes (fee > 0) ──────────────────────────────────
    // The default suite runs with GAS_PRICE=0 (fee skipped). Raising GAS_PRICE makes
    // fee = VM_EXECUTE_BASE * GAS_PRICE > 0, driving the native/xchain fee branch. The
    // rejected/invalid paths set `error` and short-circuit BEFORE VM execution, so they
    // are deterministic without a live VM.
    describe('gas-fee payment modes', function () {

        beforeEach(function () {
            indexer.config['GAS_PRICE'] = '0.00000100'; // fee = base * price > 0
        });

        it('rejects when a native-coin fee output is required but absent (rejected)', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            const data = executeData();
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient fee (native coin output required)');
        });

        it('rejects an invalid native-coin fee', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'underpaid' });
            const data = executeData();
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('accepts a valid native-coin fee and records the native-coin metadata', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            const valStub = sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true, nativeCoinAmount: '0.0005', nativeCoin: 'BTC', oracleRound: 5,
            });
            const data = executeData();
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(valStub.called);
            // native-coin metadata is stamped on the action before VM execution
            assert.strictEqual(data['NATIVE_COIN'], 'BTC');
            assert.strictEqual(data['NATIVE_COIN_AMOUNT'], '0.0005');
            assert.strictEqual(data['ORACLE_ROUND'], 5);
        });

        it('rejects when SOURCE lacks the XCHAIN gas balance', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('xchain');
            indexer.indexerDb.getAddressBalances.resolves({ 1: '0' }); // no GAS balance
            const data = executeData();
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (GAS)');
        });
    });
});
