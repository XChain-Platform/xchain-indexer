// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Cross_Settle = require('../../../src/actions/cross_settle.js');
const swq          = require('../../../src/stake_weighted_quorum.js');

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
    let indexer, actionsCtx, handler, swqStub;

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

    // A cross_chain validator snapshot of size N that INCLUDES every pubkey that
    // signed `match`; WI-1 counts only snapshot members (snapPubkeys.has), and
    // pads to N with distinct non-signing keys so N drives the (legacy, swqStub-
    // pinned) majority-floor quorum. A bare placeholder snapshot (e.g. [{}])
    // deliberately omits the signers, modelling a non-member.
    function snapFor(match, N) {
        let signed;
        try { signed = JSON.parse(match.validator_signatures || '[]'); } catch (_) { signed = []; }
        const out = [], seen = new Set();
        for (const s of (Array.isArray(signed) ? signed : [])) {
            const pk = (s && typeof s.pubkey === 'string') ? s.pubkey.toLowerCase() : null;
            if (pk && /^[0-9a-f]{64}$/.test(pk) && !seen.has(pk)) { seen.add(pk); out.push({ pubkey: pk }); }
        }
        while (out.length < N) out.push({ pubkey: genValidator().pubkey });
        return out;
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

        // These cases assert legacy COUNT quorum (the live mainnet path, whose
        // activation height is a far-future placeholder). On regtest, WI-1
        // stake-weighted quorum is active at every block, so pin the legacy path
        // explicitly : the validator mocks below carry no source/weight and the
        // weighted predicate diverges from the majority floor at N=3. Weighted
        // coverage lives in StakeWeightedQuorum.test.js.
        swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);

        // Cross-chain DB methods not present in the shared mock : add neutral stubs.
        indexer.indexerDb.getValidatorsByCapability = sinon.stub().resolves([]);
        indexer.indexerDb.hasCapability = sinon.stub().resolves(true);
        indexer.indexerDb.recordCrossChainSettlement = sinon.stub().resolves();
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();

        // Local offer resolves open by default; the AAA token exists.
        indexer.indexerDb.getSwapInfo.resolves({
            SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            SWAP_STATUS: 'open',
        });
        indexer.indexerDb.getTokenInfo.callsFake(async (tick) =>
            createTokenInfo({ TICK: tick, TICK_ID: 1, DECIMALS: 0 }));
        indexer.indexerDb.createActionIndex.resolves(777);
    });

    // Restores swqStub plus the per-test stubs created in beforeEach : without
    // this the default sandbox accumulates across cases (sinon leak warning).
    afterEach(function () { sinon.restore(); });

    function makeData(overrides) {
        return createBaseData({ ACTION: 'CROSS_SETTLE', BLOCK_INDEX: 200, ...overrides });
    }

    it('returns early when no MATCH is present', async function () {
        await handler.parse(null, makeData(), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('skips a match signed on a different network', async function () {
        const match = makeMatch({ network: 'mainnet' });
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('defers when no cross_chain validators are snapshotted (N=0)', async function () {
        const match = makeMatch();
        indexer.indexerDb.getValidatorsByCapability.resolves([]);
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('skips when there are zero valid signatures', async function () {
        const { match, validators } = signMatch(makeMatch(), 0);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 4)); // N=4 → quorum 3
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('rejects malformed pubkey/sig and duplicate signers', async function () {
        const match = makeMatch();
        const canonical = handler._canonical(match);
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

    it('returns when neither leg is this chain', async function () {
        const { match } = signMatch(makeMatch({ a_chain: 'LTC', b_chain: 'DOGE' }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.getSwapInfo.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

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

    it('requires 2f+1 signatures when N>1 and settles when met', async function () {
        const { match } = signMatch(makeMatch(), 3); // N=4 → quorum 3, exactly met
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 4));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

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

    it('settles a native-coin leg (a_tick null) using coin as the tick label', async function () {
        const { match } = signMatch(makeMatch({ a_tick: null, b_tick: null }), 1);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        const data = makeData({ MATCH: match });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    it('tolerates signature entries missing pubkey/sig fields', async function () {
        const match = makeMatch();
        match.validator_signatures = JSON.stringify([{}, { pubkey: null }, { sig: null }]);
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('treats null validator_signatures as empty', async function () {
        const match = makeMatch({ validator_signatures: null });
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

    it('skips a match missing its network field', async function () {
        const { match } = signMatch(makeMatch(), 1);
        delete match.network;
        indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
        await handler.parse(null, makeData({ MATCH: match }), null);
        // '' !== 'regtest' → network mismatch guard fires
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
    });

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

    describe('ORDER leg (partial fills)', function () {
        beforeEach(function () {
            indexer.indexerDb.recordCrossChainOrderFill = sinon.stub().resolves();
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open' });
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['90', '45']);  // still remaining by default
            // The cross_chain snapshot is wired per-test (snapFor) once the match
            // is signed, so it includes the order's signer (WI-1 membership).
        });

        const orderMatch = (o) => makeMatch({ a_kind: 'order', b_kind: 'order', ...o });

        it('partial fill: releases the fill, records it, and leaves the order OPEN', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
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
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
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
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            const f = indexer.indexerDb.recordCrossChainOrderFill.firstCall.args;
            assert.strictEqual(f[1], 88);    // local order = b leg
            assert.strictEqual(f[2], '7');   // give fill = b_amount
            assert.strictEqual(f[3], '5');   // get fill = a_amount
        });

        it('ownership order: transfers ownership and completes (single fill)', async function () {
            const { match } = signMatch(orderMatch({ a_ownership: 1 }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['1', '1']);  // ownership completes regardless
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.clearTokenEscrow.called);
            assert.ok(indexer.indexerDb.createIssue.called);
            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(777, 42, 'complete'));
        });

        it('records a NO-OP settlement (no fill, no funds) when the local order is not open', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: 'x', ORDER_STATUS: 'complete' });
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.notCalled);
            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        });

        it(': clamps a TOCTOU over-stamped fill to the order\'s give remaining', async function () {
            const { match } = signMatch(orderMatch(), 1);   // a_amount (fill) = '10'
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open', GIVE_REMAINING: '4' });
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const f = indexer.indexerDb.recordCrossChainOrderFill.firstCall.args;
            assert.strictEqual(f[2], '4');   // released/recorded give clamped to escrow, not the stamped 10
        });

        it(': records a NO-OP settlement when nothing remains to give', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open', GIVE_REMAINING: '0' });
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.notCalled);
            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        });

        it('skips when the local order is not found', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderInfo.resolves(null);
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
        });
    });

    describe('cross-chain royalty at settlement (CROSS_CHAIN_ROYALTY)', function () {
        const ccr = require('../../../src/cross_chain_royalty_activation.js');
        // Regtest p2pkh: LTC→BTC regtest re-encode is the identity (shared 0x6f prefix),
        // so the leg credit lands on this exact address.
        const LEG_TO = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
        const LEGS   = JSON.stringify([{ to: LEG_TO, bps: 2500 }]);

        function creditsSeen() {
            return indexer.indexerDb.createCredit.getCalls().map(c => c.args); // [action_index, tick, amount, address]
        }

        it('applies the counterparty legs to the released proceeds (seller remainder + leg credit)', async function () {
            // BTC is leg a; its escrow releases to b's payout, so b's legs (b_payout_legs,
            // in b_chain=LTC encoding) split these proceeds: 10 AAA → 8 remainder + 2 leg (2500 bps).
            const { match } = signMatch(makeMatch({ b_payout_legs: LEGS }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            const credits = creditsSeen();
            assert.strictEqual(credits.length, 2, 'remainder + one leg credit');
            const remainder = credits.find(c => c[3] === match.b_payout_addr);
            const legCredit = credits.find(c => c[3] === LEG_TO);
            assert.ok(remainder && legCredit);
            assert.strictEqual(Number(remainder[2]), 8);
            assert.strictEqual(Number(legCredit[2]), 2);
            // Escrow release is unchanged (single full release; the split only shapes credits)
            assert.ok(indexer.indexerDb.createEscrow.calledOnce);
        });

        it('a match with STRIPPED legs no longer verifies against legs-bearing signatures', async function () {
            const { match } = signMatch(makeMatch({ b_payout_legs: LEGS }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            match.b_payout_legs = null;   // hub-side tamper after signing
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
        });

        it('fail-closed: a leg that does not re-encode yields NO split (full proceeds credit)', async function () {
            // A segwit-looking leg claimed to be DOGE-encoded can never decode (DOGE has no
            // bech32 HRP), so the split is dropped and the seller keeps the full proceeds.
            const badLegs = JSON.stringify([{ to: 'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul', bps: 2500 }]);
            const { match } = signMatch(makeMatch({ b_chain: 'DOGE', b_payout_legs: badLegs }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const credits = creditsSeen();
            assert.strictEqual(credits.length, 1);
            assert.strictEqual(Number(credits[0][2]), 10);
            assert.strictEqual(credits[0][3], match.b_payout_addr);
        });

        it('below the flag-day the split is not applied (legacy full credit)', async function () {
            const flagStub = sinon.stub(ccr, 'isCrossChainRoyaltyActive').returns(false);
            const { match } = signMatch(makeMatch({ b_payout_legs: LEGS }), 1);   // legacy canonical (no legs bytes)
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            flagStub.restore();
            assert.strictEqual(data['STATUS'], 'valid');
            const credits = creditsSeen();
            assert.strictEqual(credits.length, 1);
            assert.strictEqual(Number(credits[0][2]), 10);
        });

        it('applies the legs on an ORDER-leg partial fill too', async function () {
            indexer.indexerDb.recordCrossChainOrderFill = sinon.stub().resolves();
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open' });
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['90', '45']);
            const { match } = signMatch(makeMatch({ a_kind: 'order', b_kind: 'order', b_payout_legs: LEGS }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const credits = creditsSeen();
            assert.strictEqual(credits.length, 2);
            assert.strictEqual(Number(credits.find(c => c[3] === LEG_TO)[2]), 2);
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.calledOnce);
        });
    });
});
