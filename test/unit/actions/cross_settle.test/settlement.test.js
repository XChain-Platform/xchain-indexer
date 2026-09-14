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
// CROSS_SETTLE settlement of a swap leg: escrow release on either leg, the
// 2f+1 and majority-floor quorum thresholds, null and missing field fallbacks,
// and the ownership-transfer path. Part of the Cross_Settle suite; see
// ../cross_settle.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { makeMatch, signMatch, snapFor, makeData, useCrossSettleHarness } = require('./helpers/cross_settle_harness.js');

// The harness under test. useCrossSettleHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    // ─── Happy path: fungible escrow release (ownership = 0) ───────────────
    it('settles leg a: releases escrow to counterparty payout (N=1 quorum)', async function () {
        const { match } = signMatch(makeMatch(), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['ACTION_INDEX'], 777);
        // escrow released to b_payout_addr, swap completed + settlement recorded
        assert.ok(indexer.indexerDb.createEscrow.called);
        assert.ok(indexer.indexerDb.createCredit.called);
        assert.ok(indexer.indexerDb.createSwapStatus.calledWith(777, 42, 'complete'));
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        const recArgs = indexer.indexerDb.recordCrossChainSettlement.firstCall.args;
        assert.strictEqual(recArgs[0], 777);
        assert.strictEqual(recArgs[1], match);            // full match (legs captured at settle time)
        assert.strictEqual(recArgs[1].match_id, match.match_id);
        assert.strictEqual(recArgs[2], 42);
        assert.ok(indexer.mapper.createMappings.called);
        assert.ok(indexer.indexerDb.updateBalances.called);
    });

    it('settles leg b when this chain is the b leg', async function () {
        // a is some other chain, b is BTC (this chain) → release b's escrow to a's payout.
        const { match } = signMatch(makeMatch({
            a_chain: 'LTC', a_action_index: 11, a_payout_addr: 'LpayoutA',
            b_chain: 'BTC', b_action_index: 88, b_tick: 'BBB', b_amount: '7', b_ownership: 0,
            b_payout_addr: '1payoutBXXXXXXXXXXXXXXXXXXXXXaKc5Z',
        }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        // local action index is b_action_index (88); swap completed against it
        assert.ok(indexer.indexerDb.createSwapStatus.calledWith(777, 88, 'complete'));
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledWith(777, match, 88));
    });

    // ─── Happy path with N>1 quorum (2f+1) ────────────────────────────────
    it('requires 2f+1 signatures when N>1 and settles when met', async function () {
        const { match } = signMatch(makeMatch(), 3); // N=4 → quorum 3, exactly met
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 4));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });
});

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    it('a garbage-then-valid duplicate for one signer still settles (seen marked AFTER verify; hub/SDK parity)', async function () {
        // N=2 -> quorum 2, so BOTH signers must count. Prepend an INVALID entry for
        // the second signer before its genuine one: marking "seen" on first encounter
        // (the pre-fix order) would suppress the real signature and skip a
        // legitimately-quorate settlement (order-dependent quorum under-count).
        const { match, sigs } = signMatch(makeMatch(), 2);
        match.validator_signatures = JSON.stringify([
            sigs[0],
            { pubkey: sigs[1].pubkey, sig: '0'.repeat(128) },  // garbage first
            sigs[1],                                           // genuine second
        ]);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 2));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    // ─── Majority floor: N=3 needs 2 signatures, never 1 ──────────────────
    it('rejects a single signature at N=3 (majority floor, not bare 2f+1)', async function () {
        const { match } = signMatch(makeMatch(), 1); // 2f+1 alone would accept this
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 3));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('settles with 2 signatures at N=3 (majority floor met)', async function () {
        const { match } = signMatch(makeMatch(), 2);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 3));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    // ─── Branch: null ticks fall back to '' in canonical and the coin label ──
    it('settles a native-coin leg (a_tick null) using coin as the tick label', async function () {
        const { match } = signMatch(makeMatch({ a_tick: null, b_tick: null }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    // ─── Branch: signature entries missing pubkey/sig fields ──────────────
    it('tolerates signature entries missing pubkey/sig fields', async function () {
        const match = makeMatch();
        match.validator_signatures = JSON.stringify([{}, { pubkey: null }, { sig: null }]);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });
});

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    // ─── Branch: null validator_signatures falls back to '[]' ─────────────
    it('treats null validator_signatures as empty', async function () {
        const match = makeMatch({ validator_signatures: null });
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Branch: match with no network field, indexer also network-scoped ──
    it('skips a match missing its network field', async function () {
        const { match } = signMatch(makeMatch(), 1);
        delete match.network;
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        // '' !== 'regtest' → network mismatch guard fires
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Happy path: ownership transfer (ownership = 1) ────────────────────
    it('transfers token ownership instead of escrow when a_ownership=1', async function () {
        const { match } = signMatch(makeMatch({ a_ownership: 1 }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        // ownership path issues a transfer ISSUE (createIssue), no escrow release
        assert.ok(indexer.indexerDb.clearTokenEscrow.called);
        assert.ok(indexer.indexerDb.createIssue.called);
        assert.ok(indexer.indexerDb.createEscrow.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });
});
