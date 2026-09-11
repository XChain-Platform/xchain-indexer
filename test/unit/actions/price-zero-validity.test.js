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
// test/unit/actions/price-zero-validity.test.js
//
// PRICE price-RANGE flag day, chain side.
//
// The hub refuses any pair price not strictly inside (0, PRICE_MAX) at all three
// of its ingest points; the chain checked only the decimal pattern. So a
// quorum-signed '0' or at-ceiling price was CHAIN-VALID and HUB-INVALID, and
// because one signature set covers a whole batch window, the hub threw away the
// entire hour of prices the round rode in without a word.
//
// What this suite pins is AGREEMENT, not the presence of a check: the hub's own
// admission expression is transcribed here as the reference oracle and the
// chain's verdict is compared against it on both sides of both bounds, including
// the value where the transcription is surprising ('9999999999.99999999', the
// widest string the scale rule admits, which parseFloat rounds up to exactly
// PRICE_MAX and the hub therefore refuses). Both sides of the gate are driven
// through the REAL parser on a real signed batch, because the claim that matters
// is not "a check exists" but "a replay below the flag day reaches the same
// verdict it reaches today".

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Price      = require('../../../src/actions/price.js');
const ed25519    = require('../../../src/ed25519.js');
const swq        = require('../../../src/stake_weighted_quorum.js');
const priceRange = require('../../../src/price_zero_validity_activation.js');

// The hub's admission predicate, transcribed from PriceAggregator's ingest sites
// (`!(parseFloat(String(p.price)) > 0) || !(parseFloat(String(p.price)) < PRICE_MAX)`
// refuses). This is the ORACLE for every agreement case below: it is written out
// rather than required so this suite needs no hub checkout, and a drift alarm
// further down re-reads the hub source when it is present.
const HUB_PRICE_MAX = 10000000000;
function hubAdmits(price){
    let p = parseFloat(String(price));
    if(!(p > 0))              return false;
    if(!(p < HUB_PRICE_MAX))  return false;
    return true;
}

// Values spanning both bounds, the near-miss on each side, and the shapes a
// Byzantine signer would reach for. Every one of them clears the v0 wire's
// canonical scale rule except where noted, so none of them is refused earlier.
const RANGE_CASES = [
    '0',                        // the zero this item is named for: hub-invalid, chain-valid before the fix
    '0.00000000',               // zero in canonical 8-decimal form, which the scale rule admits
    '0.00000001',               // smallest canonical positive value: admitted
    '1',                        // admitted
    '50000.00000000',           // what bcformat(price, 8) emits for a real BTC/USD print
    '9999999999',               // just under the ceiling and still under it as a double
    '9999999999.999',           // the widest admitted value measured: an ulp near 1e10 is about 2e-6
    '9999999999.99999998',      // inside the ceiling exactly, but rounds UP to it as a double
    '9999999999.99999999',      // widest canonical string; also rounds UP to the ceiling
    '10000000000',              // AT the exclusive ceiling
    '10000000000.00000000',
    '99999999999999999999',     // far above it
];

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

const HONEST = '50000.00000000';

// The shipped testnet instant, so the boundary cases read against the map rather
// than against a number typed twice.
const TESTNET_GATE = priceRange.PRICE_ZERO_VALIDITY_ACTIVATION.testnet;

describe('PRICE price-range flag day @regression @tier3', function () {

    let indexer, capable, hubClient;

    // The price under test rides round index 3, so a case that would pass by
    // grading only the first round of a window is still visible.
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

    // A handler bound to `network`, so the SHIPPED map is what grades the action
    // (no stub anywhere in the range cases below).
    function newHandler(network){
        const config = network ? Object.assign({}, indexer.config, { NETWORK: network }) : indexer.config;
        return new Price({
            config:    config,
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
        db.getPushGeneration           = sinon.stub().resolves(1);
        setCapable(db);

        hubClient = { enabled: true, pushPriceBatch: sinon.stub().resolves() };

        // The count-quorum path, as the sibling v0 suites drive it.
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
    describe('the posture this node ships', function () {

        it('leaves mainnet inert at every instant, so the legacy path runs byte for byte', function () {
            assert.strictEqual(priceRange.PRICE_ZERO_VALIDITY_ACTIVATION.mainnet, null);
            for(const t of [0, 1, 1700000000, 4000000000])
                assert.strictEqual(priceRange.isPriceZeroValidityActive(t, 'mainnet'), false, 'mainnet t=' + t);
        });

        it('arms testnet at its instant and not one second earlier', function () {
            assert.ok(Number.isFinite(TESTNET_GATE) && TESTNET_GATE > 0);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(TESTNET_GATE - 1, 'testnet'), false);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(TESTNET_GATE, 'testnet'), true);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(TESTNET_GATE + 1, 'testnet'), true);
            // Sized with headroom: the instant must still be ahead of the tree's own
            // build time, or it shipped already armed with no deploy wave behind it.
            assert.ok(TESTNET_GATE > 1789000000, 'the testnet instant must be sized in the future');
        });

        it('arms regtest from genesis so the oracle venue exercises the armed rule', function () {
            assert.strictEqual(priceRange.PRICE_ZERO_VALIDITY_ACTIVATION.regtest, 0);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(0, 'regtest'), true);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(1700000000, 'regtest'), true);
        });

        it('fails CLOSED on an unusable key, leaving the legacy behaviour', function () {
            // An unknown network, and every empty-ish block time that Number() would
            // otherwise map to a perfectly finite 0 and read as armed on regtest.
            assert.strictEqual(priceRange.isPriceZeroValidityActive(0, 'signet'), false);
            for(const t of [null, undefined, '', false, true, 'abc', NaN])
                assert.strictEqual(priceRange.isPriceZeroValidityActive(t, 'regtest'), false,
                    'block time ' + String(t) + ' must fail closed');
            // Failing closed means NO range test, i.e. the value is admitted.
            assert.strictEqual(priceRange.isPriceRangeValid('0', null, 'regtest'), true);
            assert.strictEqual(priceRange.isPriceRangeValid('0', 1700000000, 'mainnet'), true);
        });
    });

    // -----------------------------------------------------------------------
    // Agreement with the hub, value by value.
    // -----------------------------------------------------------------------
    describe('agreement with the hub bound', function () {

        it('reads the same ceiling the hub reads', function () {
            assert.strictEqual(priceRange.PRICE_MAX, HUB_PRICE_MAX);
        });

        it('matches the hub verdict on every case, both sides of both bounds', function () {
            // At least one case must land on each side, or a predicate that answered a
            // constant would pass this table.
            let admitted = 0, refused = 0;
            for(const price of RANGE_CASES){
                const expected = hubAdmits(price);
                assert.strictEqual(priceRange.isPriceInHubRange(price), expected,
                    'price ' + price + ' must be ' + (expected ? 'admitted' : 'refused'));
                expected ? admitted++ : refused++;
            }
            assert.ok(admitted >= 4 && refused >= 4, 'the table must exercise both verdicts');
        });

        it('refuses the widest canonical string, because the hub does', function () {
            // 9999999999.99999999 is 19 characters and scale-legal, but an ulp near 1e10
            // is 1.907e-6, so parseFloat rounds to exactly PRICE_MAX every value within
            // half of that (about 9.5e-7) of the ceiling. Exact math would ADMIT them
            // here and hand the hub rounds it discards, which is this item's defect with
            // a smaller footprint. Agreement is the requirement, so the chain refuses
            // the same top sliver of the range the hub refuses, and admits the rest.
            for(const price of ['9999999999.99999999', '9999999999.99999998', '9999999999.9999999'])
                assert.strictEqual(priceRange.isPriceInHubRange(price), false, price);
            for(const price of ['9999999999.999999', '9999999999.999'])
                assert.strictEqual(priceRange.isPriceInHubRange(price), true, price);
            assert.strictEqual(priceRange.isPriceInHubRange('9999999999'), true);
        });

        it('refuses an unparseable value at both ends rather than admitting NaN', function () {
            for(const price of ['', 'abc', 'NaN', undefined, null, {}])
                assert.strictEqual(priceRange.isPriceInHubRange(price), false, String(price));
        });

        it('still carries the same expression the hub carries, when the hub tree is present', function () {
            // Drift alarm rather than the oracle: the transcription above is what grades
            // every case, and this re-reads the hub source when a sibling checkout exists.
            const hubSrc = path.join(__dirname, '..', '..', '..', '..', 'xchain-hub', 'src', 'PriceAggregator.js');
            if(!fs.existsSync(hubSrc)) return this.skip();
            const text = fs.readFileSync(hubSrc, 'utf8');
            const lower = /!\(parseFloat\(String\(p\.price\)\) > 0\)/g;
            const upper = /!\(parseFloat\(String\(p\.price\)\) < PRICE_MAX\)/g;
            assert.strictEqual((text.match(lower) || []).length, 2,
                'both hub v0 ingest sites must still carry the transcribed lower bound');
            assert.strictEqual((text.match(upper) || []).length, 2,
                'both hub v0 ingest sites must still carry the transcribed upper bound');
        });
    });

    // -----------------------------------------------------------------------
    // Both sides of the flag day, through the real parser.
    // -----------------------------------------------------------------------
    describe('the real gate, through the v0 batch parser', function () {

        it('AT the gate invalidates the WHOLE batch for a zero price', async function () {
            // regtest is genesis-armed, so this is the shipped rule refusing the shipped
            // defect with no stub involved.
            const data = v0Data({ BLOCK_TIME: 1700000000 });
            await newHandler().parse(uncompressedParams(batchBody(batchWith('0'))), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('invalid price range'), data['STATUS']);
            assert.strictEqual(data['ROUNDS_JSON'], null, 'nothing partial may be stored');
            assert.strictEqual(data['SIGS_JSON'], null);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called, 'nothing may reach the hub');
        });

        it('AT the gate refuses every value the hub refuses and accepts every value it admits', async function () {
            for(const price of RANGE_CASES){
                indexer.indexerDb.enqueueHubPushTx.resetHistory();
                const data = v0Data({ BLOCK_TIME: 1700000000 });
                await newHandler().parse(uncompressedParams(batchBody(batchWith(price))), data, null);

                if(hubAdmits(price)){
                    assert.strictEqual(data['STATUS'], 'valid', price + ' is hub-valid and must be chain-valid');
                    assert.ok(String(data['ROUNDS_JSON']).includes(price), price + ' must round-trip into the stored body');
                    assert.ok(indexer.indexerDb.enqueueHubPushTx.calledOnce, price + ' must reach the hub');
                } else {
                    assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                        price + ' is hub-invalid and must be chain-invalid');
                    assert.strictEqual(data['ROUNDS_JSON'], null, price);
                    assert.ok(!indexer.indexerDb.enqueueHubPushTx.called, price);
                }
            }
        });

        it('BELOW the gate accepts the out-of-range values verbatim, so a replay does not move', async function () {
            // The live testnet ledger one second before its instant: the legacy verdict,
            // and the value must round-trip into rounds_json byte for byte.
            for(const price of RANGE_CASES.filter(p => !hubAdmits(p))){
                const data = v0Data({ BLOCK_TIME: TESTNET_GATE - 1 });
                await newHandler('testnet').parse(uncompressedParams(batchBody(batchWith(price))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', price + ' must stay valid below the instant');
                assert.ok(String(data['ROUNDS_JSON']).includes(price),
                    price + ' must round-trip into the stored body byte-for-byte');
            }
        });

        it('AT the testnet instant refuses them, and the fixture crosses a real boundary', async function () {
            for(const price of RANGE_CASES.filter(p => !hubAdmits(p))){
                const data = v0Data({ BLOCK_TIME: TESTNET_GATE });
                await newHandler('testnet').parse(uncompressedParams(batchBody(batchWith(price))), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid', price + ' must be refused at the instant');
                assert.ok(String(data['STATUS']).includes('invalid price range'), data['STATUS']);
            }
        });

        it('leaves an inert network and an unreadable block time on the legacy path', async function () {
            for(const [network, blockTime] of [['mainnet', 1700000000], ['mainnet', TESTNET_GATE], ['regtest', null]]){
                const data = v0Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(uncompressedParams(batchBody(batchWith('0'))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', network + ' t=' + String(blockTime));
                assert.ok(String(data['ROUNDS_JSON']).includes('"price":"0"'), 'the zero must be stored verbatim');
            }
        });

        it('accepts an all-honest batch on BOTH sides, so arming refuses no real round', async function () {
            for(const [network, blockTime] of [['mainnet', 1700000000], ['testnet', TESTNET_GATE - 1],
                                               ['testnet', TESTNET_GATE], ['regtest', 1700000000], ['regtest', null]]){
                const data = v0Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(uncompressedParams(batchBody(batchWith(HONEST))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', network + ' t=' + String(blockTime));
                assert.strictEqual(data['ROUND_COUNT'], 6);
            }
        });
    });

    // -----------------------------------------------------------------------
    // v1, the same seam on the action version whose loss is never re-derivable.
    // -----------------------------------------------------------------------
    describe('the v1 user oracle price', function () {

        const v1Params = (value) => ['1', 'BTC', 'TEST', 'USD', value, '0', 'm'];
        const v1Data   = (overrides = {}) => createBaseData({ ACTION: 'PRICE', FORMAT: 1, ...overrides });

        // The v1 regex caps the decimal side at 8 places, so only the cases that clear
        // it can reach the range bound at all.
        const V1_CASES = RANGE_CASES.filter(p => /^[0-9]+(\.[0-9]{1,8})?$/.test(p));

        it('AT the gate agrees with the hub v1 bound on every case', async function () {
            for(const value of V1_CASES){
                const data = v1Data({ BLOCK_TIME: 1700000000 });
                await newHandler().parse(v1Params(value), data, null);
                if(hubAdmits(value))
                    assert.strictEqual(data['VALIDATION_STATUS'], 'valid', value + ' is hub-valid');
                else
                    assert.ok(String(data['STATUS']).includes('VALUE'),
                        value + ' must be refused: ' + data['STATUS']);
            }
        });

        it('AT the gate refuses the at-ceiling value the lower-bound check alone let through', async function () {
            const data = v1Data({ BLOCK_TIME: 1700000000 });
            await newHandler().parse(v1Params('10000000000.00000000'), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('range'), data['STATUS']);
        });

        it('BELOW the gate leaves the at-ceiling value valid, so a replay does not move', async function () {
            for(const [network, blockTime] of [['mainnet', 1700000000], ['testnet', TESTNET_GATE - 1], ['regtest', null]]){
                const data = v1Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(v1Params('10000000000.00000000'), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid', network + ' t=' + String(blockTime));
            }
        });

        it('refuses zero on both sides, because the lower bound predates this flag day', async function () {
            // The existing exact-bcmath positivity check is NOT gated and must not become
            // gated by this change: a zero v1 value was already invalid everywhere.
            for(const [network, blockTime] of [['mainnet', 1700000000], ['regtest', 1700000000], ['regtest', null]]){
                const data = v1Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(v1Params('0'), data, null);
                assert.ok(String(data['STATUS']).includes('VALUE'), network + ' t=' + String(blockTime));
            }
        });

        it('leaves an honest value valid on both sides', async function () {
            for(const [network, blockTime] of [['mainnet', 1700000000], ['testnet', TESTNET_GATE], ['regtest', 1700000000]]){
                const data = v1Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(v1Params('50000.12345678'), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid', network + ' t=' + String(blockTime));
            }
        });
    });
});
