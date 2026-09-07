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
// test/unit/actions/price-scale-activation.test.js
//
// PRICE v0 canonical price-value flag day, chain side.
//
// The v0 wire is the one price entry point with no bound on a price's scale or
// length: the v1 push path caps the decimal side at 8 places, the producers
// normalize with bcformat(price, 8), and _parseV0 accepts any number of digits.
// So a quorum-signed round can carry a value every other lane refuses, and it
// reaches price_snapshots.price either truncated or as a hard insert failure
// depending on the database's sql_mode.
//
// Both sides of the gate are driven through the REAL parser, on a real six-round
// batch with real Ed25519 signatures over the real canonical, because the claim
// that matters is not "the regex changed" but "a from-genesis replay below the
// threshold reaches the same verdict".

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Price      = require('../../../src/actions/price.js');
const ed25519    = require('../../../src/ed25519.js');
const swq        = require('../../../src/stake_weighted_quorum.js');
const priceScale = require('../../../src/price_scale_activation.js');

// The three values the loose rule admits and every other price lane refuses.
const WIDE          = '1.' + '0'.repeat(39) + '1';   // 42 chars: over-runs price_snapshots.price
const NEAR_ZERO     = '0.000000001';                 // 1e-9: bcformat(...,8) renders it '0.00000000'
const LEADING_ZEROS = '0'.repeat(60) + '1.5';        // 63 chars, and legal under a scale cap alone
const HONEST        = '50000.00000000';              // exactly what bcformat(price, 8) emits

function newIdentity(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    return { pubkey: raw.toString('hex'), privateKey };
}
function signWith(identity, payload){
    return crypto.sign(null, Buffer.from(payload, 'utf8'), identity.privateKey).toString('hex');
}

// `body` is the field list AFTER "PRICE|0|", the uncompressed wire form.
function batchBody(batch){
    const out = [String(batch.firstRound), String(batch.lastRound),
                 String(batch.btcBlockHeight), String(batch.rounds.length)];
    for(const r of batch.rounds){
        out.push(String(r.round), String(r.timestamp), String(r.btcBlockHeight), String(r.pairs.length));
        for(const p of r.pairs) out.push(String(p.pair), String(p.price));
    }
    out.push(String(batch.sigs.length));
    for(const s of batch.sigs) out.push(s.pubkey, s.sig);
    return out;
}
const uncompressedParams = body => ['2'].concat(body);

describe('PRICE v0 canonical price-value flag day @regression @tier3', function () {

    let indexer, handler, hubClient, capable;

    // The price under test rides round index 3, so a case that passes by grading
    // only the first round is still visible.
    function sixRounds(price){
        const rounds = [];
        for(let i = 0; i < 6; i++){
            rounds.push({
                round:          100 + i,
                timestamp:      1700000000 + (i * 600),
                btcBlockHeight: 799000 + i,
                pairs: [{ pair: 'BTC/USD', price: i === 3 ? price : HONEST }],
            });
        }
        return rounds;
    }

    function signBatch(rounds, identities){
        const firstRound     = rounds[0].round;
        const lastRound      = rounds[rounds.length - 1].round;
        const btcBlockHeight = rounds[rounds.length - 1].btcBlockHeight;
        const payload = ed25519.buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds);
        const sigs    = identities.map(id => ({ pubkey: id.pubkey, sig: signWith(id, payload) }));
        return { firstRound, lastRound, btcBlockHeight, rounds, sigs };
    }

    function setCapable(db){
        db.hasCapability.callsFake(async pubkey => capable.has(String(pubkey).toLowerCase()));
        db.getValidatorsByCapability.callsFake(async () => {
            const rows = [...capable].map(pubkey => ({ pubkey, amount: '100' }));
            rows.truncated = false;
            return rows;
        });
    }

    function newHandler(){
        return new Price({
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            hubClient: hubClient,
        });
    }

    // A signed, quorate six-round batch carrying `price` on round index 3.
    function batchWith(price){
        const id = newIdentity();
        capable.add(id.pubkey);
        return signBatch(sixRounds(price), [id]);
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        capable = new Set();

        const db = indexer.indexerDb;
        db.createPrice                 = sinon.stub().resolves();
        db.hasCapability               = sinon.stub();
        db.getValidatorsByCapability   = sinon.stub();
        db.getActiveCapabilityCount    = sinon.stub().resolves(1);
        db.getStakeWeightsByCapability = sinon.stub().resolves([]);
        db.createValidatorReward       = sinon.stub().resolves(true);
        db.enqueueHubPushTx            = sinon.stub().resolves(42);
        db.stageHubPush                = sinon.stub();
        setCapable(db);

        hubClient = { enabled: true, pushPriceBatch: sinon.stub().resolves() };
        handler   = newHandler();

        // The count-quorum path, as the sibling v0 suite drives it.
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });

    afterEach(function () {
        sinon.restore();
    });

    const v0Data = (overrides = {}) =>
        createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, ...overrides });

    // -----------------------------------------------------------------------
    // The shipped map, evaluated with no stub in sight.
    // -----------------------------------------------------------------------
    describe('the rule this node ships', function () {

        it('is UNARMED on mainnet and runs from genesis on testnet/regtest', function () {
            assert.strictEqual(priceScale.PRICE_SCALE_ACTIVATION.mainnet, 9999999999);
            assert.strictEqual(
                priceScale.isPriceScaleCanonicalActive(Math.floor(Date.now() / 1000), 'mainnet'), false);
            assert.strictEqual(priceScale.isPriceScaleCanonicalActive(0, 'testnet'), true);
            assert.strictEqual(priceScale.isPriceScaleCanonicalActive(0, 'regtest'), true);
        });

        it('leaves every value the loose rule admits valid below the gate', function () {
            for(const price of [WIDE, NEAR_ZERO, LEADING_ZEROS, HONEST])
                assert.strictEqual(priceScale.PRICE_VALUE_RE_LEGACY.test(price), true, price);
        });

        it('admits only the canonical form above it, and bounds it to 19 characters', function () {
            assert.strictEqual(priceScale.PRICE_VALUE_RE_CANONICAL.test(HONEST), true);
            for(const price of [WIDE, NEAR_ZERO, LEADING_ZEROS])
                assert.strictEqual(priceScale.PRICE_VALUE_RE_CANONICAL.test(price), false, price);
            // PRICE_MAX is 10_000_000_000 and its ceiling is exclusive, so the integer
            // side is at most 10 digits: 10 + '.' + 8 fits price_snapshots.price twice over.
            const widest = '9999999999.' + '1'.repeat(priceScale.PRICE_SCALE_MAX_DECIMALS);
            assert.strictEqual(priceScale.PRICE_VALUE_RE_CANONICAL.test(widest), true);
            assert.strictEqual(widest.length, 19);
        });
    });

    // -----------------------------------------------------------------------
    // Both sides, through the real parser.
    // -----------------------------------------------------------------------
    describe('the real gate, through _parseV0 on regtest', function () {

        it('AT the gate invalidates the WHOLE batch for an over-wide price', async function () {
            // regtest is genesis-on, so a BLOCK_TIME of 0 or later resolves ACTIVE with
            // no stub: this is the shipped rule refusing the shipped defect.
            const data = v0Data({ BLOCK_TIME: 1700000000 });
            await handler.parse(uncompressedParams(batchBody(batchWith(WIDE))), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('invalid price format'), data['STATUS']);
            assert.strictEqual(data['ROUNDS_JSON'], null, 'nothing partial may be stored');
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called, 'nothing may reach the hub');
        });

        it('AT the gate invalidates the near-zero and leading-zero forms too', async function () {
            for(const price of [NEAR_ZERO, LEADING_ZEROS]){
                indexer.indexerDb.enqueueHubPushTx.resetHistory();
                const data = v0Data({ BLOCK_TIME: 1700000000 });
                await newHandler().parse(uncompressedParams(batchBody(batchWith(price))), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid', price);
                assert.strictEqual(data['ROUNDS_JSON'], null, price);
            }
        });

        it('BELOW the gate, on the fail-closed key, accepts all three verbatim', async function () {
            // A block with no readable time resolves to the legacy pattern, which is what
            // keeps a node that cannot evaluate the gate with the majority.
            for(const price of [WIDE, NEAR_ZERO, LEADING_ZEROS]){
                const data = v0Data({ BLOCK_TIME: null });
                await newHandler().parse(uncompressedParams(batchBody(batchWith(price))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', price);
                assert.ok(String(data['ROUNDS_JSON']).includes(price),
                    price + ' must round-trip into the stored body byte-for-byte');
            }
        });

        it('accepts an all-honest batch on BOTH sides, so arming refuses no real round', async function () {
            for(const blockTime of [null, 0, 1700000000]){
                const data = v0Data({ BLOCK_TIME: blockTime });
                await newHandler().parse(uncompressedParams(batchBody(batchWith(HONEST))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', 'BLOCK_TIME ' + String(blockTime));
                assert.strictEqual(data['ROUND_COUNT'], 6);
            }
        });
    });

    // -----------------------------------------------------------------------
    // A real threshold, so the boundary itself is driven rather than only the
    // two genesis-on/fail-closed poles.
    // -----------------------------------------------------------------------
    describe('the boundary, with the gate armed at an instant', function () {

        const GATE = 1755000000;

        function armGateAt(threshold){
            sinon.stub(priceScale, 'priceValuePattern').callsFake(
                (blockTime) => parseInt(blockTime) >= threshold
                    ? priceScale.PRICE_VALUE_RE_CANONICAL
                    : priceScale.PRICE_VALUE_RE_LEGACY);
        }

        it('accepts the over-wide price one second below the instant and refuses it at the instant', async function () {
            armGateAt(GATE);

            const below = v0Data({ BLOCK_TIME: GATE - 1 });
            await newHandler().parse(uncompressedParams(batchBody(batchWith(WIDE))), below, null);
            assert.strictEqual(below['STATUS'], 'valid', 'history below the instant must not move');
            assert.ok(String(below['ROUNDS_JSON']).includes(WIDE));

            const at = v0Data({ BLOCK_TIME: GATE });
            await newHandler().parse(uncompressedParams(batchBody(batchWith(WIDE))), at, null);
            assert.strictEqual(at['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(at['STATUS']).includes('invalid price format'), at['STATUS']);
        });

        it('leaves the honest batch valid across the instant', async function () {
            armGateAt(GATE);
            for(const blockTime of [GATE - 1, GATE, GATE + 1]){
                const data = v0Data({ BLOCK_TIME: blockTime });
                await newHandler().parse(uncompressedParams(batchBody(batchWith(HONEST))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', 'BLOCK_TIME ' + blockTime);
            }
        });
    });
});
