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

// Utility loads coin config in its constructor from these env vars.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');
const Actions = require('../../src/actions.js');

// Build a minimal Actions-like context exposing the real computeFeeQuoteDryRun prototype method
// plus stubbed dependencies. processTransaction and computeFeeQuote are stubbed so the test never
// touches a real DB or handler chain; the transaction-mutex calls (beginTransaction /
// rollbackTransaction) are recorded so we can assert the dry-run always opens and rolls back
// exactly one transaction.
function makeCtx({ addressId = 7, status = 'valid', processThrows = false, processHangs = false, feeQuote } = {}){
    let calls = { begin: 0, rollback: 0, processed: null };
    let util  = new Utility();
    let ctx = {
        util,
        // The dry-run bounds processTransaction with the block-loop watchdog timeout.
        config: { BLOCK_PROCESS_TIMEOUT: 300000 },
        _calls: calls,
        indexerDb: {
            getAddressId:        async () => addressId,
            getLatestBlockIndex: async () => 100,
            getBlockTime:        async () => 1000,
            beginTransaction:    async () => { calls.begin++; },
            rollbackTransaction: async () => { calls.rollback++; }
        },
        // Stubbed: returns a fixed native-fee quote (the real one is unit-tested in feeQuote.test.js).
        computeFeeQuote: async () => (feeQuote !== undefined ? feeQuote : {
            supported: true, valid: true, action: 'ISSUE', coin: 'BTC',
            xchainFee: '1.00000000', requiredFeeNative: '0.00002000', requiredFeeSats: 2000
        }),
        // Stubbed handler run: records the synthetic tx and stamps STATUS like a real handler.
        processTransaction: async (tx) => {
            calls.processed = tx;
            if(processThrows) throw new Error('boom');
            if(processHangs) return new Promise(() => {});   // never resolves: the watchdog must fire
            return { STATUS: status };
        }
    };
    return { ctx, calls };
}

function run(ctx, args){ return Actions.prototype.computeFeeQuoteDryRun.call(ctx, args); }

describe('computeFeeQuoteDryRun', () => {

    it('valid action: STATUS=valid -> valid:true, fee fields merged, one balanced transaction', async () => {
        let { ctx, calls } = makeCtx({ status: 'valid' });
        let r = await run(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK', '1000'], source: 'src1' });
        assert.strictEqual(r.dryRun, true, 'dryRun flag set');
        assert.strictEqual(r.valid, true, 'valid status -> valid:true');
        assert.strictEqual(r.error, null, 'no error on valid');
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(r.feeSupported, true, 'fee supported merged from computeFeeQuote');
        assert.strictEqual(r.requiredFeeNative, '0.00002000', 'native fee merged');
        assert.strictEqual(calls.begin, 1, 'one transaction opened');
        assert.strictEqual(calls.rollback, 1, 'one rollback (never persists)');
        assert.strictEqual(calls.processed.data, 'ISSUE|0|NEWTOK|1000', 'action string reassembled');
        assert.ok(String(calls.processed.tx_hash).startsWith('DRYRUN-'), 'tx_hash marked DRYRUN');
        assert.strictEqual(calls.processed.block_index, 100, 'synthetic tx anchored at tip');
    });

    it('class-B invalid: handler stamps an invalid STATUS the estimator could never produce', async () => {
        let { ctx, calls } = makeCtx({ status: 'invalid: insufficient funds' });
        let r = await run(ctx, { action: 'SEND', params: ['0', 'TOK', '999', 'dest'], source: 'src1' });
        assert.strictEqual(r.valid, false, 'invalid status -> valid:false');
        assert.strictEqual(r.status, 'invalid: insufficient funds');
        assert.strictEqual(r.error, 'invalid: insufficient funds', 'error carries the handler reason');
        assert.strictEqual(calls.begin, 1);
        assert.strictEqual(calls.rollback, 1, 'invalid action still rolls back');
    });

    it('bounds a hung handler with the block-loop watchdog and releases the lock (item 4758)', async () => {
        let { ctx, calls } = makeCtx({ processHangs: true });
        ctx.config = { BLOCK_PROCESS_TIMEOUT: 50 };   // tiny timeout so the watchdog fires fast
        let r = await run(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK', '1000'], source: 'src1' });
        assert.strictEqual(r.valid, false, 'a watchdog-timed-out dry-run is not valid');
        assert.ok(/timeout|exceeded/i.test(r.error), 'error reports the watchdog timeout: ' + r.error);
        assert.strictEqual(calls.begin, 1, 'one transaction opened');
        assert.strictEqual(calls.rollback, 1, 'lock released via rollback once the watchdog fires (no indefinite wedge)');
    });

    it('unindexed source: refused before any transaction is opened (AUTO_INCREMENT-skew mitigation)', async () => {
        let { ctx, calls } = makeCtx({ addressId: null });
        let r = await run(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK', '1000'], source: 'unknownsrc' });
        assert.strictEqual(r.dryRun, false, 'not run when source is unindexed');
        assert.strictEqual(r.valid, false);
        assert.ok(/not indexed/.test(r.error), 'error explains unindexed source');
        assert.strictEqual(calls.begin, 0, 'no transaction opened for an unindexed source');
        assert.strictEqual(calls.rollback, 0);
    });

    it('handler throws: rollback still runs in finally (no lock leak)', async () => {
        let { ctx, calls } = makeCtx({ processThrows: true });
        let r = await run(ctx, { action: 'EXECUTE', params: ['0', 'c'], source: 'src1' });
        assert.strictEqual(r.valid, false, 'throw -> not valid');
        assert.ok(/handler threw/.test(r.error), 'error reports the throw');
        assert.strictEqual(calls.begin, 1, 'transaction was opened');
        assert.strictEqual(calls.rollback, 1, 'rollback runs in finally even on throw');
    });

    it('missing source: treated like an unindexed source, no transaction opened', async () => {
        let { ctx, calls } = makeCtx({});
        let r = await run(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK', '1000'], source: null });
        assert.strictEqual(r.dryRun, false);
        assert.strictEqual(r.valid, false);
        assert.strictEqual(calls.begin, 0, 'no transaction without a source');
    });

});
