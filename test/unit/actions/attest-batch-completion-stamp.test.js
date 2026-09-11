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
// THE COMPLETION MARKER ON AN ATTEST v5 BATCH HEAD.
//
// A verdict on a batch head is written by one of two very different events, and a
// reorg has to tell them apart:
//
//   AT WRITE TIME, by _parseBatchHead, on the row it is creating. Nothing before it
//   was ever true of that row, and no reorg may ever promote it to 'valid'.
//
//   AFTER THE FACT, by _absorbCompletedBatch, as an in-place UPDATE on a head that
//   landed blocks earlier and was 'valid' right up to that moment. That stamp is
//   justified only by the chunk that completed the coverage, so a reorg taking the
//   chunk has to take the stamp with it (rollback.js) - otherwise the head drops out
//   of its own status='valid' chunk set and _canonicalBatchHead resolves nothing on
//   replay.
//
// The marker is the whole of that distinction, so these cases pin it on both sides:
// the after-the-fact stamp always carries it, and no write-time verdict ever does.

process.env.INDEXER_COIN    = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const Attest  = require('../../../src/actions/attest.js');
const abw     = require('../../../src/attest_batch_wire.js');
const ed25519 = require('../../../src/ed25519.js');

const { ATTEST_BATCH_COMPLETION_STAMP } = Attest;

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);
const PUB_A    = 'DPubAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const ANCHOR   = 900000;

function batchRow(i){
    // Hash noise, so the body barely deflates and a small window still chunks.
    let noise = '';
    for(let k = 0; k < 8; k++) noise += crypto.createHash('sha512').update('n:' + i + ':' + k).digest('base64');
    return {
        network: 'regtest',
        request_id: crypto.createHash('sha256').update('breq' + i).digest('hex'),
        request_action_index: 100 + i, request_block_index: 90 + i,
        provider_id: 'http_get', status: 'ok',
        response_payload: noise,
        response_hash: crypto.createHash('sha256').update(noise).digest('hex'),
        meta: 'm', effective_time: 1700000000 + i,
        signer_pubkeys: JSON.stringify([PUBKEY_A]),
        signatures: JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        widen: 0,
    };
}

// A window whose encoding lands on exactly `want` wires.
function chunkedBatch(want){
    for(let n = 1; n <= 200; n++){
        const rows = [];
        for(let i = 0; i < n; i++) rows.push(batchRow(i));
        const win = {
            network: 'regtest', window_start: 1700000000, window_end: 1700003600,
            row_count: n, btc_block_height: ANCHOR, rows,
            sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
        };
        const enc = abw.encodeAttestBatch(win);
        if(enc.totalChunks === want) return { win, enc };
    }
    throw new Error('no window of this fixture shape encodes to ' + want + ' chunks');
}

function wireParams(wire){ return wire.split('|').slice(1); }

function batchHandler(coin){
    const ix = createMockIndexer();
    ix.config.COIN    = coin || 'DOGE';
    ix.config.NETWORK = 'regtest';
    const db = ix.indexerDb;
    db.createAttestationBatchAction = sinon.stub().resolves();
    db.getAttestBatchChunks         = sinon.stub().resolves([]);
    db.setAttestBatchStatus         = sinon.stub().resolves();
    db.getValidatorsByCapability    = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
    db.getStakeWeightsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
    db.getActiveCapabilityCount     = sinon.stub().resolves(1);
    db.hasCapability                = sinon.stub().resolves(true);
    const h = new Attest({
        config: ix.config, util: ix.util, mapper: ix.mapper,
        decoderDb: ix.decoderDb, indexerDb: db,
        hubClient: { enabled: true },
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
    });
    return { handler: h, db };
}

function batchData(overrides){
    return createBaseData(Object.assign({
        ACTION: 'ATTEST', FORMAT: 5, BLOCK_INDEX: 6300000, ACTION_INDEX: 71,
        BLOCK_TIME: 1700004000, COIN: 'DOGE', SOURCE: PUB_A,
    }, overrides || {}));
}

// The attests chunk table, served back the way the real read does: valid rows only,
// each carrying its slot and its broadcaster.
function chunkStore(db){
    const rows = [];
    db.createAttestationBatchAction = sinon.stub().callsFake(async (d) => {
        rows.push({
            action_index: Number(d['ACTION_INDEX']), version: Number(d['VERSION']),
            request_id: d['REQUEST_ID'], status: d['STATUS'], source: d['SOURCE'],
            window_start: d['WINDOW_START'], window_end: d['WINDOW_END'],
            row_count: d['ROW_COUNT'], btc_block_height: d['BTC_BLOCK_HEIGHT'],
            batch_crc32: d['BATCH_CRC32'], total_chunks: d['TOTAL_CHUNKS'],
            chunk_index: d['CHUNK_INDEX'], chunk_b64: d['CHUNK_B64'],
        });
    });
    db.getAttestBatchChunks = sinon.stub().callsFake(async (key) => rows
        .filter(r => r.request_id === key && r.status === 'valid' && r.chunk_index != null)
        .sort((a, b) => (a.chunk_index - b.chunk_index) || (a.action_index - b.action_index)));
    db.setAttestBatchStatus = sinon.stub().callsFake(async (actionIndex, status) => {
        for(const r of rows) if(r.action_index === Number(actionIndex)) r.status = status;
    });
    return rows;
}

async function land(h, enc, wireIndex, actionIndex, source){
    const data = batchData({
        FORMAT: wireIndex === 0 ? 5 : 6,
        ACTION_INDEX: actionIndex,
        BLOCK_INDEX: 6300000 + wireIndex,
        SOURCE: source || PUB_A,
    });
    await h.parse(wireParams(enc.wires[wireIndex]), data, null);
    return data;
}

describe('ATTEST v5 head: the batch-completion marker @regression', function(){

    beforeEach(function(){ sinon.stub(ed25519, 'verify').returns(true); });
    afterEach(function(){ sinon.restore(); });

    it('marks the reassembly verdict a completing chunk stamps on a surviving head', async function(){
        const { handler: h, db } = batchHandler('DOGE');
        const stored = chunkStore(db);
        const { enc } = chunkedBatch(2);

        await land(h, enc, 0, 71);

        // The declared slot and geometry, with the body bytes mangled: the wire is well
        // formed, the reassembled window is not.
        const wire = enc.wires[1].split('|');
        const body = wire[6];
        wire[6] = body.slice(0, body.length - 8) + 'AAAAAAAA';
        const cont = batchData({ FORMAT: 6, ACTION_INDEX: 72 });
        await h.parse(wire.slice(1), cont, null);

        assert.strictEqual(db.setAttestBatchStatus.callCount, 1, 'the batch verdict lands on the head');
        const stamped = db.setAttestBatchStatus.firstCall.args[1];
        assert.ok(stamped.endsWith(ATTEST_BATCH_COMPLETION_STAMP),
            'an after-the-fact stamp must be recoverable by the reorg reset: ' + stamped);
        assert.match(stamped, /^invalid: ATTEST_BATCH \(/,
            'and the reason still leads, so the marker never hides why the batch failed');
        assert.strictEqual(stored.find(r => r.action_index === 72).status, 'valid',
            'the chunk carried well-formed bytes of its own and keeps its own verdict');
    });

    it('marks the quorum verdict too', async function(){
        const { handler: h, db } = batchHandler('DOGE');
        chunkStore(db);
        const { enc } = chunkedBatch(2);
        await land(h, enc, 0, 71);

        ed25519.verify.returns(false);
        await land(h, enc, 1, 72);

        const stamped = db.setAttestBatchStatus.firstCall.args[1];
        assert.match(stamped, /^invalid: insufficient /, 'the quorum verdict still leads');
        assert.ok(stamped.endsWith(ATTEST_BATCH_COMPLETION_STAMP),
            'every path through _absorbCompletedBatch writes an in-place stamp, so every one is marked');
    });

    it('leaves an unmarked head where a batch simply has not completed', async function(){
        const { handler: h, db } = batchHandler('DOGE');
        chunkStore(db);
        const { enc } = chunkedBatch(3);

        await land(h, enc, 0, 71);
        await land(h, enc, 2, 72);

        assert.strictEqual(db.setAttestBatchStatus.called, false,
            'an incomplete batch is not a failed one, so there is no stamp and nothing to reset');
    });

    // The other half of the distinction. A head that is terminal because it was terminal
    // when it was written must be unrecoverable by the reset, or the reorg revives a head
    // that was never valid.
    it('never marks a verdict written on the head itself', async function(){
        const cases = [];

        // Off the batch rail.
        {
            const { handler: h } = batchHandler('BTC');
            const { enc } = chunkedBatch(2);
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            cases.push(data['STATUS']);
        }
        // A head for another network.
        {
            const { handler: h } = batchHandler('DOGE');
            const rows = [batchRow(0), batchRow(1)];
            const enc = abw.encodeAttestBatch({
                network: 'testnet', window_start: 1700000000, window_end: 1700003600,
                row_count: 2, btc_block_height: ANCHOR, rows,
                sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
            });
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            cases.push(data['STATUS']);
        }
        // A structurally broken head.
        {
            const { handler: h } = batchHandler('DOGE');
            const data = batchData();
            await h.parse(['5', 'not-a-key'], data, null);
            cases.push(data['STATUS']);
        }
        // A SECOND head for a window this publisher already headed: the case that makes a
        // blanket reset unsafe, because it sits in the reset's exact join shape.
        {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(2);
            await land(h, enc, 0, 71);
            const dup = await land(h, enc, 0, 73);
            cases.push(dup['STATUS']);
        }
        // A single-wire head whose own quorum fails.
        {
            const { handler: h } = batchHandler('DOGE');
            const rows = [batchRow(0)];
            const enc = abw.encodeAttestBatch({
                network: 'regtest', window_start: 1700000000, window_end: 1700003600,
                row_count: 1, btc_block_height: ANCHOR, rows,
                sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
            });
            assert.strictEqual(enc.totalChunks, 1, 'fixture assumption: one wire');
            ed25519.verify.returns(false);
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            ed25519.verify.returns(true);
            cases.push(data['STATUS']);
        }

        for(const status of cases){
            assert.notStrictEqual(status, 'valid', 'fixture assumption: every case here is a refusal');
            assert.strictEqual(status.includes(ATTEST_BATCH_COMPLETION_STAMP), false,
                'a write-time verdict carrying the marker would be restored to valid by a reorg: ' + status);
        }
        assert.strictEqual(cases.length, 5, 'all five write-time refusals must have been exercised');
    });
});
