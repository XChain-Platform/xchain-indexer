/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * runControllerGuard: guard return-value (royalty payoutLegs) parsing.
 *
 * REGRESSION GUARD for a real bug: vm.execute() returns `returnValue` as a
 * JSON-SERIALIZED STRING (the contract wrapper JSON-stringifies the contract's
 * return inside the isolate), but runControllerGuard read it as an object
 * (`typeof ret === 'object'`), so the payoutLegs branch was dead code and the
 * guard's royalty/fee legs were silently dropped (Phase D royalty was a no-op).
 * The original royalty unit test fed a mock returnValue as an OBJECT, so it
 * never exercised the real string shape (mock-vs-reality). This pins the string
 * path end-to-end through runControllerGuard. Pure (fakes the VM + DB); runs on
 * any Node.
 ********************************************************************/

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');
const Execute = require('../../src/actions/execute.js');

describe('runControllerGuard: guard returnValue parsing (royalty payoutLegs) @regression @tier1', function () {

    // A valid regtest (BTC) P2PKH address so isCryptoAddress() accepts the leg.
    const ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

    function buildHandler(vmResult, manifest = null) {
        const indexer = createMockIndexer();
        const db = indexer.indexerDb;
        db.getContract               = sinon.stub().resolves({ code: 'module.exports={guard:function(){}};', status_id: 7 });
        // Phase E: per-contract manifest (null = no declared manifest → unrestricted, global cap).
        db.getContractPermissions    = sinon.stub().resolves(manifest);
        db.getStatusString           = sinon.stub().resolves('valid');
        db.getContractState          = sinon.stub().resolves({});
        db.getOracleDataForVM        = sinon.stub().resolves({});
        db.getCrossChainDataForVM    = sinon.stub().resolves({});
        db.getContractStakeDataForVM = sinon.stub().resolves({});
        // Present in the current working tree (getBalance support); harmless if absent.
        db.buildVmBalancesAndTokenInfo = sinon.stub().resolves({ balances: {}, tokenInfo: {} });
        db.createSavepoint           = sinon.stub().resolves('sp');
        db.releaseSavepoint          = sinon.stub().resolves();
        db.rollbackToSavepoint       = sinon.stub().resolves();
        db.createContractState       = sinon.stub().resolves();
        db.createContractEmission    = sinon.stub().resolves();
        // The guard writes a parent contract_executions row so its emissions resolve through the
        // contract_hash INNER JOIN; doQuery backs the per-action emission-position offset.
        db.createContractExecution   = sinon.stub().resolves();
        db.doQuery                   = sinon.stub().resolves([{ cnt: 0 }]);
        indexer.vm    = { execute: sinon.stub().resolves(vmResult) };
        indexer.hubDb = null;
        return new Execute(indexer);
    }

    const opts = () => ({
        actionType: 'ORDER_CREATE', controllerIndex: 5, tick: 'TOK',
        from: ADDR, to: '', amount: '100', price: '100', proceedsTick: 'PAY',
        hostData: { ACTION_INDEX: 10, BLOCK_INDEX: 100, BLOCK_TIME: 1700000000,
                    SOURCE: ADDR, TX_HASH: 'aa', TX_INDEX: 1, TX_VOUT: 0 },
        callDepth: 0, seq: 0,
    });

    const vmOk = (returnValue) => ({
        success: true, error: null, gasUsed: 100, returnValue,
        stateChanges: [], stateDeletes: [], emittedActions: [], logs: [],
    });

    it('parses payoutLegs from a JSON-STRING returnValue (the real VM shape)', async function () {
        // This is exactly what vm.execute() emits: a serialized string, NOT an object.
        const handler = buildHandler(vmOk(JSON.stringify({ payoutLegs: [{ to: ADDR, bps: 250 }, { to: ADDR, bps: 100 }] })));
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, true, 'guard allows the listing');
        assert.ok(Array.isArray(res.payoutLegs), 'payoutLegs is parsed from the string returnValue (regression: was null)');
        assert.strictEqual(res.payoutLegs.length, 2);
        assert.deepStrictEqual(res.payoutLegs, [{ to: ADDR, bps: 250 }, { to: ADDR, bps: 100 }]);
    });

    it('returns null payoutLegs when the guard returns no legs', async function () {
        const handler = buildHandler(vmOk(JSON.stringify({})));
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, true);
        assert.strictEqual(res.payoutLegs, null);
    });

    it('denies (fail-closed) on a malformed payout leg', async function () {
        const handler = buildHandler(vmOk(JSON.stringify({ payoutLegs: [{ to: 'not-an-address', bps: 250 }] })));
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, false, 'a bad leg denies the action');
        assert.ok(/payout leg/.test(res.reason || ''), 'reason names the bad leg');
    });

    it('denies when the total take exceeds CONTROLLER_MAX_TAKE_BPS', async function () {
        const handler = buildHandler(vmOk(JSON.stringify({ payoutLegs: [{ to: ADDR, bps: 9000 }, { to: ADDR, bps: 2000 }] })));
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, false, 'Σbps > cap denies');
        assert.ok(/cap|payout/.test(res.reason || ''));
    });

    // ---- Phase E: per-contract maxTakeBps tightens the effective cap ----

    it('denies legs over a TIGHTER per-contract maxTakeBps (under the global cap)', async function () {
        // Σbps = 500, well under the global 10000, but the contract's manifest caps at 300.
        const handler = buildHandler(
            vmOk(JSON.stringify({ payoutLegs: [{ to: ADDR, bps: 300 }, { to: ADDR, bps: 200 }] })),
            { permissions: null, maxTakeBps: 300 }
        );
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, false, 'per-contract maxTakeBps tightens the cap');
        assert.ok(/cap|payout/.test(res.reason || ''));
    });

    it('allows legs within a tighter per-contract maxTakeBps', async function () {
        // Σbps = 250 <= the manifest cap 300 → allowed, legs preserved.
        const handler = buildHandler(
            vmOk(JSON.stringify({ payoutLegs: [{ to: ADDR, bps: 250 }] })),
            { permissions: null, maxTakeBps: 300 }
        );
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, true, 'within the tighter cap is allowed');
        assert.deepStrictEqual(res.payoutLegs, [{ to: ADDR, bps: 250 }]);
    });

    it('a per-contract maxTakeBps cannot RELAX the global cap', async function () {
        // Manifest declares 10000 but Σbps = 11000 still exceeds the global 10000; the
        // effective cap is min(global, per-contract), never the looser of the two.
        const handler = buildHandler(
            vmOk(JSON.stringify({ payoutLegs: [{ to: ADDR, bps: 9000 }, { to: ADDR, bps: 2000 }] })),
            { permissions: null, maxTakeBps: 10000 }
        );
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, false, 'global cap still binds');
        assert.ok(/cap|payout/.test(res.reason || ''));
    });
});
