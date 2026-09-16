// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// THE ATTEST HANDLER SUITE. One handler, split by behaviour across
// test/unit/actions/attest.test.js and its parts in test/unit/actions/attest.test/, every part under
// the same suite title so each full test title is what it was when the suite was
// one file. The shared setup, the wire builders and the fixture constants live in
// test/helpers/attest_fixture.js; the batch-rail fixtures in
// test/helpers/attest_batch_rail_fixture.js.
//
// This part: the ATTEST v5/v6 response batch on the DOGE rail, from the head verdict
// to multi-chunk absorption.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const crypto = require('crypto');

const swq = require('../../../../src/stake_weighted_quorum.js');
const abw = require('../../../../src/actions/attest/attest_batch_wire.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const { PUBKEY_A, PUBKEY_B, SIG_A, setUpAttestHandler } = require('../../../helpers/attest_fixture.js');
const { ANCHOR, batchRow, batchWindow, wireParams, batchHandler, batchData, chunkedBatch, chunkStore, land } = require('../../../helpers/attest_batch_rail_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let handler;
function setUpHandler() {
    ({ handler } = setUpAttestHandler());
}

// ------------------------------------------------- ATTEST v5/v6: the response batch

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('registers v5 and v6, taking their layouts from the wire module', function () {
            assert.strictEqual(handler.formats[5], abw.ATTEST_BATCH_HEAD_FORMAT);
            assert.strictEqual(handler.formats[6], abw.ATTEST_BATCH_CONTINUATION_FORMAT);
            assert.ok(handler.formats[5].startsWith('VERSION|BATCH_KEY|'));
        });

        it('a good batch is valid and stages an attest_batch hub push', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const win = batchWindow(2);
            const enc = abw.encodeAttestBatch(win);
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_ID'], enc.batchKey, 'the action is filed under the batch key');
            assert.ok(db.createAttestationBatchAction.calledOnce);
            assert.ok(db.enqueueHubPushTx.calledOnce);
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[0], 'attest_batch');

            // The key set IS the interface: the hub destructures exactly these, and a
            // typo fails silently at runtime rather than loudly at build time.
            const payload = db.enqueueHubPushTx.firstCall.args[1];
            assert.deepStrictEqual(Object.keys(payload).sort(), [
                'action_index', 'block_index', 'block_time', 'btc_block_height', 'network',
                'push_generation', 'row_count', 'rows', 'sigs', 'source_chain',
                'window_end', 'window_start',
            ]);
            assert.strictEqual(payload.source_chain, 'DOGE');
            assert.strictEqual(payload.network, 'regtest');
            assert.strictEqual(payload.window_start, win.window_start);
            assert.strictEqual(payload.window_end, win.window_end);
            assert.strictEqual(payload.row_count, 2);
            assert.strictEqual(payload.btc_block_height, ANCHOR);
            assert.strictEqual(payload.action_index, 71);
            assert.strictEqual(payload.block_index, 6300000);
            assert.strictEqual(payload.block_time, 1700004000);
            assert.deepStrictEqual(payload.rows, JSON.parse(abw.buildAttestBatchBody(win)).rows,
                'the reassembled body verbatim, so the hub re-verifies the bytes this node verified');
            assert.deepStrictEqual(payload.sigs, [{ pubkey: PUBKEY_A, sig: SIG_A }]);

            // Staged for live delivery inside the same block transaction that wrote the
            // durable row, exactly as the PRICE batch is.
            assert.ok(db.stageHubPush.calledOnce);
            assert.strictEqual(db.stageHubPush.firstCall.args[0].pushType, 'attest_batch');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('an empty window (row_count 0) is a valid batch and still pushes', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const enc = abw.encodeAttestBatch(batchWindow(0));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[1].row_count, 0,
                'every window publishes, which is what makes coverage provable for a chain-only node');
        });

        it('a bad batch quorum is invalid, with no push and no partial absorb', async function () {
            ed25519.verify.returns(false);
            const { handler: h, db } = batchHandler('DOGE');
            const enc = abw.encodeAttestBatch(batchWindow(2));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);

            assert.strictEqual(data['STATUS'], 'invalid: insufficient PBFT quorum (0/1)');
            assert.ok(db.createAttestationBatchAction.calledOnce, 'the verdict is still recorded');
            assert.strictEqual(db.enqueueHubPushTx.called, false, 'and nothing reaches the hub');
        });

        it('a signer outside the attestation capability snapshot does not count', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            db.getValidatorsByCapability.resolves([{ pubkey: PUBKEY_B }]);
            const enc = abw.encodeAttestBatch(batchWindow(1));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.match(data['STATUS'], /^invalid: insufficient PBFT quorum/);
            // Resolved at the batch's signed BTC anchor, never at this DOGE landing
            // height: capability_snapshots.snapshot_block is a BTC height.
            assert.ok(db.getValidatorsByCapability.calledWith('attestation', ANCHOR));
        });

        it('takes the stake-weighted quorum at and above the SWQ anchor', async function () {
            swq.isStakeWeightedQuorumActive.returns(true);
            const { handler: h, db } = batchHandler('DOGE');
            const enc = abw.encodeAttestBatch(batchWindow(1));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(db.getStakeWeightsByCapability.calledWith('attestation', ANCHOR));
            assert.strictEqual(db.getActiveCapabilityCount.called, false,
                'the count denominator belongs to the unweighted branch only');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('NEVER resolves a per-row responsible set on the batch rail', async function () {
            // Structural, not incidental: computeResponsibleSet returns [] off BTC, so a
            // batch that tried to verify rows here would refuse every honest one. Per-row
            // verification happens on the BTC indexer after the hub re-serves the row.
            const { handler: h } = batchHandler('DOGE');
            const spy = sinon.spy(h, 'computeResponsibleSet');
            const enc = abw.encodeAttestBatch(batchWindow(3));
            await h.parse(wireParams(enc.wires[0]), batchData(), null);
            assert.strictEqual(spy.called, false);
        });

        for (const coin of ['BTC', 'LTC']) {
            it(`is invalid on ${coin}: batches ride the DOGE rail`, async function () {
                const { handler: h, db } = batchHandler(coin);
                const enc = abw.encodeAttestBatch(batchWindow(1));
                const head = batchData({ COIN: coin });
                await h.parse(wireParams(enc.wires[0]), head, null);
                assert.strictEqual(head['STATUS'], 'invalid: ATTEST v5 (batches ride the DOGE rail)');
                assert.strictEqual(db.enqueueHubPushTx.called, false);

                // A well-formed continuation wire, so the refusal is the plane and not
                // the shape: BATCH_KEY|CHUNK_INDEX|TOTAL_CHUNKS|BATCH_CRC32|BODY.
                const cont = batchData({ COIN: coin, FORMAT: 6, ACTION_INDEX: 72 });
                await h.parse(['6', enc.batchKey, '1', '2', enc.batchCrc32, 'QUJD'], cont, null);
                assert.strictEqual(cont['STATUS'], 'invalid: ATTEST v6 (batches ride the DOGE rail)');
            });
        }

        it('refuses a batch declaring another network', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const enc = abw.encodeAttestBatch(batchWindow(1, { network: 'testnet' }));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: NETWORK (batch declares testnet)');
            assert.strictEqual(db.enqueueHubPushTx.called, false);
        });

        it('a structurally broken head is recorded invalid and never pushed', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const data = batchData();
            await h.parse(['5', 'not-a-key'], data, null);
            assert.match(data['STATUS'], /^invalid: ATTEST_BATCH \(/);
            assert.strictEqual(db.createAttestationBatchAction.firstCall.args[0]['REQUEST_ID'], '',
                'no key could be derived, so none is filed');
            assert.strictEqual(db.enqueueHubPushTx.called, false);
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('a v6 continuation records itself and absorbs nothing', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            // A window big enough to actually chunk, so the continuation is a real wire.
            const rows = [];
            for (let i = 0; i < 40; i++) {
                const r = batchRow(i);
                let noise = '';
                for (let k = 0; k < 8; k++)
                    noise += crypto.createHash('sha512').update('n:' + i + ':' + k).digest('base64');
                r.response_payload = noise;
                rows.push(r);
            }
            const enc = abw.encodeAttestBatch({
                network: 'regtest', window_start: 1, window_end: 2, row_count: 40,
                btc_block_height: ANCHOR, rows, sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
            });
            assert.ok(enc.totalChunks > 1, 'the fixture must actually chunk');

            const data = batchData({ FORMAT: 6, ACTION_INDEX: 80 });
            await h.parse(wireParams(enc.wires[1]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_ID'], enc.batchKey, 'a continuation names its head by the batch key');
            assert.ok(db.createAttestationBatchAction.calledOnce);
            assert.strictEqual(db.enqueueHubPushTx.called, false,
                'the head owns the verdict and the absorption; a chunk carries neither');
        });

        it('pushes nothing when the node has no hub client', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            h.hubClient = null;
            const enc = abw.encodeAttestBatch(batchWindow(1));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.strictEqual(data['STATUS'], 'valid', 'a hub-less node judges the batch identically');
            assert.strictEqual(db.enqueueHubPushTx.called, false);
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('a two-chunk batch absorbs exactly once, on the continuation that completes it', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { win, enc } = chunkedBatch(2);

            const head = await land(h, enc, 0, 71);
            assert.strictEqual(head['STATUS'], 'valid', 'a head with chunks outstanding is sound, not faulty');
            assert.strictEqual(db.enqueueHubPushTx.called, false, 'and has delivered nothing yet');

            const cont = await land(h, enc, 1, 72);
            assert.strictEqual(cont['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1, 'the completing chunk absorbs, once');
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[0], 'attest_batch');

            const payload = db.enqueueHubPushTx.firstCall.args[1];
            assert.deepStrictEqual(payload.rows, JSON.parse(abw.buildAttestBatchBody(win)).rows,
                'the reassembled body verbatim, so the hub verifies the bytes the chain carried');
            assert.strictEqual(payload.row_count, win.row_count);
            assert.strictEqual(payload.action_index, 71,
                'the HEAD names the batch: the hub stamps this index onto every carried ' +
                'response, and a batch link must open the head, not the chunk that closed it');
            assert.strictEqual(payload.block_index, 6300001,
                'while the block stays the completing action\'s, whose rollback un-lands the delivery');
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[2], 72,
                'and the QUEUE ROW is keyed on the completing chunk, not on the head the ' +
                'payload names @regression: pending_hub_pushes.action_index is the reorg purge ' +
                'key (rollback deletes every row at or above the orphaned range), so keyed at ' +
                'the head (71) this delivery survives a rollback that removed the chunk that ' +
                'completed the batch and publishes a completion for chunks off chain');
            assert.strictEqual(db.stageHubPush.callCount, 1);
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('a three-chunk batch absorbs once when the head lands LAST, out of order', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { win, enc } = chunkedBatch(3);

            // Chunk 2 before chunk 1 before the head: none of the three can absorb until
            // the set is complete, and only the completing action does.
            const c2 = await land(h, enc, 2, 71);
            const c1 = await land(h, enc, 1, 72);
            assert.strictEqual(c2['STATUS'], 'valid');
            assert.strictEqual(c1['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.called, false,
                'a chunk with no head on chain has nothing to verify against');

            const head = await land(h, enc, 0, 73);
            assert.strictEqual(head['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1, 'the head completes the coverage and absorbs');
            assert.deepStrictEqual(db.enqueueHubPushTx.firstCall.args[1].rows,
                JSON.parse(abw.buildAttestBatchBody(win)).rows);
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[1].action_index, 73,
                'the head names the batch, and here the head IS the completing action');
            const rollbackKey = db.enqueueHubPushTx.firstCall.args[2];
            assert.ok(rollbackKey === undefined || rollbackKey === 73,
                'so the display index and the purge key coincide, whichever path enqueued it');
        });

        it('a missing chunk never absorbs', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(3);

            await land(h, enc, 0, 71);
            const c2 = await land(h, enc, 2, 72);

            assert.strictEqual(c2['STATUS'], 'valid', 'the chunk itself is well formed');
            assert.strictEqual(db.enqueueHubPushTx.called, false,
                'coverage is an index SET: two of three slots is not a batch');
            assert.strictEqual(db.setAttestBatchStatus.called, false,
                'and an incomplete batch is not a failed one, so the head keeps its verdict');
        });
    });
});
