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
// test/unit/price/price_batch_param_length.test.js
//
// Strict parameter length for the PRICE batch wire. Neither the structural
// checks nor the signature check ever look at whether the field list was
// consumed to its end, so a wire carrying junk appended after the last
// signature parsed exactly like the same batch without it and landed the same
// row under the same EQUIV key. Two byte-distinct spellings of one batch under
// one equiv key is precisely the shape equivocation reasoning depends on being
// impossible, so a wire with anything left over after the declared SIG_COUNT
// signatures must be refused, in both wire forms.
//
// THE REFUSAL IS HEIGHT-GATED. Every node through v0.20.0 accepted a wire with
// leftover fields, so the rule binds only a batch whose own BTC anchor is in the
// mirror admission era; below it the same bytes stay valid, or a replay re-judges
// history. Both sides are driven on the SHIPPED testnet producer height, read from
// the registry and never typed here, with no stubbed gate.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Price   = require('../../../src/actions/price/index.js');
const ed25519 = require('../../../src/consensus/ed25519.js');
const swq     = require('../../../src/consensus/stake_weighted_quorum.js');
const comp    = require('../../../src/actions/price/price_batch_compression.js');
const adm     = require('../../../src/consensus/gates/mirror_admission_gate.js');

const NETWORK   = 'testnet';
const ADMIT_AT  = adm.MIRROR_ADMISSION_ACTIVATION['BTC:' + NETWORK];
const LEGACY_AT = ADMIT_AT - 2;

// Below every testnet time-keyed price gate, so only the anchor height is graded.
const BLOCK_TIME = 1700000000;
const MAPS = [{ BTC: 900001, DOGE: 5000004 }, { BTC: 900002, LTC: 2400004 }];

function newIdentity(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), privateKey };
}
function signWith(id, payload){
    return crypto.sign(null, Buffer.from(payload, 'utf8'), id.privateKey).toString('hex');
}

// `count` rounds (two by default) from `anchorBase`, carrying a map per round when `era`
// is set, as an admission-era producer must.
function rounds(anchorBase, era, count = 2){
    return [0, 1].slice(0, count).map(i => {
        const r = { round: 100 + i, timestamp: 1700000000 + (i * 600), btcBlockHeight: anchorBase + i,
                    pairs: [{ pair: 'BTC/USD', price: '50000.00000000' }] };
        if(era) r.admitBlocks = MAPS[i];
        return r;
    });
}

// The field list after "PRICE|0|", with each round's ADMIT_BLOCKS slot where the parser reads it.
function batchBody(batch){
    const out = [String(batch.firstRound), String(batch.lastRound),
                 String(batch.btcBlockHeight), String(batch.rounds.length)];
    for(const r of batch.rounds){
        out.push(String(r.round), String(r.timestamp), String(r.btcBlockHeight), String(r.pairs.length));
        for(const p of r.pairs) out.push(String(p.pair), String(p.price));
        if(r.admitBlocks) out.push(adm.encodeAdmitBlocks(r.admitBlocks));
    }
    out.push(String(batch.sigs.length));
    for(const s of batch.sigs) out.push(s.pubkey, s.sig);
    return out;
}
const uncompressedParams = body => ['2'].concat(body);
const compressedParams   = body => ['2', comp.PRICE_BATCH_COMPRESSION_MARKER,
                                    comp.compressPriceBatchBody(body.join('|'))];

let indexer, hubClient, capable;

// Signed over the canonical the parser rebuilds; the batch anchor is the last round's.
function signedBatch(anchorBase, era, count){
    const id = newIdentity();
    capable.add(id.pubkey);
    const rs = rounds(anchorBase, era, count);
    const firstRound = rs[0].round, lastRound = rs[rs.length - 1].round;
    const btcBlockHeight = rs[rs.length - 1].btcBlockHeight;
    const payload = ed25519.buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rs, NETWORK);
    return { firstRound, lastRound, btcBlockHeight, rounds: rs, sigs: [{ pubkey: id.pubkey, sig: signWith(id, payload) }] };
}
const eraBody    = () => batchBody(signedBatch(ADMIT_AT, true));
const legacyBody = () => batchBody(signedBatch(LEGACY_AT, false));

function newHandler(){
    return new Price({
        config:    Object.assign({}, indexer.config, { NETWORK: NETWORK }),
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        hubClient: hubClient,
    });
}
const v2Data = () => createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, BLOCK_TIME: BLOCK_TIME });

function installHarness(){
    indexer = createMockIndexer();
    capable = new Set();
    const db = indexer.indexerDb;
    db.createPrice                 = sinon.stub().resolves();
    db.hasCapability               = sinon.stub().callsFake(async k => capable.has(String(k).toLowerCase()));
    db.getValidatorsByCapability   = sinon.stub().callsFake(async () => {
        const rows = [...capable].map(pubkey => ({ pubkey, amount: '100' }));
        rows.truncated = false;
        return rows;
    });
    db.getActiveCapabilityCount    = sinon.stub().resolves(1);
    db.getStakeWeightsByCapability = sinon.stub().resolves([]);
    db.enqueueHubPushTx            = sinon.stub().resolves(42);
    db.stageHubPush                = sinon.stub();
    hubClient = { enabled: true, pushPriceBatch: sinon.stub().resolves() };
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
}

async function parsed(params){
    const data = v2Data();
    await newHandler().parse(params, data, null);
    return data;
}

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    beforeEach(installHarness);
    afterEach(function () { sinon.restore(); });

    describe('strict parameter length', function () {

        it('the testnet producer height is sized, so both eras below are real', function () {
            assert.ok(Number.isFinite(ADMIT_AT) && ADMIT_AT > 2, 'BTC:testnet admission height is ' + ADMIT_AT);
            assert.strictEqual(adm.isAdmissionEra(NETWORK, LEGACY_AT + 1), false);
            assert.strictEqual(adm.isAdmissionEra(NETWORK, ADMIT_AT + 1), true);
        });

        it('a well-formed batch with nothing left over still parses valid', async function () {
            const data = await parsed(uncompressedParams(eraBody()));
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, true);
        });

        it('rejects a batch wire with one junk field appended after the last signature', async function () {
            const data = await parsed(uncompressedParams(eraBody().concat(['JUNK'])));
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(/^invalid: /.test(data['STATUS']), data['STATUS']);
            assert.ok(data['STATUS'].includes('trailing'), data['STATUS']);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false,
                'a batch refused for trailing data must never reach the hub push outbox');
        });

        it('rejects a batch wire with several junk fields appended after the last signature', async function () {
            const data = await parsed(uncompressedParams(eraBody().concat(['JUNK1', 'JUNK2', 'JUNK3'])));
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('trailing'), data['STATUS']);
        });

        it('rejects a bare trailing empty field, the shape a stray trailing "|" on the wire produces', async function () {
            const data = await parsed(uncompressedParams(eraBody().concat([''])));
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('trailing'), data['STATUS']);
        });

        it('rejects the SAME junk in the COMPRESSED wire form, so compression cannot cheapen the second spelling', async function () {
            const data = await parsed(compressedParams(eraBody().concat(['JUNK'])));
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('trailing'), data['STATUS']);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false);
        });

        it('the clean batch in the COMPRESSED wire form is unaffected: the guard needs no lookahead over the marker', async function () {
            const data = await parsed(compressedParams(eraBody()));
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
        });

        it('a batch missing its final field (short, not long) still invalidates as it always has', async function () {
            const body = eraBody();
            body.pop();
            const data = await parsed(uncompressedParams(body));
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('BELOW the admission height a trailing field is left unread and the batch stays valid, as v0.20.0 judged it', async function () {
            for(const params of [uncompressedParams(legacyBody().concat(['x'])),
                                 compressedParams(legacyBody().concat(['JUNK1', 'JUNK2']))]){
                indexer.indexerDb.enqueueHubPushTx.resetHistory();
                const data = await parsed(params);
                assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.calledOnce, true,
                    'a pre-era batch must still reach the hub push, or the mirror diverges from history');
            }
        });

        it('the legacy verdict holds up to the height and flips exactly at it', async function () {
            // One-round batches, so the batch anchor is exactly H-1 and exactly H.
            const below = await parsed(uncompressedParams(batchBody(signedBatch(ADMIT_AT - 1, false, 1)).concat(['x'])));
            assert.strictEqual(below['STATUS'], 'valid', 'anchor ' + (ADMIT_AT - 1) + ': ' + below['STATUS']);
            const clean = await parsed(uncompressedParams(batchBody(signedBatch(ADMIT_AT, true, 1))));
            assert.strictEqual(clean['STATUS'], 'valid', 'anchor ' + ADMIT_AT + ' clean: ' + clean['STATUS']);
            const at = await parsed(uncompressedParams(batchBody(signedBatch(ADMIT_AT, true, 1)).concat(['x'])));
            assert.ok(String(at['STATUS']).includes('trailing'), 'anchor ' + ADMIT_AT + ': ' + at['STATUS']);
        });
    });
});
