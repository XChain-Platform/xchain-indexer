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
// The real-crypto wire builders and the mock harness the whole PRICE batch
// suite runs on. The suite is price_batch.test.js plus the files in
// price_batch.test/; each file keeps its own indexer/handler/hubClient/capable
// names and fills them through usePriceBatchHarness, so the test bodies read
// exactly as they did when the suite was one file.

'use strict';

const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../../../fixtures/mocks');
const { getTestConfig } = require('../../../../../fixtures/config');

const Price   = require('../../../../../../src/actions/price/index.js');
const ed25519 = require('../../../../../../src/consensus/ed25519.js');
const swq     = require('../../../../../../src/consensus/stake_weighted_quorum.js');
const comp    = require('../../../../../../src/actions/price/price_batch_compression.js');

// ---------------------------------------------------------------------------
// Real Ed25519 identities. The 64-hex pubkey the wire carries is the raw key
// bytes, which sit after the 12-byte SPKI prefix ed25519.js prepends to verify.
// ---------------------------------------------------------------------------
function newIdentity(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    return { pubkey: raw.toString('hex'), privateKey };
}
function signWith(identity, payload){
    return crypto.sign(null, Buffer.from(payload, 'utf8'), identity.privateKey).toString('hex');
}

// The network every batch here is signed for: the mock indexer's own, read from the
// config fixture so the signing key and the verifying key cannot be typed apart.
const HARNESS_NETWORK = getTestConfig().NETWORK;

// ---------------------------------------------------------------------------
// Wire construction. `body` is the field list AFTER "PRICE|0|", which is
// exactly the string the compressed form deflates.
// ---------------------------------------------------------------------------
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
const compressedParams   = body => ['2', comp.PRICE_BATCH_COMPRESSION_MARKER,
                                    comp.compressPriceBatchBody(body.join('|'))];

// A six-round window, the shape the batch publisher assembles at the default
// ORACLE_BATCH_WINDOW_ROUNDS of 6.
function sixRounds(overrides = {}){
    const first  = overrides.firstRound !== undefined ? overrides.firstRound : 100;
    const anchor = overrides.anchorBase !== undefined ? overrides.anchorBase : 799000;
    const rounds = [];
    for(let i = 0; i < 6; i++){
        rounds.push({
            round:          first + i,
            timestamp:      1700000000 + (i * 600),
            btcBlockHeight: anchor + i,
            pairs: [
                { pair: 'BTC/USD', price: '50000.00' },
                { pair: 'LTC/USD', price: '95.5' },
            ],
        });
    }
    return rounds;
}

// Build and SIGN a batch with the real canonical builder.
//
// `opts.network` is HALF the admission activation key and defaults to the network
// the mock indexer's own config carries, so these bytes and the ones
// batch_signatures.js rebuilds from config['NETWORK'] are keyed alike. It is named
// rather than omitted because buildPriceBatchPayload reads an absent fifth argument
// as the inert network and rebuilds the LEGACY canonical without complaint: an
// admission-era batch signed that way carries signatures no verifier reproduces,
// and the red surfaces as a bogus signature failure far from this line.
function signBatch(rounds, identities, opts = {}){
    const firstRound     = opts.firstRound     !== undefined ? opts.firstRound     : rounds[0].round;
    const lastRound      = opts.lastRound      !== undefined ? opts.lastRound      : rounds[rounds.length - 1].round;
    const btcBlockHeight = opts.btcBlockHeight !== undefined ? opts.btcBlockHeight : rounds[rounds.length - 1].btcBlockHeight;
    const network        = opts.network        !== undefined ? opts.network        : HARNESS_NETWORK;
    const payload = ed25519.buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds, network);
    const sigs    = identities.map(id => ({ pubkey: id.pubkey, sig: signWith(id, payload) }));
    return { firstRound, lastRound, btcBlockHeight, rounds, sigs, payload };
}

// Both capability APIs answer from ONE set, the way db.js drives them from one
// effectiveCapabilitySetSql: a case that says who qualifies stays honest
// whichever path the parser takes (batched set, or the truncation fallback).
function setCapable(db, capable){
    db.hasCapability.callsFake(async pubkey => capable.has(String(pubkey).toLowerCase()));
    db.getValidatorsByCapability.callsFake(async () => {
        const rows = [...capable].map(pubkey => ({ pubkey, amount: '100' }));
        rows.truncated = false;
        return rows;
    });
}

// A Price handler on a harness's mock indexer, pushing through `hubClient`.
function newPriceHandler(indexer, hubClient){
    return new Price({
        config:    indexer.config,
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        hubClient: hubClient,
    });
}

// The suite's hooks, installed in the calling describe: a fresh mock indexer and
// price-capable set before every test, handed to `bind` (which builds the
// calling file's handler) before the quorum stub goes in; every sinon stub
// restored after it.
function usePriceBatchHarness(bind) {
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
        setCapable(db, capable);

        const hubClient = { enabled: true, pushPriceBatch: sinon.stub().resolves() };
        bind({ indexer, capable, hubClient });

        // The count-quorum path. Regtest activates STAKE_WEIGHTED_QUORUM at genesis, so
        // without this stub every case would run the weighted path; the weighted path has
        // its own case below.
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });

    afterEach(function () {
        sinon.restore();
    });
}

const v2Data = (overrides = {}) =>
    createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, ...overrides });

// A signed, quorate six-round batch with one price-capable signer.
function validBatchFor(capable){
    const id = newIdentity();
    capable.add(id.pubkey);
    return signBatch(sixRounds(), [id]);
}

module.exports = {
    newIdentity, signWith, batchBody, uncompressedParams, compressedParams, sixRounds,
    signBatch, v2Data, newPriceHandler, validBatchFor, usePriceBatchHarness, HARNESS_NETWORK,
};
