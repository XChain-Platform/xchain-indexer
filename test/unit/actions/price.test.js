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
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Price   = require('../../../src/actions/price.js');
// Same cached module Price references — stubbing verify() controls sig acceptance.
const ed25519 = require('../../../src/ed25519.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const SIG_C    = '3'.repeat(128);

describe('Price (PRICE) @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    function addPriceDbStubs(db) {
        db.createPrice               = sinon.stub().resolves();
        db.hasCapability             = sinon.stub().resolves(true);
        db.getActiveCapabilityCount  = sinon.stub().resolves(1);
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addPriceDbStubs(indexer.indexerDb);

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            hubClient: null,
        };
        handler = new Price(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ───────────────────────────────────────────────────────────────────────
    // v0 — validator COIN/FIAT snapshot (PBFT 2f+1 quorum over price-capable set)
    // ───────────────────────────────────────────────────────────────────────
    describe('v0 — validator snapshot', function () {

        // PRICE|0|ROUND|TIMESTAMP|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
        function v0Params(pairs, sigs, overrides = {}) {
            const p = { round: '7', timestamp: '1700000000', ...overrides };
            const out = ['0', p.round, p.timestamp, String(pairs.length)];
            for (const pr of pairs) { out.push(pr.pair, pr.price); }
            out.push(String(sigs.length));
            for (const s of sigs) { out.push(s.pubkey, s.sig); }
            return out;
        }
        function v0Data(overrides = {}) {
            return createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, ...overrides });
        }
        const ONE_PAIR = [{ pair: 'BTC/USD', price: '50000' }];

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('valid single-validator snapshot (quorum 1) → valid', async function () {
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
        });

        it('meets PBFT quorum at exactly 2f+1 → valid', async function () {
            // 4 price-capable validators → quorum = 2*floor((4-1)/3)+1 = 3
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
                { pubkey: PUBKEY_C, sig: SIG_C },
            ]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
        });

        it('fails PBFT quorum at 2f (one below threshold) → invalid', async function () {
            // 4 validators → quorum = 3; only 2 valid sigs
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('quorum'));
        });

        it('does NOT count duplicate-pubkey signatures twice toward quorum', async function () {
            indexer.indexerDb.getActiveCapabilityCount.resolves(4); // quorum 3
            const data = v0Data();
            // three sigs but two share PUBKEY_A → only 2 distinct → below quorum 3
            await handler.parse(v0Params(ONE_PAIR, [
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_A, sig: SIG_B },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('quorum'));
        });

        it('counts a signature only when ed25519.verify passes', async function () {
            ed25519.verify.returns(false);
            indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('skips a signer without the price capability at this block', async function () {
            indexer.indexerDb.hasCapability.resolves(false);
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('rejects a malformed pair string', async function () {
            const data = v0Data();
            await handler.parse(v0Params([{ pair: 'not-a-pair', price: '1' }], [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('rejects a malformed SIG_COUNT', async function () {
            const data = v0Data();
            // hand-craft: SIG_COUNT non-numeric
            const params = ['0', '7', '1700000000', '1', 'BTC/USD', '50000', 'NaN', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // v1 — user TOKEN/FIAT oracle price
    // ───────────────────────────────────────────────────────────────────────
    describe('v1 — user oracle price', function () {

        // PRICE|1|COIN|TICK|FIAT|VALUE|FEE|MEMO
        function v1Params(overrides = {}) {
            const p = { coin: 'BTC', tick: 'TEST', fiat: 'USD', value: '1.50', fee: '0', memo: 'm', ...overrides };
            return ['1', p.coin, p.tick, p.fiat, p.value, p.fee, p.memo];
        }
        function v1Data(overrides = {}) {
            return createBaseData({ ACTION: 'PRICE', FORMAT: 1, ...overrides });
        }

        it('valid oracle price → valid and recorded', async function () {
            const data = v1Data();
            await handler.parse(v1Params(), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
        });

        it('rejects an unsupported COIN', async function () {
            const data = v1Data();
            await handler.parse(v1Params({ coin: 'XRP' }), data, null);
            assert.ok(String(data['STATUS']).includes('COIN'));
        });

        it('rejects an unsupported FIAT', async function () {
            const data = v1Data();
            await handler.parse(v1Params({ fiat: 'ZZZ' }), data, null);
            assert.ok(String(data['STATUS']).includes('FIAT'));
        });

        it('rejects a non-positive VALUE', async function () {
            const data = v1Data();
            await handler.parse(v1Params({ value: '0' }), data, null);
            assert.ok(String(data['STATUS']).includes('VALUE'));
        });
    });

    it('rejects an unknown VERSION', async function () {
        const data = createBaseData({ ACTION: 'PRICE', FORMAT: 9 });
        await handler.parse(['9'], data, null);
        assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        assert.ok(indexer.indexerDb.createPrice.calledOnce);
    });
});
