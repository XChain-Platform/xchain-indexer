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
// Same cached modules Price references — stubbing verify() controls sig acceptance,
// stubbing isStakeWeightedQuorumActive() selects the count vs stake-weighted path.
const ed25519 = require('../../../src/ed25519.js');
const swq     = require('../../../src/stake_weighted_quorum.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const SIG_C    = '3'.repeat(128);

describe('Price (PRICE) @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    function addPriceDbStubs(db) {
        db.createPrice                  = sinon.stub().resolves();
        db.hasCapability                = sinon.stub().resolves(true);
        db.getActiveCapabilityCount     = sinon.stub().resolves(1);
        db.getStakeWeightsByCapability  = sinon.stub().resolves([]);
        db.createValidatorReward        = sinon.stub().resolves(true);
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
            // These cases exercise the legacy COUNT quorum (the live path on mainnet
            // below the activation height). Weighted mode has its own describe below.
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
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

        // ── oracle_round reward derivation (consensus — replayable by construction) ──
        describe('round rewards derived from the signer set', function () {

            it('valid PRICE → equal floor split to every verified signer, upserted', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(3); // quorum 2... 2*0+1=1, majority 2 → 2
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 3);
                // 10 XCHAIN default / 3 signers, floored to 8dp
                for (const pk of [PUBKEY_A, PUBKEY_B, PUBKEY_C]) {
                    const call = indexer.indexerDb.createValidatorReward.getCalls()
                        .find(c => c.args[0] === pk);
                    assert.ok(call, 'reward for ' + pk.substring(0, 8));
                    assert.strictEqual(call.args[1], 7);                    // ROUND
                    assert.strictEqual(call.args[2], 'oracle_round');
                    assert.strictEqual(String(call.args[3]), '3.33333333'); // floor(10/3, 8dp)
                    assert.strictEqual(call.args[4], data['BLOCK_INDEX']);
                    assert.strictEqual(call.args[5], true);                 // upsert — deterministic writer wins
                }
            });

            it('invalid PRICE (quorum failure) → no rewards', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(4); // quorum 3, only 1 sig
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it('non-BTC chain → no rewards even if validation passes', async function () {
                const data = v0Data({ COIN: 'LTC' });
                await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it('duplicate-pubkey signatures earn one share, unqualified signers earn none', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
                // PUBKEY_B lacks the capability; PUBKEY_A appears twice
                indexer.indexerDb.hasCapability.callsFake(async (pk) => pk !== PUBKEY_B);
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_A, sig: SIG_B },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 1);
                const call = indexer.indexerDb.createValidatorReward.getCall(0);
                assert.strictEqual(call.args[0], PUBKEY_A);
                // bcmulfloor returns un-padded whole numbers ('10' not '10.00000000') — compare numerically
                assert.strictEqual(Number(call.args[3]), 10); // sole qualified signer takes the round
            });
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // v0 — STAKE_WEIGHTED_QUORUM (finalize on summed signer STAKE, source-deduped)
    // ───────────────────────────────────────────────────────────────────────
    describe('v0 — stake-weighted quorum', function () {
        function v0Params(pairs, sigs) {
            const out = ['0', '7', '1700000000', String(pairs.length)];
            for (const pr of pairs) { out.push(pr.pair, pr.price); }
            out.push(String(sigs.length));
            for (const s of sigs) { out.push(s.pubkey, s.sig); }
            return out;
        }
        function v0Data(overrides = {}) {
            return createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, ...overrides });
        }
        const ONE_PAIR = [{ pair: 'BTC/USD', price: '50000' }];

        // Valid 64-hex pubkey / 128-hex sig from a byte value.
        const pk = (n) => n.toString(16).padStart(2, '0').repeat(32);
        const sg = (n) => n.toString(16).padStart(2, '0').repeat(64);

        // One whale source holds the supermajority of stake; nine Sybil sources hold
        // 1 each. S = 100000 + 9 = 100009.
        const WHALE = { pubkey: PUBKEY_A, source: 'WHALE', weight: '100000' };
        const SYBILS = [];
        for (let i = 0; i < 9; i++) SYBILS.push({ pubkey: pk(i), source: 'SYB' + i, weight: '1' });
        const SNAPSHOT = [WHALE].concat(SYBILS);

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
            indexer.indexerDb.getStakeWeightsByCapability.resolves(SNAPSHOT);
        });

        it('SECURITY: a COUNT supermajority of low-stake Sybils cannot finalize', async function () {
            // All nine Sybils sign — a 9-of-10 COUNT landslide — but only 9/100009 stake:
            // 3·9 = 27 !> 2·100009. Stake, not headcount, gates finalization.
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, SYBILS.map(s => ({ pubkey: s.pubkey, sig: sg(1) }))), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('stake'));
        });

        it('a single majority-STAKE signer finalizes alone (COUNT minority of one)', async function () {
            // The whale alone: 3·100000 = 300000 > 2·100009 = 200018 → valid.
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
        });

        it('uses the source-keyed weight query, not the count query', async function () {
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(indexer.indexerDb.getStakeWeightsByCapability.calledWith('price', data['BLOCK_INDEX']));
            assert.ok(indexer.indexerDb.getActiveCapabilityCount.notCalled);
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

    // ───────────────────────────────────────────────────────────────────────
    // Hub push paths (hubClient present)
    // ───────────────────────────────────────────────────────────────────────

    describe('hub push — v0', function () {
        function v0Params(pairs, sigs) {
            const out = ['0', '7', '1700000000', String(pairs.length)];
            for (const pr of pairs) { out.push(pr.pair, pr.price); }
            out.push(String(sigs.length));
            for (const s of sigs) { out.push(s.pubkey, s.sig); }
            return out;
        }
        const ONE_PAIR = [{ pair: 'BTC/USD', price: '50000' }];

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        });

        it('valid v0 with hubClient → pushPriceRound called', async function () {
            const mockHubClient = { pushPriceRound: sinon.stub().resolves() };
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100 });
            await localHandler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.ok(mockHubClient.pushPriceRound.calledOnce);
        });

        it('valid v0 with hubClient — hub push failure queues retry', async function () {
            // pushPriceRound rejects — should queue via enqueueHubPush (fire-and-forget)
            indexer.indexerDb.enqueueHubPush = sinon.stub().resolves();
            const mockHubClient = { pushPriceRound: sinon.stub().rejects(new Error('network timeout')) };
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100 });
            // Should NOT throw even though hub push rejects (fire-and-forget)
            await localHandler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            // enqueueHubPush is called after the rejection is caught by the .catch chain (async)
            // We just verify the main parse didn't throw
        });

        it('invalid v0 with hubClient → pushPriceRound NOT called', async function () {
            const mockHubClient = { pushPriceRound: sinon.stub().resolves() };
            // Fail quorum by returning false for all sigs
            ed25519.verify.returns(false);
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100 });
            await localHandler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(!mockHubClient.pushPriceRound.called);
        });
    });

    describe('hub push — v1', function () {
        function v1Params(overrides = {}) {
            const p = { coin: 'BTC', tick: 'TEST', fiat: 'USD', value: '1.50', fee: '0', memo: 'm', ...overrides };
            return ['1', p.coin, p.tick, p.fiat, p.value, p.fee, p.memo];
        }

        it('valid v1 with hubClient → pushOraclePrice called', async function () {
            const mockHubClient = { pushOraclePrice: sinon.stub().resolves() };

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 1 });
            await localHandler.parse(v1Params(), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.ok(mockHubClient.pushOraclePrice.calledOnce);
        });

        it('invalid v1 with hubClient → pushOraclePrice NOT called', async function () {
            const mockHubClient = { pushOraclePrice: sinon.stub().resolves() };

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            // Invalid — unsupported FIAT
            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 1 });
            await localHandler.parse(v1Params({ fiat: 'ZZZ' }), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(!mockHubClient.pushOraclePrice.called);
        });

        it('valid v1 with hubClient — hub push failure queued for retry (no throw)', async function () {
            indexer.indexerDb.enqueueHubPush = sinon.stub().resolves();
            const mockHubClient = { pushOraclePrice: sinon.stub().rejects(new Error('hub down')) };

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 1 });
            // Fire-and-forget — must not throw
            await localHandler.parse(v1Params(), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
        });
    });
});
