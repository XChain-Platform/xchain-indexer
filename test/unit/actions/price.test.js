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
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Price   = require('../../../src/actions/price.js');
// Same cached modules Price references - stubbing verify() controls sig acceptance,
// stubbing isStakeWeightedQuorumActive() selects the count vs stake-weighted path.
const ed25519 = require('../../../src/ed25519.js');
const swq     = require('../../../src/stake_weighted_quorum.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const SIG_C    = '3'.repeat(128);

// Every pubkey this suite signs with (the byte-repeat forms cover the Sybil
// fixtures below). The mock DB resolves the BATCHED capability set over this
// universe, mirroring db.js where getValidatorsByCapability and hasCapability
// answer from the same _effectiveCapabilitySetSql (#3871).
const ALL_PUBKEYS = Array.from(new Set(
    [PUBKEY_A, PUBKEY_B, PUBKEY_C].concat(
        Array.from({ length: 16 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32)))));

describe('Price (PRICE) @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    function addPriceDbStubs(db) {
        db.createPrice                  = sinon.stub().resolves();
        db.hasCapability                = sinon.stub();
        db.getValidatorsByCapability    = sinon.stub();
        db.getActiveCapabilityCount     = sinon.stub().resolves(1);
        db.getStakeWeightsByCapability  = sinon.stub().resolves([]);
        db.createValidatorReward        = sinon.stub().resolves(true);
        setCapable(db, () => true);
    }

    // Drive BOTH capability APIs from one predicate, the way db.js does (#3871):
    // a case that says who qualifies stays honest whichever path the handler takes.
    function setCapable(db, predicate) {
        db.hasCapability.callsFake(async (pubkey, cap, blk) => !!(await predicate(pubkey, cap, blk)));
        db.getValidatorsByCapability.callsFake(async (cap, blk) => {
            const rows = [];
            for (const pubkey of ALL_PUBKEYS)
                if (await predicate(pubkey, cap, blk)) rows.push({ pubkey, amount: '0' });
            rows.truncated = false;
            return rows;
        });
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

    describe('v1 - user oracle price', function () {

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

        it('uses the exact bcmath comparator for VALUE positivity, matching the FEE sibling (2396)', async function () {
            // Zero in any decimal form is rejected; the smallest representable positive
            // 8-decimal amount is accepted. The positivity gate now runs through
            // util.bclte (exact) rather than parseFloat, matching the V1_FEE check.
            for (const value of ['0', '0.00000000']) {
                const data = v1Data();
                await handler.parse(v1Params({ value }), data, null);
                assert.ok(String(data['STATUS']).includes('VALUE'), 'VALUE ' + value + ' should be rejected');
            }
            const okData = v1Data();
            await handler.parse(v1Params({ value: '0.00000001' }), okData, null);
            assert.strictEqual(okData['VALIDATION_STATUS'], 'valid', 'smallest positive 8-decimal VALUE should be valid');
        });

        it('accepts boundary FEE values 0, 1 and a legitimate fraction', async function () {
            for (const fee of ['0', '1', '0.05', '0.999999999999999999']) {
                const data = v1Data();
                await handler.parse(v1Params({ fee }), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid', 'FEE ' + fee + ' should be valid');
            }
        });

        it('rejects an unbounded-precision FEE just above 1 (parseFloat rounding bypass)', async function () {
            // parseFloat('1.0000000000000000001') === 1, so the old parseFloat > 1
            // gate accepted it; exact bcmath now rejects it.
            for (const fee of ['1.0000000000000000001', '1.000000000000000000000001']) {
                const data = v1Data();
                await handler.parse(v1Params({ fee }), data, null);
                assert.ok(String(data['STATUS']).includes('FEE'), 'FEE ' + fee + ' should be rejected');
            }
        });
    });

    it('rejects an unknown VERSION', async function () {
        const data = createBaseData({ ACTION: 'PRICE', FORMAT: 9 });
        await handler.parse(['9'], data, null);
        assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        assert.ok(indexer.indexerDb.createPrice.calledOnce);
    });

    describe('hub push - v1', function () {
        function v1Params(overrides = {}) {
            const p = { coin: 'BTC', tick: 'TEST', fiat: 'USD', value: '1.50', fee: '0', memo: 'm', ...overrides };
            return ['1', p.coin, p.tick, p.fiat, p.value, p.fee, p.memo];
        }

        // A v1 oracle_price is user-submitted and never re-emitted by a later block, so its lost-push
        // window was permanent. It now uses the same durable transactional outbox as v0: enqueueHubPushTx
        // inside the block transaction plus a staged post-commit delivery; parse never pushes directly.
        it('valid v1 with hubClient → durable outbox row enqueued + staged (no direct push)', async function () {
            const mockHubClient = { enabled: true, pushOraclePrice: sinon.stub().resolves() };
            indexer.indexerDb.enqueueHubPushTx = sinon.stub().resolves(7);
            indexer.indexerDb.stageHubPush = sinon.stub();

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
            assert.ok(indexer.indexerDb.enqueueHubPushTx.calledOnce);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.firstCall.args[0], 'oracle_price');
            assert.ok(!mockHubClient.pushOraclePrice.called);
            assert.ok(indexer.indexerDb.stageHubPush.calledOnce);
            const staged = indexer.indexerDb.stageHubPush.firstCall.args[0];
            assert.strictEqual(staged.id, 7);
            assert.strictEqual(staged.pushType, 'oracle_price');
        });

        it('invalid v1 with hubClient → nothing enqueued or staged', async function () {
            const mockHubClient = { enabled: true, pushOraclePrice: sinon.stub().resolves() };
            indexer.indexerDb.enqueueHubPushTx = sinon.stub().resolves(1);
            indexer.indexerDb.stageHubPush = sinon.stub();

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            // Invalid - unsupported FIAT
            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 1 });
            await localHandler.parse(v1Params({ fiat: 'ZZZ' }), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(!mockHubClient.pushOraclePrice.called);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
            assert.ok(!indexer.indexerDb.stageHubPush.called);
        });
    });
});
