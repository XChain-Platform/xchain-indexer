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
// The hub oracle, the value table, the real-crypto wire builders and the mock
// harness the whole PRICE price-range suite runs on. The suite is
// price_zero_validity.test.js plus the files in price_zero_validity.test/; each
// file keeps its own indexer/capable/hubClient names and fills them through
// usePriceRangeHarness, so the test bodies read exactly as they did when the
// suite was one file.

'use strict';

const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');

const Price      = require('../../../../../src/actions/price/index.js');
const ed25519    = require('../../../../../src/consensus/ed25519.js');
const swq        = require('../../../../../src/consensus/stake_weighted_quorum.js');
const priceRange = require('../../../../../src/actions/price/price_zero_validity_gate.js');

// The hub's admission predicate, transcribed from PriceAggregator's ingest sites
// (`!(parseFloat(String(p.price)) > 0) || !(parseFloat(String(p.price)) < PRICE_MAX)`
// refuses). This is the ORACLE for every agreement case below: it is written out
// rather than required so this suite needs no hub checkout, and a drift alarm
// in agreement_with_hub_bound.test.js re-reads the hub source when it is present.
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

// Both capability APIs answer from the one `capable` set.
function setCapable(db, capable){
    db.hasCapability.callsFake(async pubkey => capable.has(String(pubkey).toLowerCase()));
    db.getValidatorsByCapability.callsFake(async () => {
        const rows = [...capable].map(pubkey => ({ pubkey, amount: '100' }));
        rows.truncated = false;
        return rows;
    });
}

// A handler bound to `network`, so the SHIPPED map is what grades the action
// (no stub anywhere in the range cases below).
function newRangeHandler(indexer, hubClient, network){
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
function batchWithFor(capable, price){
    const id = newIdentity();
    capable.add(id.pubkey);
    return signBatch(sixRounds(price), [id]);
}

// The suite's hooks, installed in the calling describe: a fresh mock indexer and
// price-capable set before every test, handed to `bind` when the calling file
// needs them; every sinon stub restored after it.
function usePriceRangeHarness(bind = () => {}) {
    beforeEach(function () {
        const indexer = createMockIndexer();
        const capable = new Set();

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
        setCapable(db, capable);

        const hubClient = { enabled: true, pushPriceBatch: sinon.stub().resolves() };
        bind({ indexer, capable, hubClient });

        // The count-quorum path, as the sibling v0 suites drive it.
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });

    afterEach(function () {
        sinon.restore();
    });
}

const v0Data = (overrides = {}) =>
    createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, ...overrides });

module.exports = {
    HUB_PRICE_MAX, hubAdmits, RANGE_CASES, newIdentity, signWith, batchBody, uncompressedParams,
    HONEST, TESTNET_GATE, sixRounds, signBatch, newRangeHandler, batchWithFor, v0Data,
    usePriceRangeHarness,
};
