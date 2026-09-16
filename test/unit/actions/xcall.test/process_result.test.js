// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// XCALL mirror-driven result delivery (processResult). Part of the XCALL
// suite; see ../xcall.test.js, whose describe title each block here repeats so
// every full test title is unchanged.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

// Same module instance Xcall holds a reference to; stubbing `verify` here
// controls signature acceptance inside processResult.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const eq      = require('../../../../src/equivocation_header.js');

const {
    PUBKEY_A, SIG_A, freshXcall, makeRequestRow, makeResultRow, ctx,
} = require('./helpers/xcall_fixtures.js');

let indexer, handler, executeStub;

function freshHandler() {
    ({ indexer, handler, executeStub } = freshXcall());
}

function restoreStubs() {
    sinon.restore();
}

// ───────────────────────────────────────────────────────────────────────
// processResult: mirror-driven result delivery
// ───────────────────────────────────────────────────────────────────────
describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('processResult', function () {
        it('verifies sigs, flips to completed, injects the callback with the decoded payload', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            const data = ctx();
            await handler.processResult(makeResultRow(), data);
            const flip = indexer.indexerDb.updateCrossChainCallRequestStatus;
            assert.ok(flip.calledOnceWith('c'.repeat(64), 'completed', 'ok', '"42"', 200));
            assert.ok(flip.calledBefore(executeStub.parse));
            const cbParams = executeStub.parse.firstCall.args[0];
            assert.deepStrictEqual(cbParams.slice(3), ['c'.repeat(64), 'DOGE', 'ok', '"42"', 'ctx']);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.calledOnceWith(
                sinon.match.any, 'c'.repeat(64), 'ok', 200));
        });

        it('the signed canonical binds result_status + payload hash (sig verified over the exact string)', async function () {
            const stub = sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            const row = makeResultRow();
            await handler.processResult(row, ctx());
            const expectedRaw = [
                'XCALL', 'RESULT', row.call_id, '150', 'regtest', 'DOGE', 'ok',
                crypto.createHash('sha256').update(row.return_payload_b64, 'utf8').digest('hex'),
                '1700000000'
            ].join('|');
            // EQUIV active in regtest: TAG=XCALL, ROUND_ID=sha256('XCALLROUND|result|'+call_id), VIEW=0.
            const expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL,
                crypto.createHash('sha256').update('XCALLROUND|result|' + row.call_id, 'utf8').digest('hex'), 0, expectedRaw);
            assert.strictEqual(stub.firstCall.args[0], expected);
        });
    });
});

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('processResult', function () {
        it('a garbage-then-valid duplicate for one signer still completes (seen marked AFTER verify; hub/SDK parity)', async function () {
            // Two equal-weight validators: 3*tally > 2*S needs BOTH (3*100 = 300 <= 400).
            // Prepend an INVALID entry for B before its genuine one: marking "seen" on
            // first encounter (the pre-fix order) would suppress B's real signature and
            // skip a legitimately-quorate result (order-dependent quorum under-count).
            const PUBKEY_B = 'b'.repeat(64);
            const SIG_B    = '2'.repeat(128);
            const BADSIG   = '0'.repeat(128);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                { pubkey: PUBKEY_A, source: 'S1', weight: '100' },
                { pubkey: PUBKEY_B, source: 'S2', weight: '100' },
            ]);
            sinon.stub(ed25519, 'verify').callsFake((canon, sig, pk) => sig !== BADSIG);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            const row = makeResultRow({ validator_signatures: JSON.stringify([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: BADSIG },   // garbage first
                { pubkey: PUBKEY_B, sig: SIG_B },    // genuine second
            ]) });
            await handler.processResult(row, ctx());
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.calledOnceWith(
                'c'.repeat(64), 'completed', 'ok', '"42"', 200));
        });

        it('refuses insufficient signatures (nothing flips, nothing injects, NO idempotency row)', async function () {
            sinon.stub(ed25519, 'verify').returns(false);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.notCalled);
            assert.ok(executeStub.parse.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.notCalled);
        });
    });
});

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('processResult', function () {
        it('defers (no idempotency row) when the capability snapshot is not mirrored yet', async function () {
            // Empty BOTH sets; the stake-weighted branch (active on regtest) reads
            // getStakeWeightsByCapability; clearing only the legacy set would not defer.
            indexer.indexerDb.getValidatorsByCapability.resolves([]);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([]);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.notCalled);
        });

        it('records a skip (exactly-once interlock) when the request already expired', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow({ request_status: 'expired' }));
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(executeStub.parse.notCalled);
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.calledOnceWith(
                sinon.match.any, 'c'.repeat(64), 'skipped:expired', 200));
        });
    });
});

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('processResult', function () {
        it('skips a result whose target_chain does not match the local request (forged routing)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow({ target_chain: 'LTC' }));
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(executeStub.parse.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.notCalled);
        });

        it('skips a result for an unknown call_id', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(null);
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(executeStub.parse.notCalled);
        });

        it('skips a result for another network (belt-and-suspenders)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            await handler.processResult(makeResultRow({ network: 'mainnet' }), ctx());
            assert.ok(executeStub.parse.notCalled);
        });

        it('a failing callback does not undo the flip or the idempotency row', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            executeStub.parse.rejects(new Error('callback exploded'));
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.calledOnce);
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);   // callback savepoint only
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.calledOnce);
        });
    });
});
