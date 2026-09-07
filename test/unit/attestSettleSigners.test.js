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
// Zero-conf flip, §4.3 / D12: at and above ATTEST_ZERO_CONF the fulfilled ATTEST
// fee splits among the VERIFIED SIGNERS of the accepted response, sorted by
// pubkey, instead of the whole widened responsible set. Below the height the
// split is the recomputed set, exactly as before. Driven through
// _settleRequestFee, which is where both fulfilled routes (the chain v1 handler
// and the mirror applier) converge.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');

const Attest = require('../../src/actions/attest.js');
const swq    = require('../../src/stake_weighted_quorum.js');
const zc     = require('../../src/attest_zero_conf_activation.js');

// 64-hex pubkeys, deliberately ordered so ascending sort (A < B < C < D) differs
// from the order the signature list is written in below.
const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const PUBKEY_D = 'd'.repeat(64);
const SIG      = (n) => String(n).repeat(128);

const REQ_ID    = 'e'.repeat(64);
const FEE_PAYER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// Testnet heights: ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet is 151324 and
// ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet is 150780, while
// ATTEST_ZERO_CONF_ACTIVATION.testnet is still the unratified null. A request at
// this height is therefore mirror-era and widening-era but BELOW the zero-conf
// flip, which is the only combination that can prove the legacy split survives.
const TESTNET_BELOW_ZC = 151400;

describe('ATTEST fee settle: pay the verified signers above the zero-conf height @regression @tier3', function () {
    let indexer, handler;

    function makeRequest(overrides = {}) {
        return {
            request_id:     REQ_ID,
            provider_id:    'http_get',
            request_status: 'pending',
            block_index:    100,     // regtest: zero-conf is armed at 0, so this is above it
            deadline_block: 200,
            redundancy:     4,
            action_index:   42,
            fee_amount:     '6.00000000',
            fee_payer:      FEE_PAYER,
            contract_index: 5,
            ...overrides,
        };
    }

    // The settling action: a v1 response row carrying the federation signatures the
    // chain path and the mirror applier both inline before the settle runs.
    function settleData(signatures, overrides = {}) {
        return createBaseData({
            ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 105, ACTION_INDEX: 60,
            BLOCK_TIME: 1700000000,
            VALIDATOR_SIGNATURES: signatures,
            ...overrides,
        });
    }

    function feeRewards() {
        return indexer.indexerDb.createValidatorReward.getCalls()
            .filter(c => c.args[2] === 'attest_fee')
            .map(c => ({ pubkey: c.args[0], amount: String(c.args[3]) }));
    }

    function buildHandler(configOverrides = {}) {
        handler = new Attest({
            config:        { ...indexer.config, ...configOverrides },
            util:          indexer.util,
            mapper:        indexer.mapper,
            decoderDb:     indexer.decoderDb,
            indexerDb:     indexer.indexerDb,
            actionExecute: { parse: sinon.stub().resolves() },
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
        });
        return handler;
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.indexerDb.createValidatorReward     = sinon.stub().resolves(true);
        indexer.indexerDb.getTokenDecimalPrecision  = sinon.stub().resolves(8);
        indexer.indexerDb.getTickerId               = sinon.stub().resolves(1);
        // Four capability validators and redundancy 4, so the recomputed responsible
        // set has one member more than the three signers: the headroom seat this row
        // exists to stop paying.
        indexer.indexerDb.getValidatorsByCapability = sinon.stub().resolves([
            { pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }, { pubkey: PUBKEY_C }, { pubkey: PUBKEY_D },
        ]);
        indexer.util.resetLists();
        // Legacy count-based responsible set: the weighted path needs a stake snapshot
        // and a provider floor, neither of which this row touches.
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        buildHandler();
    });

    afterEach(function () {
        sinon.restore();
    });

    it('above the height: only the three signers are paid, sorted by pubkey, at floor(pool/3)', async function () {
        // Written C, A, B on purpose: the hub authors the row in its own order and the
        // write order of validator_rewards must not inherit it (D70).
        const sigs = JSON.stringify([
            { pubkey: PUBKEY_C, sig: SIG(3) },
            { pubkey: PUBKEY_A, sig: SIG(1) },
            { pubkey: PUBKEY_B, sig: SIG(2) },
        ]);
        await handler._settleRequestFee(makeRequest(), settleData(sigs), 'fulfilled');

        const rewards = feeRewards();
        assert.strictEqual(rewards.length, 3, 'the fourth responsible member never signed and is not paid');
        assert.deepStrictEqual(rewards.map(r => r.pubkey), [PUBKEY_A, PUBKEY_B, PUBKEY_C],
            'rows are written in ascending pubkey order, not the order the row carries');
        assert.ok(rewards.every(r => r.amount === '2'), 'equal split of the whole 6 escrow three ways');
        assert.strictEqual(rewards.filter(r => r.pubkey === PUBKEY_D).length, 0);

        // The pool credit is still the FULL escrow, so the dust argument is unchanged.
        assert.strictEqual(String(indexer.indexerDb.createCredit.firstCall.args[2]), '6.00000000');
    });

    it('above the height: duplicate and mixed-case signer keys collapse to one lower-cased share each', async function () {
        const sigs = JSON.stringify([
            { pubkey: PUBKEY_B.toUpperCase(), sig: SIG(2) },
            { pubkey: PUBKEY_B,               sig: SIG(2) },
            { pubkey: PUBKEY_A,               sig: SIG(1) },
        ]);
        await handler._settleRequestFee(makeRequest(), settleData(sigs), 'fulfilled');

        const rewards = feeRewards();
        assert.deepStrictEqual(rewards.map(r => r.pubkey), [PUBKEY_A, PUBKEY_B],
            'one share per distinct key, lower-cased like the responsible set');
        assert.ok(rewards.every(r => r.amount === '3'), 'the escrow splits two ways, not three');
    });

    it('below the height (testnet, request above the mirror height): all four responsible members are paid', async function () {
        assert.strictEqual(zc.isZeroConfActive(TESTNET_BELOW_ZC, 'testnet'), false,
            'fixture guard: this height must be BELOW the zero-conf flip on testnet');
        buildHandler({ NETWORK: 'testnet' });

        const sigs = JSON.stringify([
            { pubkey: PUBKEY_A, sig: SIG(1) },
            { pubkey: PUBKEY_B, sig: SIG(2) },
            { pubkey: PUBKEY_C, sig: SIG(3) },
        ]);
        await handler._settleRequestFee(
            makeRequest({ block_index: TESTNET_BELOW_ZC, deadline_block: TESTNET_BELOW_ZC + 100 }),
            settleData(sigs, { BLOCK_INDEX: TESTNET_BELOW_ZC + 5 }),
            'fulfilled'
        );

        const rewards = feeRewards();
        assert.strictEqual(rewards.length, 4, 'the legacy split pays the recomputed set, signers or not');
        assert.deepStrictEqual(rewards.map(r => r.pubkey).slice().sort(),
            [PUBKEY_A, PUBKEY_B, PUBKEY_C, PUBKEY_D]);
        assert.ok(rewards.every(r => r.amount === '1.5'), '6 split four ways');
    });

    it('above the height with no signature column: the recomputed set is paid and the settle warns, naming the request', async function () {
        const warn = sinon.stub(console, 'warn');
        // The v4 relay path stores null here on purpose (its signatures are relay
        // signatures, not the attestation quorum), and it settles through this routine.
        await handler._settleRequestFee(makeRequest(), settleData(null), 'fulfilled');

        const rewards = feeRewards();
        assert.strictEqual(rewards.length, 4, 'fallback pays the recomputed responsible set');
        assert.ok(rewards.every(r => r.amount === '1.5'));

        const warned = warn.getCalls().map(c => String(c.args[0])).filter(m => m.indexOf('no verified signatures') !== -1);
        assert.strictEqual(warned.length, 1, 'warned exactly once for this settle');
        assert.ok(warned[0].indexOf(REQ_ID.substring(0, 16)) !== -1, 'the warning names the request');
    });

    it('above the height with an unparseable signature column: same deterministic fallback', async function () {
        sinon.stub(console, 'warn');
        await handler._settleRequestFee(makeRequest(), settleData('{not json'), 'fulfilled');
        assert.strictEqual(feeRewards().length, 4);
    });

    it('above the height with an empty signature array: same deterministic fallback', async function () {
        sinon.stub(console, 'warn');
        await handler._settleRequestFee(makeRequest(), settleData('[]'), 'fulfilled');
        assert.strictEqual(feeRewards().length, 4);
    });

    for (const status of ['errored', 'expired']) {
        it("terminal '" + status + "' above the height still refunds the payer and pays nobody", async function () {
            const sigs = JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG(1) }]);
            await handler._settleRequestFee(makeRequest(), settleData(sigs), status);

            assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 0,
                'a request that was never fulfilled pays no signer, D72');
            assert.ok(indexer.indexerDb.createCredit.calledOnce);
            const [, ticker, amount, address] = indexer.indexerDb.createCredit.firstCall.args;
            assert.strictEqual(ticker, 'XCHAIN');
            assert.strictEqual(String(amount), '6.00000000');
            assert.strictEqual(address, FEE_PAYER, 'refund goes to the payer, not the pool');
        });
    }
});
