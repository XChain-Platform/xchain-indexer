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
// test/unit/actions/priceV2Batch.test.js
//
// PRICE v2 (_parseV2): the consensus parser that decides, on every indexing
// node, whether a batch is valid.
//
// Everything here is driven through a REAL six-round batch: real Ed25519
// identities from node crypto, signatures over the real canonical from
// ed25519.buildPriceV2Payload, and the real deflate/base64 from
// price_v2_compression.js. No hand-written canonical string appears in this
// file, because a hand-written one pins the test's idea of the canonical rather
// than the parser's.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const zlib   = require('zlib');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Price         = require('../../../src/actions/price.js');
const ed25519       = require('../../../src/ed25519.js');
const swq           = require('../../../src/stake_weighted_quorum.js');
const priceSigTally = require('../../../src/price_sig_tally_activation.js');
const priceBatch    = require('../../../src/price_batch_activation.js');
const comp          = require('../../../src/price_v2_compression.js');

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

// ---------------------------------------------------------------------------
// Wire construction. `body` is the field list AFTER "PRICE|2|", which is
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
const compressedParams   = body => ['2', comp.PRICE_V2_COMPRESSION_MARKER,
                                    comp.compressPriceV2Body(body.join('|'))];

// A six-round window, the shape section 7's publisher assembles at the default
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
function signBatch(rounds, identities, opts = {}){
    const firstRound     = opts.firstRound     !== undefined ? opts.firstRound     : rounds[0].round;
    const lastRound      = opts.lastRound      !== undefined ? opts.lastRound      : rounds[rounds.length - 1].round;
    const btcBlockHeight = opts.btcBlockHeight !== undefined ? opts.btcBlockHeight : rounds[rounds.length - 1].btcBlockHeight;
    const payload = ed25519.buildPriceV2Payload(firstRound, lastRound, btcBlockHeight, rounds);
    const sigs    = identities.map(id => ({ pubkey: id.pubkey, sig: signWith(id, payload) }));
    return { firstRound, lastRound, btcBlockHeight, rounds, sigs, payload };
}

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    let indexer, handler, hubClient, capable;

    // Both capability APIs answer from ONE set, the way db.js drives them from one
    // _effectiveCapabilitySetSql: a case that says who qualifies stays honest
    // whichever path the parser takes (batched set, or the truncation fallback).
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

        // The count-quorum path. Regtest activates STAKE_WEIGHTED_QUORUM at genesis, so
        // without this stub every case would run the weighted path; the weighted path has
        // its own case below.
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });

    afterEach(function () {
        sinon.restore();
    });

    const v2Data = (overrides = {}) =>
        createBaseData({ ACTION: 'PRICE', FORMAT: 2, BLOCK_INDEX: 100, ...overrides });

    // A signed, quorate six-round batch with one price-capable signer.
    function validBatch(){
        const id = newIdentity();
        capable.add(id.pubkey);
        return signBatch(sixRounds(), [id]);
    }

    // -----------------------------------------------------------------------
    // 1. Activation gate
    // -----------------------------------------------------------------------
    describe('activation gate (step 1)', function () {

        it('below the gate records the EXACT unknown-VERSION status, byte-identical to today', async function () {
            // D18: the string a v2 records below its flag day must be the one an unknown
            // FORMAT already records, or a from-genesis reindex of the existing chain writes
            // a status the deployed fleet never wrote. Compared by identity, not by substring.
            sinon.stub(priceBatch, 'isPriceBatchActive').returns(false);
            const batch = validBatch();
            const data  = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);

            assert.strictEqual(data['STATUS'], 'invalid: VERSION (unknown)');
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(data['VERSION'], 2);
            // Recorded, not dropped, exactly as the unknown-format arm records it.
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
        });

        it('below the gate the string matches what an unknown FORMAT records, character for character', async function () {
            sinon.stub(priceBatch, 'isPriceBatchActive').returns(false);
            const gated = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), gated, null);

            const unknown = createBaseData({ ACTION: 'PRICE', FORMAT: 9 });
            await newHandler().parse(['9'], unknown, null);

            assert.strictEqual(gated['STATUS'], unknown['STATUS']);
        });

        it('below the gate nothing is parsed, stored as a batch, or pushed', async function () {
            sinon.stub(priceBatch, 'isPriceBatchActive').returns(false);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);

            assert.strictEqual(data['BATCH_FIRST_ROUND'], undefined);
            assert.strictEqual(data['ROUNDS_JSON'], undefined);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
            assert.ok(!indexer.indexerDb.stageHubPush.called);
        });

        it('an upstream error still wins below the gate, as it does on the unknown-format arm', async function () {
            sinon.stub(priceBatch, 'isPriceBatchActive').returns(false);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, 'invalid: upstream');
            assert.strictEqual(data['STATUS'], 'invalid: upstream');
        });

        it('the gate is keyed on this action BLOCK_TIME, and fails closed on a missing one', async function () {
            const spy   = sinon.spy(priceBatch, 'isPriceBatchActive');
            const batch = validBatch();
            await handler.parse(uncompressedParams(batchBody(batch)), v2Data({ BLOCK_TIME: 1755000000 }), null);
            assert.strictEqual(spy.getCall(0).args[0], 1755000000);
            assert.strictEqual(spy.getCall(0).args[1], 'regtest');

            const missing = v2Data({ BLOCK_TIME: null });
            await newHandler().parse(uncompressedParams(batchBody(batch)), missing, null);
            assert.strictEqual(missing['STATUS'], 'invalid: VERSION (unknown)');
        });
    });

    // -----------------------------------------------------------------------
    // 2. Decompression
    // -----------------------------------------------------------------------
    describe('decompression (step 2)', function () {

        it('accepts a real six-round batch in the COMPRESSED form', async function () {
            const data = v2Data();
            await handler.parse(compressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['ROUND_COUNT'], 6);
        });

        // THE form-agnostic property. Everything downstream of the inflate reads one
        // body, so the two wire forms cannot diverge in validity, in what is stored, or
        // in what is pushed. This is the case that fails the moment a fallback treats an
        // undecodable compressed field as an uncompressed body.
        it('the two wire forms produce IDENTICAL status and IDENTICAL stored rows', async function () {
            const batch = validBatch();
            const body  = batchBody(batch);

            const plain = v2Data({ ACTION_INDEX: 1 });
            await handler.parse(uncompressedParams(body), plain, null);

            const squeezed = v2Data({ ACTION_INDEX: 1 });
            await newHandler().parse(compressedParams(body), squeezed, null);

            assert.strictEqual(plain['STATUS'], 'valid');
            assert.strictEqual(plain['STATUS'], squeezed['STATUS']);
            assert.strictEqual(plain['VALIDATION_STATUS'], squeezed['VALIDATION_STATUS']);
            for(const key of ['ROUND', 'BTC_BLOCK_HEIGHT', 'BATCH_FIRST_ROUND', 'BATCH_LAST_ROUND',
                              'ROUND_COUNT', 'ROUNDS_JSON', 'SIGS_JSON', 'PAIR_COUNT',
                              'PAIRS_JSON', 'SIG_COUNT'])
                assert.deepStrictEqual(plain[key], squeezed[key], 'stored ' + key + ' must not depend on the wire form');

            // And the same for what reaches the hub.
            const plainPush    = indexer.indexerDb.stageHubPush.firstCall.args[0].payload;
            const squeezedPush = indexer.indexerDb.stageHubPush.secondCall.args[0].payload;
            assert.deepStrictEqual(plainPush, squeezedPush);
        });

        it('an INVALID batch is equally invalid in both forms, with the same status', async function () {
            // Same falsification, other direction: a form-dependent parser could reject one
            // form for a structural reason the other never reaches.
            const batch = validBatch();
            const body  = batchBody(batch);
            body[0] = String(batch.lastRound + 1);   // FIRST_ROUND > LAST_ROUND

            const plain = v2Data();
            await handler.parse(uncompressedParams(body), plain, null);
            const squeezed = v2Data();
            await newHandler().parse(compressedParams(body), squeezed, null);

            assert.strictEqual(plain['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(plain['STATUS'], squeezed['STATUS']);
        });

        it('records the compression module reason verbatim for non-canonical base64', async function () {
            const field = comp.compressPriceV2Body(batchBody(validBatch()).join('|'));
            // URL-safe alphabet is a DIFFERENT encoding of the same bytes: one wire, one meaning.
            const data = v2Data();
            await handler.parse(['2', 'Z', field.replace(/\+/g, '-').replace(/\//g, '_')], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: COMPRESSION (non-canonical-base64)');
        });

        it('records ratio-cap for a small zip bomb and size-cap for a large one', async function () {
            // 9,000 bytes of one repeated byte deflate to ~26, a ratio near 350:1, so the
            // RATIO cap binds first. 200,000 bytes deflate to ~212, whose ratio cap of
            // ~31,800 sits above the wire ceiling, so the SIZE cap binds.
            const bomb = n => zlib.deflateRawSync(Buffer.alloc(n, 0x41), { level: 9 }).toString('base64');

            const small = v2Data();
            await handler.parse(['2', 'Z', bomb(9000)], small, null);
            assert.strictEqual(small['STATUS'], 'invalid: COMPRESSION (ratio-cap)');

            const large = v2Data();
            await newHandler().parse(['2', 'Z', bomb(200000)], large, null);
            assert.strictEqual(large['STATUS'], 'invalid: COMPRESSION (size-cap)');
        });

        it('records inflate-failed on bytes that are canonical base64 but not a deflate stream', async function () {
            const data = v2Data();
            await handler.parse(['2', 'Z', Buffer.from('not a deflate stream at all').toString('base64')], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: COMPRESSION (inflate-failed)');
        });

        it('records not-a-string when the marker carries no field at all', async function () {
            const data = v2Data();
            await handler.parse(['2', 'Z'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: COMPRESSION (not-a-string)');
        });

        it('NEVER falls back to reading an undecodable compressed field as an uncompressed body', async function () {
            // The fallback's signature is a STRUCTURAL status (the parser having read `Z` as
            // FIRST_ROUND) instead of a COMPRESSION one, or worse, a valid action.
            for(const field of ['!!!not base64!!!', 'QR==', '']){
                const data = v2Data();
                await newHandler().parse(['2', 'Z', field], data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
                assert.ok(data['STATUS'].startsWith('invalid: COMPRESSION ('),
                    'field ' + JSON.stringify(field) + ' must record a COMPRESSION reason, got ' + data['STATUS']);
            }
        });

        it('a compression failure stores nothing batch-shaped and pushes nothing', async function () {
            const data = v2Data();
            await handler.parse(['2', 'Z', 'QR=='], data, null);
            assert.strictEqual(data['BATCH_FIRST_ROUND'], undefined);
            assert.strictEqual(data['ROUNDS_JSON'], null);
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
        });
    });

    // -----------------------------------------------------------------------
    // 3. Structural checks
    // -----------------------------------------------------------------------
    describe('structural checks (step 3)', function () {

        it('rejects FIRST_ROUND > LAST_ROUND', async function () {
            const body = batchBody(validBatch());
            body[0] = '106'; body[1] = '105';
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('ROUND window'));
        });

        it('rejects a non-integer or negative window bound', async function () {
            for(const [idx, value] of [[0, 'abc'], [0, '-1'], [1, ''], [2, 'x'], [3, '0.5']]){
                const body = batchBody(validBatch());
                body[idx] = value;
                const data = v2Data();
                await newHandler().parse(uncompressedParams(body), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                    'field ' + idx + ' = ' + JSON.stringify(value) + ' must invalidate');
            }
        });

        // THE DoS BOUND (D15). The count is attacker-supplied and drives the parse loop on
        // every indexing node, so it is bounded BEFORE the loop runs. This case is the
        // behavioural pin: the batch below is otherwise perfect (real signatures over the
        // real canonical, quorate, ascending, in-window), so with the bound it is INVALID
        // and without the bound it is VALID and stored.
        it('rejects a fully-signed, otherwise-valid batch of 300 rounds', async function () {
            const rounds = [];
            for(let i = 0; i < 300; i++)
                rounds.push({ round: 1000 + i, timestamp: 1700000000 + i, btcBlockHeight: 799000 + i,
                              pairs: [{ pair: 'BTC/USD', price: '50000' }] });
            const id = newIdentity();
            capable.add(id.pubkey);
            const batch = signBatch(rounds, [id]);

            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                'a 300-round batch must be refused by the ROUND_COUNT bound, not accepted');
            assert.ok(data['STATUS'].includes('ROUND_COUNT'), data['STATUS']);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
        });

        it('refuses an enormous ROUND_COUNT without entering the parse loop', async function () {
            const body = batchBody(validBatch());
            body[3] = '4000000000';
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes(String(comp.PRICE_V2_MAX_ROUND_COUNT)), data['STATUS']);
        });

        it('accepts exactly PRICE_V2_MAX_ROUND_COUNT and refuses one more', async function () {
            const make = n => {
                const rounds = [];
                for(let i = 0; i < n; i++)
                    rounds.push({ round: 1000 + i, timestamp: 1700000000 + i, btcBlockHeight: 799000 + i,
                                  pairs: [{ pair: 'BTC/USD', price: '50000' }] });
                const id = newIdentity();
                capable.add(id.pubkey);
                return signBatch(rounds, [id]);
            };
            const at = v2Data();
            await handler.parse(uncompressedParams(batchBody(make(comp.PRICE_V2_MAX_ROUND_COUNT))), at, null);
            assert.strictEqual(at['STATUS'], 'valid');

            const over = v2Data();
            await newHandler().parse(uncompressedParams(batchBody(make(comp.PRICE_V2_MAX_ROUND_COUNT + 1))), over, null);
            assert.strictEqual(over['VALIDATION_STATUS'], 'invalid');
        });

        it('rejects a ROUND_COUNT that does not match the round blocks actually present', async function () {
            for(const declared of ['5', '7']){
                const body = batchBody(validBatch());
                body[3] = declared;
                const data = v2Data();
                await newHandler().parse(uncompressedParams(body), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                    'ROUND_COUNT ' + declared + ' against six round blocks must invalidate');
            }
        });

        it('rejects rounds that are not strictly ascending, including a duplicate', async function () {
            for(const mutate of [
                r => { const t = r[0].round; r[0].round = r[1].round; r[1].round = t; },  // swapped
                r => { r[2].round = r[1].round; },                                        // duplicate
            ]){
                const rounds = sixRounds();
                mutate(rounds);
                const id = newIdentity();
                capable.add(id.pubkey);
                const batch = signBatch(rounds, [id], { firstRound: 100, lastRound: 105 });
                const data  = v2Data();
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
                assert.ok(data['STATUS'].includes('ascending'), data['STATUS']);
            }
        });

        it('rejects a round outside the declared window', async function () {
            for(const [idx, value] of [[0, 99], [5, 106]]){
                const rounds = sixRounds();
                rounds[idx].round = value;
                const id = newIdentity();
                capable.add(id.pubkey);
                const batch = signBatch(rounds, [id], { firstRound: 100, lastRound: 105 });
                const data  = v2Data();
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            }
        });

        it('applies v0 per-round pair rules, and a single bad pair invalidates the WHOLE batch', async function () {
            // The signature set covers every round, so dropping the offending entry would
            // change the signed bytes; a signed batch is atomic exactly as a signed round is.
            for(const [pair, price] of [['BTCUSD', '50000'], ['BTC/USD', 'abc'], ['BTC/USD', '-5']]){
                const rounds = sixRounds();
                rounds[3].pairs[0] = { pair, price };
                const id = newIdentity();
                capable.add(id.pubkey);
                const batch = signBatch(rounds, [id]);
                const data  = v2Data();
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                    pair + ' ' + price + ' must invalidate the batch');
                assert.strictEqual(data['ROUNDS_JSON'], null, 'nothing partial may be stored');
            }
        });

        it('rejects a malformed signature field', async function () {
            for(const mutate of [
                b => { b[b.length - 2] = 'zz'; },          // pubkey not 64-hex
                b => { b[b.length - 1] = 'ff'; },          // sig not 128-hex
                b => { b.splice(b.length - 3, 1, '0'); },  // SIG_COUNT 0
            ]){
                const body = batchBody(validBatch());
                mutate(body);
                const data = v2Data();
                await newHandler().parse(uncompressedParams(body), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            }
        });
    });

    // -----------------------------------------------------------------------
    // 4. Straddle rule
    // -----------------------------------------------------------------------
    describe('straddle rule (step 4)', function () {
        // Regtest arms every oracle gate at genesis, so no anchor can straddle one there.
        // The gates are therefore driven directly, at a boundary standing in for mainnet's
        // sig-tally height (963000). The parser resolves the rule through the SAME
        // predicates the quorum uses, so a stub here moves both together, exactly as an
        // armed height would.
        const GATE = 963000;

        function armGateAt(height){
            priceSigTally.isPriceSigTallyVerifyFirstActive.restore &&
                priceSigTally.isPriceSigTallyVerifyFirstActive.restore();
            sinon.stub(priceSigTally, 'isPriceSigTallyVerifyFirstActive')
                .callsFake(h => parseInt(h) >= height);
        }

        function batchAcross(firstAnchor){
            const rounds = sixRounds({ anchorBase: firstAnchor });
            const id = newIdentity();
            capable.add(id.pubkey);
            return signBatch(rounds, [id]);
        }

        it('rejects a batch whose first and last round anchors sit on opposite sides of an armed gate', async function () {
            armGateAt(GATE);
            // anchors 962998..963003: the window crosses 963000.
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batchAcross(GATE - 2))), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(data['STATUS'], 'invalid: batch straddles an oracle flag day');
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called,
                'a straddling batch must not reach the hub');
        });

        it('accepts the same batch entirely below the gate, and entirely at or above it', async function () {
            armGateAt(GATE);
            const below = v2Data();
            await handler.parse(uncompressedParams(batchBody(batchAcross(GATE - 20))), below, null);
            assert.strictEqual(below['STATUS'], 'valid');

            const above = v2Data();
            await newHandler().parse(uncompressedParams(batchBody(batchAcross(GATE))), above, null);
            assert.strictEqual(above['STATUS'], 'valid');
        });

        it('straddles on the stake-weighted gate too, not only the sig-tally one', async function () {
            swq.isStakeWeightedQuorumActive.restore();
            sinon.stub(swq, 'isStakeWeightedQuorumActive').callsFake(h => parseInt(h) >= 961000);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batchAcross(960998))), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: batch straddles an oracle flag day');
        });

        it('an UNARMED gate straddles nothing', async function () {
            // Both sides resolve false, so the difference the rule looks for cannot exist.
            armGateAt(Number.MAX_SAFE_INTEGER);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batchAcross(GATE - 2))), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // The batch anchor rule (part of step 3): BTC_BLOCK_HEIGHT must equal the LAST
    // included round's anchor.
    //
    // THE ATTACK this closes, driven end to end rather than asserted as a mismatch.
    // Both quorum gates resolve on the header anchor and the straddle rule inspects
    // only the per-round anchors, so an unconstrained header lets a colluding signing
    // quorum choose WHICH consensus rule judges its own batch. Below, four price
    // validators hold wildly uneven stake: the two that sign are one short of the
    // count quorum of 3 but carry ~99.999% of the stake, so the very same batch is
    // refused under the count rule and accepted under the stake-weighted one. Every
    // per-round anchor sits honestly below the gate; only the HEADER claims otherwise.
    // -----------------------------------------------------------------------
    describe('batch anchor rule (step 3)', function () {
        const GATE          = 961000;      // stands in for mainnet's stake-weighted height
        const ROUND_ANCHOR  = GATE - 10;   // rounds 960990..960995, all below the gate
        const ATTACK_HEADER = GATE + 500;  // the header alone claims the far side

        let gate, signers, whole;

        beforeEach(function () {
            // A height-keyed gate, exactly as an armed activation height behaves. The
            // parser resolves it through the same predicate the quorum uses, so this
            // moves the real rule rather than a copy of it.
            swq.isStakeWeightedQuorumActive.restore();
            gate = sinon.stub(swq, 'isStakeWeightedQuorumActive').callsFake(h => parseInt(h) >= GATE);

            signers = [newIdentity(), newIdentity()];
            const dust = [newIdentity(), newIdentity()];
            whole = signers.concat(dust);
            for(const id of whole) capable.add(id.pubkey);

            // Count rule: 4 price-capable validators, so quorum is 3 and two signers fail.
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);
            // Stake rule: the same two signers hold 3*200000 > 2*200002, so they pass.
            indexer.indexerDb.getStakeWeightsByCapability.resolves(whole.map((id, i) => ({
                pubkey: id.pubkey, source: 's' + i, weight: i < 2 ? '100000' : '1'
            })));
        });

        const attackRounds = () => sixRounds({ anchorBase: ROUND_ANCHOR });

        it('refuses a header anchor that is not the last round anchor, before either quorum gate resolves', async function () {
            // Otherwise perfect: the quorum really signed this header, so nothing but the
            // anchor rule can tell this batch apart from an honest one.
            const batch = signBatch(attackRounds(), signers, { btcBlockHeight: ATTACK_HEADER });
            const data  = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(data['STATUS'], 'invalid: batch anchor does not match the last round');
            // The check has to run BEFORE the gates or it protects nothing: neither gate
            // was ever consulted, so no quorum rule was selected on the attacker's value.
            assert.ok(!gate.called, 'the stake-weighted gate must never have resolved');
            assert.ok(!indexer.indexerDb.getStakeWeightsByCapability.called);
            assert.ok(!indexer.indexerDb.getActiveCapabilityCount.called);
            // Nothing partial is stored and nothing reaches the hub.
            assert.strictEqual(data['ROUNDS_JSON'], null);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
        });

        it('judges the SAME signature set under the honest count rule once the header is truthful', async function () {
            // The control that makes the case above an attack rather than a typo: pinned to
            // the last round's own anchor, the batch resolves under the count rule its
            // per-round anchors really sit under, and two of four signers is short of
            // quorum. The lie was worth telling.
            const rounds = attackRounds();
            const batch  = signBatch(rounds, signers,
                { btcBlockHeight: rounds[rounds.length - 1].btcBlockHeight });
            const data   = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);

            assert.strictEqual(data['STATUS'], 'invalid: insufficient PBFT quorum (2/3)');
            assert.ok(!indexer.indexerDb.getStakeWeightsByCapability.called,
                'the honest anchor is below the gate, so the stake rule must not apply');
        });

        it('accepts an honest batch whose header anchor equals the last round anchor', async function () {
            const rounds = attackRounds();
            const batch  = signBatch(rounds, whole.slice(0, 3),
                { btcBlockHeight: rounds[rounds.length - 1].btcBlockHeight });
            const data   = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('refuses a header anchor that is off by one in either direction', async function () {
            // No tolerance: the rule is equality, so the nearest possible lie is refused.
            const rounds = attackRounds();
            const last   = rounds[rounds.length - 1].btcBlockHeight;
            for(const header of [last - 1, last + 1]){
                const batch = signBatch(rounds, whole.slice(0, 3), { btcBlockHeight: header });
                const data  = v2Data();
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['STATUS'], 'invalid: batch anchor does not match the last round',
                    'header ' + header);
            }
        });

        it('applies to the compressed wire form as well, since both forms share the parser', async function () {
            const batch = signBatch(attackRounds(), signers, { btcBlockHeight: ATTACK_HEADER });
            const data  = v2Data();
            await handler.parse(compressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: batch anchor does not match the last round');
        });
    });

    // -----------------------------------------------------------------------
    // 5. Signature verification
    // -----------------------------------------------------------------------
    describe('signature verification (step 5)', function () {

        it('verifies real signatures over the canonical from buildPriceV2Payload', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects a batch whose body was altered after signing', async function () {
            // A price edited on the wire leaves the signature over the ORIGINAL canonical,
            // which is the whole point of covering the rounds with one signature set.
            const batch = validBatch();
            const body  = batchBody(batch);
            const idx   = body.indexOf('50000.00');
            body[idx]   = '60000.00';
            const data  = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('quorum'), data['STATUS']);
        });

        it('rejects a signature that is valid over the v0 canonical of one contained round', async function () {
            // The new engine tag is what keeps v0 and v2 canonicals unmixable; a v0-shaped
            // signature must not satisfy a v2 batch.
            const id = newIdentity();
            capable.add(id.pubkey);
            const rounds  = sixRounds();
            const v0Bytes = ed25519.buildPriceV0Payload(rounds[0].round, rounds[0].timestamp,
                rounds[0].pairs, 'regtest', rounds[0].btcBlockHeight);
            const batch = { firstRound: 100, lastRound: 105, btcBlockHeight: 799005, rounds,
                            sigs: [{ pubkey: id.pubkey, sig: signWith(id, v0Bytes) }] };
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('skips a signer without the price capability at this block', async function () {
            const id = newIdentity();   // deliberately NOT added to `capable`
            const batch = signBatch(sixRounds(), [id]);
            const data  = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('quorum'));
        });

        it('counts a duplicated pubkey once', async function () {
            const id = newIdentity();
            capable.add(id.pubkey);
            const batch = signBatch(sixRounds(), [id, id]);
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);   // quorum 3
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('1/3'), data['STATUS']);
        });

        it('meets PBFT quorum at exactly 2f+1', async function () {
            const ids = [newIdentity(), newIdentity(), newIdentity()];
            for(const id of ids) capable.add(id.pubkey);
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);   // quorum 3
            const batch = signBatch(sixRounds(), ids);
            const data  = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('falls back to the per-signer capability path on a TRUNCATED capability read', async function () {
            // Treating a truncated read as the whole set would silently drop a qualified
            // signer and under-count the quorum, which is a rejected but legitimately
            // quorate batch on chain.
            const id = newIdentity();
            capable.add(id.pubkey);
            indexer.indexerDb.getValidatorsByCapability.callsFake(async () => {
                const rows = [];         // truncated reads can come back short or empty
                rows.truncated = true;
                return rows;
            });
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(signBatch(sixRounds(), [id]))), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.hasCapability.called, 'the per-signer path must be taken');
        });

        it('keys the sig-tally and quorum gates on the BATCH anchor, and the validator set on BLOCK_INDEX', async function () {
            swq.isStakeWeightedQuorumActive.restore();
            const gateSpy = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
            const tallySpy = sinon.spy(priceSigTally, 'isPriceSigTallyVerifyFirstActive');

            const batch = validBatch();
            // A DOGE-like landing height, deliberately unlike the BTC anchor.
            await handler.parse(uncompressedParams(batchBody(batch)), v2Data({ BLOCK_INDEX: 5700000 }), null);

            // The gate keyed on the batch anchor (the LAST call is the quorum gate; the two
            // before it are the straddle rule's own probes).
            assert.strictEqual(gateSpy.lastCall.args[0], batch.btcBlockHeight);
            assert.strictEqual(tallySpy.lastCall.args[0], batch.btcBlockHeight);
            // The SET from the landing block.
            assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args[1], 5700000);
            assert.strictEqual(indexer.indexerDb.getActiveCapabilityCount.firstCall.args[1], 5700000);
        });

        it('uses stake-weighted quorum when the batch anchor is at or above its gate', async function () {
            swq.isStakeWeightedQuorumActive.restore();
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
            const id = newIdentity();
            capable.add(id.pubkey);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([{ pubkey: id.pubkey, source: 's1', weight: '100' }]);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(signBatch(sixRounds(), [id]))), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.getStakeWeightsByCapability.calledOnce);
            assert.strictEqual(indexer.indexerDb.getStakeWeightsByCapability.firstCall.args[1], 100);
        });

        it('records the stake shortfall status when the signer stake is too thin', async function () {
            swq.isStakeWeightedQuorumActive.restore();
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
            const signer = newIdentity(), whale = newIdentity();
            capable.add(signer.pubkey); capable.add(whale.pubkey);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                { pubkey: signer.pubkey, source: 's1', weight: '1' },
                { pubkey: whale.pubkey,  source: 's2', weight: '1000' },
            ]);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(signBatch(sixRounds(), [signer]))), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient signer stake');
        });
    });

    // -----------------------------------------------------------------------
    // The canonical the signatures cover
    // -----------------------------------------------------------------------
    describe('the v2 canonical', function () {

        it('carries first_round and last_round as JSON INTEGERS, never strings', async function () {
            // The equivocation reader that resolves an XORACLEB slash requires
            // Number.isInteger on both, so a string here would not surface as an invalid
            // action; it would surface as an unresolvable slashing decision. Caught here.
            const batch = validBatch();
            const json  = JSON.parse(batch.payload.slice(batch.payload.indexOf('{"first_round"')));
            assert.ok(Number.isInteger(json.first_round), 'first_round must be a JSON integer');
            assert.ok(Number.isInteger(json.last_round),  'last_round must be a JSON integer');
            assert.ok(Number.isInteger(json.btc_block_height));
            for(const r of json.rounds){
                assert.ok(Number.isInteger(r.round));
                assert.ok(Number.isInteger(r.timestamp));
                assert.ok(Number.isInteger(r.btc_block_height));
            }
            assert.ok(batch.payload.includes('"first_round":100,"last_round":105,'),
                'the window must serialize unquoted');
        });

        it('is built by ed25519.buildPriceV2Payload, never inlined by the parser', async function () {
            // A second spelling of the canonical anywhere is a fork; this asserts the parser
            // verifies against the ONE builder's bytes.
            const batch = validBatch();
            const spy   = sinon.spy(ed25519, 'buildPriceV2Payload');
            const verifySpy = sinon.spy(ed25519, 'verify');
            await handler.parse(uncompressedParams(batchBody(batch)), v2Data(), null);
            assert.ok(spy.calledOnce, 'the canonical must be built once per action');
            assert.deepStrictEqual(spy.firstCall.args.slice(0, 3), [100, 105, 799005]);
            assert.strictEqual(verifySpy.firstCall.args[0], spy.firstCall.returnValue);
        });
    });

    // -----------------------------------------------------------------------
    // 6. Storage
    // -----------------------------------------------------------------------
    describe('storage (step 6)', function () {

        it('stores round_number = FIRST_ROUND and the batch window columns', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);

            assert.strictEqual(data['ROUND'], 100, 'round_number carries FIRST_ROUND (D21)');
            assert.strictEqual(data['BATCH_FIRST_ROUND'], 100);
            assert.strictEqual(data['BATCH_LAST_ROUND'], 105);
            assert.strictEqual(data['ROUND_COUNT'], 6);
            assert.strictEqual(data['VERSION'], 2);
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
            assert.strictEqual(indexer.indexerDb.createPrice.firstCall.args[0], data);
        });

        it('leaves pair_count, pairs_json and sig_count NULL on a v2 row', async function () {
            // Those three describe ONE round; on a batch row they would describe the window
            // wrongly, so rounds_json and sigs_json carry the batch instead.
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['PAIR_COUNT'], undefined);
            assert.strictEqual(data['PAIRS_JSON'], undefined);
            assert.strictEqual(data['SIG_COUNT'], undefined);
        });

        it('stores rounds_json in the snake-cased per-round shape sql/prices.sql documents', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            const rounds = JSON.parse(data['ROUNDS_JSON']);
            assert.strictEqual(rounds.length, 6);
            assert.deepStrictEqual(Object.keys(rounds[0]), ['round', 'timestamp', 'btc_block_height', 'pairs']);
            assert.deepStrictEqual(rounds[0].pairs[0], { pair: 'BTC/USD', price: '50000.00' });
            assert.strictEqual(rounds[5].btc_block_height, 799005);
        });

        it('stores the batch signature set in sigs_json, lowercased', async function () {
            const id = newIdentity();
            capable.add(id.pubkey);
            const batch = signBatch(sixRounds(), [id]);
            const body  = batchBody(batch);
            body[body.length - 2] = body[body.length - 2].toUpperCase();
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            const sigs = JSON.parse(data['SIGS_JSON']);
            assert.deepStrictEqual(sigs, [{ pubkey: batch.sigs[0].pubkey, sig: batch.sigs[0].sig }]);
        });

        it('records an INVALID batch too, rather than dropping it', async function () {
            const body = batchBody(validBatch());
            body[0] = '999';
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });
    });

    // -----------------------------------------------------------------------
    // 7. Hub push
    // -----------------------------------------------------------------------
    describe('hub push (step 7)', function () {

        // THE KEY SET. The hub's pushpricebatch handler destructures exactly these names
        // and nothing in the transport validates them, so a typo fails silently at runtime
        // and no other test in either repo would catch it.
        const EXPECTED_KEYS = ['source_chain', 'first_round', 'last_round', 'btc_block_height',
                               'rounds', 'block_time', 'sigs', 'action_index', 'block_index',
                               'push_generation'];

        it('enqueues ONE price_batch payload whose key set is exactly what the hub destructures', async function () {
            const data = v2Data({ ACTION_INDEX: 77, BLOCK_INDEX: 100, BLOCK_TIME: 1755000123 });
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);

            assert.ok(indexer.indexerDb.enqueueHubPushTx.calledOnce);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.firstCall.args[0], 'price_batch');
            const payload = indexer.indexerDb.enqueueHubPushTx.firstCall.args[1];
            assert.deepStrictEqual(Object.keys(payload).sort(), [...EXPECTED_KEYS].sort());

            assert.strictEqual(payload.source_chain, 'BTC');
            assert.strictEqual(payload.first_round, 100);
            assert.strictEqual(payload.last_round, 105);
            assert.strictEqual(payload.btc_block_height, 799005);
            assert.strictEqual(payload.block_time, 1755000123);
            assert.strictEqual(payload.action_index, 77);
            assert.strictEqual(payload.block_index, 100);
            assert.strictEqual(payload.push_generation, 0);
            assert.strictEqual(payload.rounds.length, 6);
            assert.strictEqual(payload.sigs.length, 1);
        });

        it('pushes per-round bodies under the snake-cased names the hub ingest reads', async function () {
            // receiveValidatedBatch reads r.round, r.timestamp, r.btc_block_height and
            // r.pairs; a camel-cased anchor here would arrive as NaN and refuse the batch.
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            const payload = indexer.indexerDb.enqueueHubPushTx.firstCall.args[1];
            assert.deepStrictEqual(Object.keys(payload.rounds[0]),
                ['round', 'timestamp', 'btc_block_height', 'pairs']);
            assert.deepStrictEqual(Object.keys(payload.sigs[0]), ['pubkey', 'sig']);
        });

        it('carries block_time, which v0 has no counterpart for', async function () {
            // Batching widens the hub/chain skew to ~70 minutes, so the hub keys its
            // per-round pair-name flag day on the landing action own block time.
            const data = v2Data({ BLOCK_TIME: 1766000000 });
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.firstCall.args[1].block_time, 1766000000);
        });

        it('goes through the durable outbox and is staged, never pushed directly from parse', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.ok(!hubClient.pushPriceBatch.called, 'parse must not block on hub HTTP latency');
            const staged = indexer.indexerDb.stageHubPush.firstCall.args[0];
            assert.strictEqual(staged.id, 42);
            assert.strictEqual(staged.pushType, 'price_batch');
            assert.deepStrictEqual(staged.payload, indexer.indexerDb.enqueueHubPushTx.firstCall.args[1]);
        });

        it('pushes nothing for an invalid batch', async function () {
            const body = batchBody(validBatch());
            body[body.length - 1] = 'f'.repeat(128);   // a signature that cannot verify
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
            assert.ok(!indexer.indexerDb.stageHubPush.called);
        });

        it('pushes nothing when there is no hub client', async function () {
            hubClient = null;
            const data = v2Data();
            await newHandler().parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
        });
    });

    // -----------------------------------------------------------------------
    // 8. No rewards
    // -----------------------------------------------------------------------
    describe('rewards (step 8)', function () {

        // THE PIN for D30. The oracle_round derivation lives inline in _parseV0 and is not
        // shared code, so _parseV2 simply never calls it. Without this test a later
        // refactor that hoisted the derivation into a shared helper would silently start
        // paying six rounds' worth of rewards per batch, on chain, with no failing test.
        it('writes ZERO validator_rewards rows for a valid BTC-landed batch', async function () {
            const data = v2Data({ COIN: 'BTC' });
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['COIN'], 'BTC', 'BTC is the chain v0 pays rewards on');
            assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 0);
        });

        it('writes ZERO validator_rewards rows in the compressed form too', async function () {
            const data = v2Data({ COIN: 'BTC' });
            await handler.parse(compressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 0);
        });

        it('never reads the full-node participation the reward split needs', async function () {
            indexer.indexerDb.getFullNodeParticipation = sinon.stub().resolves({ totalEpochs: 10, sources: [] });
            const data = v2Data({ COIN: 'BTC' });
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.ok(!indexer.indexerDb.getFullNodeParticipation.called);
        });
    });
});
