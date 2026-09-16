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
// CROSS_SETTLE action handler: the guards a signed cross-chain match must pass
// before anything settles (payload, network scope, snapshot, signature quorum,
// this chain as a leg, the local offer). Settlement, ORDER legs, cross-chain
// royalty and absent-leg dismissal live beside this file in cross_settle.test/.
// Every block in every file opens the same 'Cross_Settle action handler
// @regression @tier1' describe, so each full test title is the one the suite
// always had; cross_settle.test/helpers/cross_settle_harness.js holds the signers,
// match builders and mock harness they all run on.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { genValidator, signCanonical, makeMatch, signMatch, snapFor, makeData, useCrossSettleHarness } = require('./cross_settle.test/helpers/cross_settle_harness.js');

// The harness under test. useCrossSettleHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    // ─── Guard: no MATCH payload ──────────────────────────────────────────
    it('returns early when no MATCH is present', async function () {
        await handler.parse(null, makeData(), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Guard: network scope ─────────────────────────────────────────────
    it('skips a match signed on a different network', async function () {
        const match = makeMatch({ network: 'mainnet' });
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Guard: capability snapshot not yet mirrored (N === 0) ────────────
    it('defers when no cross_chain validators are snapshotted (N=0)', async function () {
        const match = makeMatch();
        indexer.indexerDb.getValidatorsByCapability.resolves([]);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Guard: insufficient valid signatures ─────────────────────────────
    it('skips when there are zero valid signatures', async function () {
        const { match, validators } = signMatch(makeMatch(), 0);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 4)); // N=4 → quorum 3
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('rejects malformed pubkey/sig and duplicate signers', async function () {
        const match = makeMatch();
        const canonical = handler.canonical(match);
        const v = genValidator();
        const goodSig = signCanonical(v.privateKey, canonical);
        // 1 valid signer, but duplicated + a malformed entry : only counts once,
        // below quorum 3 for N=4.
        match.validator_signatures = JSON.stringify([
            { pubkey: v.pubkey, sig: goodSig },
            { pubkey: v.pubkey, sig: goodSig },          // duplicate pk : skipped
            { pubkey: 'zz', sig: 'short' },              // malformed : skipped
        ]);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 4));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('skips a signer whose pubkey lacks the cross_chain capability', async function () {
        const { match } = signMatch(makeMatch(), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]); // N=1 → quorum 1
        indexer.indexerDb.hasCapability.resolves(false);            // strip the only sig
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });
});

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    it('rejects a tampered match (signature no longer verifies)', async function () {
        const { match } = signMatch(makeMatch(), 1);
        match.a_amount = '999999'; // mutate after signing → canonical changes
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('handles non-JSON validator_signatures without throwing', async function () {
        const match = makeMatch({ validator_signatures: 'not-json' });
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Guard: not this chain's match ────────────────────────────────────
    it('returns when neither leg is this chain', async function () {
        const { match } = signMatch(makeMatch({ a_chain: 'LTC', b_chain: 'DOGE' }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.getSwapInfo.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Guard: local offer missing / not open ────────────────────────────
    it('skips when the local offer is not found', async function () {
        const { match } = signMatch(makeMatch(), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        indexer.indexerDb.getSwapInfo.resolves(null);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('records a NO-OP settlement (no funds) when the local offer is no longer open', async function () {
        const { match } = signMatch(makeMatch(), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        indexer.indexerDb.getSwapInfo.resolves({ SOURCE: 'x', SWAP_STATUS: 'complete' });
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        // The record stops the match re-evaluating every block; it is anchored to a
        // real internal action row so a reorg drops it and the match re-applies.
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnceWith(777, match, 42));
        assert.strictEqual(data['STATUS'], 'valid');
        // ...but no funds move and the offer status is untouched.
        assert.ok(indexer.indexerDb.createEscrow.notCalled);
        assert.ok(indexer.indexerDb.createCredit.notCalled);
        assert.ok(indexer.indexerDb.createSwapStatus.notCalled);
    });
});
