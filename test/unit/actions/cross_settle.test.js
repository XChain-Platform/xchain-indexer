// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Cross_Settle = require('../../../src/actions/cross_settle.js');

// ── Real Ed25519 keypair helpers ───────────────────────────────────────────
// cross_settle verifies signatures with the production ed25519.js (no stub), so
// the test signs the exact canonical string with a real key. Pubkey is the raw
// 32-byte hex (SPKI minus the 12-byte prefix); sig is the raw 64-byte hex.
const SPKI_PREFIX_LEN = 12;

function genValidator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const pubkey = spki.subarray(SPKI_PREFIX_LEN).toString('hex');
    return { pubkey, privateKey };
}

function signCanonical(privateKey, canonical) {
    return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
}

describe('Cross_Settle action handler @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    // A complete, well-formed cross-chain match where THIS chain (BTC) is leg `a`.
    function makeMatch(overrides) {
        return {
            match_id: 'm'.repeat(64),
            snapshot_block: 150,
            a_chain: 'BTC', a_action_index: 42, a_tick: 'AAA', a_amount: '10', a_ownership: 0,
            a_payout_addr: '1AApayoutXXXXXXXXXXXXXXXXXXXXXaKc5Z',
            b_chain: 'LTC', b_action_index: 99, b_tick: 'BBB', b_amount: '5', b_ownership: 0,
            b_payout_addr: 'LBBpayoutXXXXXXXXXXXXXXXXXXXXXaKc5Z',
            effective_time: 1700000000,
            network: 'regtest',
            validator_signatures: '[]',
            ...overrides,
        };
    }

    // Build a signed match: returns the match with `validators` resolvable and
    // validator_signatures populated by `n` valid signers over the canonical.
    function signMatch(match, n) {
        const canonical = handler._canonical(match);
        const validators = [];
        const sigs = [];
        for (let i = 0; i < n; i++) {
            const v = genValidator();
            validators.push({ pubkey: v.pubkey });
            sigs.push({ pubkey: v.pubkey, sig: signCanonical(v.privateKey, canonical) });
        }
        match.validator_signatures = JSON.stringify(sigs);
        return { match, validators, sigs };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
        };
        handler = new Cross_Settle(actionsCtx);
        indexer.util.resetLists();

        // Cross-chain DB methods not present in the shared mock — add neutral stubs.
        indexer.indexerDb.getValidatorsByCapability = sinon.stub().resolves([]);
        indexer.indexerDb.hasCapability = sinon.stub().resolves(true);
        indexer.indexerDb.recordCrossChainSettlement = sinon.stub().resolves();
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();

        // Local offer resolves open by default; the AAA token exists.
        indexer.indexerDb.getSwapInfo.resolves({
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            SWAP_STATUS: 'open',
        });
        indexer.indexerDb.getTokenInfo.callsFake(async (tick) =>
            createTokenInfo({ TICK: tick, TICK_ID: 1, DECIMALS: 0 }));
        indexer.indexerDb.createActionIndex.resolves(777);
    });

    function makeData(overrides) {
        return createBaseData({ ACTION: 'CROSS_SETTLE', BLOCK_INDEX: 200, ...overrides });
    }

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
        indexer.indexerDb.getValidatorsByCapability.resolves([{}, {}, {}, {}]); // N=4 → quorum 3
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('rejects malformed pubkey/sig and duplicate signers', async function () {
        const match = makeMatch();
        const canonical = handler._canonical(match);
        const v = genValidator();
        const goodSig = signCanonical(v.privateKey, canonical);
        // 1 valid signer, but duplicated + a malformed entry — only counts once,
        // below quorum 3 for N=4.
        match.validator_signatures = JSON.stringify([
            { pubkey: v.pubkey, sig: goodSig },
            { pubkey: v.pubkey, sig: goodSig },          // duplicate pk — skipped
            { pubkey: 'zz', sig: 'short' },              // malformed — skipped
        ]);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}, {}, {}, {}]);
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

    it('rejects a tampered match (signature no longer verifies)', async function () {
        const { match } = signMatch(makeMatch(), 1);
        match.a_amount = '999999'; // mutate after signing → canonical changes
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('handles non-JSON validator_signatures without throwing', async function () {
        const match = makeMatch({ validator_signatures: 'not-json' });
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Guard: not this chain's match ────────────────────────────────────
    it('returns when neither leg is this chain', async function () {
        const { match } = signMatch(makeMatch({ a_chain: 'LTC', b_chain: 'DOGE' }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.getSwapInfo.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Guard: local offer missing / not open ────────────────────────────
    it('skips when the local offer is not found', async function () {
        const { match } = signMatch(makeMatch(), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        indexer.indexerDb.getSwapInfo.resolves(null);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('skips (records nothing) when the local offer is no longer open', async function () {
        const { match } = signMatch(makeMatch(), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        indexer.indexerDb.getSwapInfo.resolves({ SOURCE: 'x', SWAP_STATUS: 'complete' });
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Happy path: fungible escrow release (ownership = 0) ───────────────
    it('settles leg a: releases escrow to counterparty payout (N=1 quorum)', async function () {
        const { match } = signMatch(makeMatch(), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
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
        assert.strictEqual(recArgs[1], match.match_id);
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
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        // local action index is b_action_index (88); swap completed against it
        assert.ok(indexer.indexerDb.createSwapStatus.calledWith(777, 88, 'complete'));
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledWith(777, match.match_id, 88));
    });

    // ─── Happy path with N>1 quorum (2f+1) ────────────────────────────────
    it('requires 2f+1 signatures when N>1 and settles when met', async function () {
        const { match } = signMatch(makeMatch(), 3); // N=4 → quorum 3, exactly met
        indexer.indexerDb.getValidatorsByCapability.resolves([{}, {}, {}, {}]);
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    // ─── Branch: null ticks fall back to '' in canonical and the coin label ──
    it('settles a native-coin leg (a_tick null) using coin as the tick label', async function () {
        const { match } = signMatch(makeMatch({ a_tick: null, b_tick: null }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    // ─── Branch: signature entries missing pubkey/sig fields ──────────────
    it('tolerates signature entries missing pubkey/sig fields', async function () {
        const match = makeMatch();
        match.validator_signatures = JSON.stringify([{}, { pubkey: null }, { sig: null }]);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Branch: null validator_signatures falls back to '[]' ─────────────
    it('treats null validator_signatures as empty', async function () {
        const match = makeMatch({ validator_signatures: null });
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Branch: match with no network field, indexer also network-scoped ──
    it('skips a match missing its network field', async function () {
        const { match } = signMatch(makeMatch(), 1);
        delete match.network;
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        await handler.parse(null, makeData({ MATCH: match }), null);
        // '' !== 'regtest' → network mismatch guard fires
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    // ─── Happy path: ownership transfer (ownership = 1) ────────────────────
    it('transfers token ownership instead of escrow when a_ownership=1', async function () {
        const { match } = signMatch(makeMatch({ a_ownership: 1 }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves([{}]);
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        // ownership path issues a transfer ISSUE (createIssue), no escrow release
        assert.ok(indexer.indexerDb.clearTokenEscrow.called);
        assert.ok(indexer.indexerDb.createIssue.called);
        assert.ok(indexer.indexerDb.createEscrow.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    // ─── ORDER leg: partial-fill settlement (Phase B) ─────────────────────
    describe('ORDER leg (partial fills)', function () {
        beforeEach(function () {
            indexer.indexerDb.recordCrossChainOrderFill = sinon.stub().resolves();
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open' });
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['90', '45']);  // still remaining by default
            indexer.indexerDb.getValidatorsByCapability.resolves([{}]);          // N=1 → quorum 1
        });

        const orderMatch = (o) => makeMatch({ a_kind: 'order', b_kind: 'order', ...o });

        it('partial fill: releases the fill, records it, and leaves the order OPEN', async function () {
            const { match } = signMatch(orderMatch(), 1);
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createEscrow.called);          // fungible escrow released
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.calledOnce);
            const f = indexer.indexerDb.recordCrossChainOrderFill.firstCall.args;
            assert.strictEqual(f[0], 777);   // settlement action_index
            assert.strictEqual(f[1], 42);    // local order action_index
            assert.strictEqual(f[2], '10');  // give fill = a_amount
            assert.strictEqual(f[3], '5');   // get fill = b_amount
            assert.ok(indexer.indexerDb.createOrderStatus.notCalled);  // NOT complete (remaining > 0)
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        });

        it('final fill: marks the order complete when nothing remains', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['0', '0']);
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(777, 42, 'complete'));
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        });

        it('settles the b leg order when this chain is the b side', async function () {
            const { match } = signMatch(orderMatch({
                a_chain: 'LTC', a_action_index: 11, a_amount: '5', a_payout_addr: 'LpayoutA',
                b_chain: 'BTC', b_action_index: 88, b_tick: 'BBB', b_amount: '7',
                b_payout_addr: '1payoutBXXXXXXXXXXXXXXXXXXXXXaKc5Z',
            }), 1);
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            const f = indexer.indexerDb.recordCrossChainOrderFill.firstCall.args;
            assert.strictEqual(f[1], 88);    // local order = b leg
            assert.strictEqual(f[2], '7');   // give fill = b_amount
            assert.strictEqual(f[3], '5');   // get fill = a_amount
        });

        it('ownership order: transfers ownership and completes (single fill)', async function () {
            const { match } = signMatch(orderMatch({ a_ownership: 1 }), 1);
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['1', '1']);  // ownership completes regardless
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.clearTokenEscrow.called);
            assert.ok(indexer.indexerDb.createIssue.called);
            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(777, 42, 'complete'));
        });

        it('skips when the local order is not open', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: 'x', ORDER_STATUS: 'complete' });
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
        });

        it('skips when the local order is not found', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getOrderInfo.resolves(null);
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
        });
    });
});
