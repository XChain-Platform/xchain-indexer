/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The federation-read JSON-RPC families for price batches, anchors, roll calls
 * and reorg history (src/api/rpc/price_batches.js, anchor.js, rollcall.js,
 * reorg_history.js), driven against the indexer double: each read resolves
 * through apiView(), binds the arguments its query layer expects, and answers
 * a missing database or a throw with its own error.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const anchorActionQuery = require('../../../../src/actions/anchor/anchor_action_query');
const { buildPriceBatchesRpc } = require('../../../../src/api/rpc/price_batches.js');
const { buildAnchorRpc } = require('../../../../src/api/rpc/anchor.js');
const { buildRollcallRpc } = require('../../../../src/api/rpc/rollcall.js');
const { buildReorgHistoryRpc } = require('../../../../src/api/rpc/reorg_history.js');
const { ROLLCALL_ACTIVATION } = require('../../../../src/consensus/gates/rollcall_gate.js');
const { ROLLCALL_GATES_ACTIVATION } = require('../../../../src/consensus/gates/rollcall_gates_gate.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

const PK = 'ab'.repeat(32);
const NOT_READY = { error: 'indexer database not ready' };

describe('JSON-RPC price batch family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getpricebatches validates the window, reads valid batches over it and pages by truncation', async function () {
        const rows = [{ first_round: 3, last_round: 5, block_index: 9, action_index: 40 }];
        const view = recordingView({ getLatestBlockIndex: 20, getPriceBatchesOverlappingRange: rows });
        const rpc = buildPriceBatchesRpc({ indexer: fakeIndexer({ view }) });
        const res = await rpc.getpricebatches({ first_round: 1, last_round: 10, limit: 1 });
        assert.strictEqual(res.block_index, 20);
        assert.strictEqual(res.truncated, true);
        assert.strictEqual(res.batches.length, 1);
        assert.deepStrictEqual(view.calls[1], ['getPriceBatchesOverlappingRange', 'valid', 10, 1, 1]);
        assert.deepStrictEqual(await rpc.getpricebatches({ first_round: 5, last_round: 1 }), { error: 'first_round must not exceed last_round' });
        assert.deepStrictEqual(await buildPriceBatchesRpc({ indexer: fakeIndexer({ indexerDb: null }) }).getpricebatches({}), NOT_READY);
        sinon.stub(observability.getLogger(), 'error');
        view.getPriceBatchesOverlappingRange = async () => { throw new Error('x'); };
        assert.deepStrictEqual(await rpc.getpricebatches({ first_round: 1, last_round: 2 }), { error: 'failed to look up price batches' });
    });
});

describe('JSON-RPC anchor family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    const TXID = 'cd'.repeat(32);
    const checkpoint = { chain: 'BTC', network: 'regtest', block_index: 100, checkpoint_seq: 4 };

    it('getanchoraction runs the owned SQL through doQuery and answers checkpoint_anchored', async function () {
        const row = { txid: TXID, version: 0, status: 'valid', block_index: 50, payload_hash: 'ee'.repeat(32) };
        const view = recordingView({ getLatestBlockIndex: 60, doQuery: [row] });
        const rpc = buildAnchorRpc({ indexer: fakeIndexer({ view, config: { COIN: 'DOGE' } }) });
        const res = await rpc.getanchoraction(checkpoint);
        assert.strictEqual(res.exists, true);
        assert.strictEqual(res.checkpoint_anchored, true);
        assert.strictEqual(view.calls[1][0], 'doQuery');
        assert.strictEqual(view.calls[1][1], anchorActionQuery.ANCHOR_ACTIONS_SQL);
        assert.deepStrictEqual(view.calls[1][2].slice(0, 4), ['BTC', 'regtest', 100, 4]);
        view.doQuery = async () => [];
        const miss = await rpc.getanchoraction(checkpoint);
        assert.strictEqual(miss.exists, false);
        assert.strictEqual(miss.checkpoint_anchored, false);
        assert.ok((await rpc.getanchoraction({ chain: 'BTC' })).error);
    });

    it('getanchorconfirmations picks the paged SQL only when a cursor is given', async function () {
        const view = recordingView({ getLatestBlockIndex: 60, doQuery: [] });
        const rpc = buildAnchorRpc({ indexer: fakeIndexer({ view, config: { COIN: 'DOGE' } }) });
        const res = await rpc.getanchorconfirmations({ txid: TXID });
        assert.strictEqual(res.exists, false);
        assert.deepStrictEqual(view.calls[1], ['doQuery', anchorActionQuery.ANCHOR_BY_TXID_SQL, [TXID]]);
        await rpc.getanchorconfirmations({ txid: TXID, after_action_index: 12 });
        assert.deepStrictEqual(view.calls[3], ['doQuery', anchorActionQuery.ANCHOR_BY_TXID_AFTER_SQL, [TXID, 12]]);
        assert.ok((await rpc.getanchorconfirmations({ txid: 'nope' })).error);
    });

    it('getarchiveanchor reads by content commitment and author', async function () {
        const view = recordingView({ getLatestBlockIndex: 60, getArchiveAnchorByContent: { head: null, chunks: [] } });
        const rpc = buildAnchorRpc({ indexer: fakeIndexer({ view, config: { COIN: 'DOGE' } }) });
        const body = Object.assign({ batch_crc32: 'deadbeef', match_count: 3, author: 'DAuthor' }, checkpoint);
        const res = await rpc.getarchiveanchor(body);
        assert.strictEqual(res.exists, false);
        assert.deepStrictEqual(view.calls[1], ['getArchiveAnchorByContent', 'BTC', 'regtest', 100, 4, 'deadbeef', 3, 'DAuthor']);
        assert.ok((await rpc.getarchiveanchor({ chain: 'BTC' })).error);
    });

    it('every anchor read refuses without a database and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const notReady = buildAnchorRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        const throwing = buildAnchorRpc({ indexer: fakeIndexer({ view: recordingView({ getLatestBlockIndex: () => { throw new Error('x'); } }) }) });
        const archive = Object.assign({ batch_crc32: 'deadbeef', match_count: 3, author: 'DAuthor' }, checkpoint);
        for (const [name, body, message] of [
            ['getanchoraction', checkpoint, 'failed to look up anchor action'],
            ['getanchorconfirmations', { txid: TXID }, 'failed to look up anchor confirmations'],
            ['getarchiveanchor', archive, 'failed to look up archive anchor']
        ]) {
            assert.deepStrictEqual(await notReady[name](body), NOT_READY, name);
            assert.deepStrictEqual(await throwing[name](body), { error: message }, name);
        }
    });
});

describe('JSON-RPC roll-call family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    const request = { network: 'regtest', epoch_height: 960, max_block_time: 1700000000, pubkeys: [PK], publishers: [] };

    it('getrollcallsigners answers the cut, tip, manifest hash and activation heights', async function () {
        const view = recordingView({ getLatestBlockIndex: 1000, getBlockTimeAtHeightOrNull: 1700000500,
                                     getRollcallWindowCut: 990, getRollcallSignersForKeys: [], getRollcallPublishers: [] });
        const rpc = buildRollcallRpc({ indexer: fakeIndexer({ view, config: { COIN: 'DOGE' } }), rollcallManifestHash: () => 'ff'.repeat(32) });
        const res = await rpc.getrollcallsigners(request);
        assert.strictEqual(res.hcut, 990);
        assert.strictEqual(res.tip_block_index, 1000);
        assert.strictEqual(res.tip_block_time, 1700000500);
        assert.strictEqual(res.manifest_hash, 'ff'.repeat(32));
        assert.strictEqual(res.rollcall_activation, ROLLCALL_ACTIVATION.regtest);
        assert.strictEqual(res.rollcall_gates_activation, ROLLCALL_GATES_ACTIVATION.regtest);
        assert.deepStrictEqual(res.signers, { [PK]: null });
        assert.deepStrictEqual(view.calls[2], ['getRollcallWindowCut', 1700000000]);
    });

    it('getrollcallsigners reports null for an inert activation rail', async function () {
        const view = recordingView({ getLatestBlockIndex: 1000, getBlockTimeAtHeightOrNull: 1700000500,
                                     getRollcallWindowCut: 990, getRollcallSignersForKeys: [], getRollcallPublishers: [] });
        const rpc = buildRollcallRpc({ indexer: fakeIndexer({ view, config: { COIN: 'DOGE', NETWORK: 'mainnet' } }),
                                       rollcallManifestHash: () => 'ff'.repeat(32) });
        const res = await rpc.getrollcallsigners(Object.assign({}, request, { network: 'mainnet' }));
        assert.strictEqual(res.rollcall_activation, ROLLCALL_ACTIVATION.mainnet);
        assert.strictEqual(ROLLCALL_GATES_ACTIVATION.mainnet, null);
        assert.strictEqual(res.rollcall_gates_activation, null);
    });

    it('getrollcallsigners refuses off DOGE, without a database, and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const btc = buildRollcallRpc({ indexer: fakeIndexer(), rollcallManifestHash: () => null });
        assert.deepStrictEqual(await btc.getrollcallsigners(request), { error: 'getrollcallsigners is DOGE-only' });
        const notReady = buildRollcallRpc({ indexer: fakeIndexer({ indexerDb: null, config: { COIN: 'DOGE' } }), rollcallManifestHash: () => null });
        assert.deepStrictEqual(await notReady.getrollcallsigners(request), NOT_READY);
        const throwing = buildRollcallRpc({ indexer: fakeIndexer({ view: recordingView({ getLatestBlockIndex: () => { throw new Error('x'); } }), config: { COIN: 'DOGE' } }),
                                            rollcallManifestHash: () => null });
        assert.deepStrictEqual(await throwing.getrollcallsigners(request), { error: 'failed to look up rollcall signers' });
    });

    it('getrollcalls and getrollcallabsences clamp to 20 by default and 100 at most', async function () {
        const view = recordingView({ getRollcalls: [{ epoch: 1 }], getRollcallAbsencesBySource: [{ epoch: 2 }] });
        const rpc = buildRollcallRpc({ indexer: fakeIndexer({ view }), rollcallManifestHash: () => null });
        assert.deepStrictEqual(await rpc.getrollcalls({}), { rollcalls: [{ epoch: 1 }] });
        assert.deepStrictEqual(await rpc.getrollcallabsences({ source: 'bc1q', limit: 5000 }), { absences: [{ epoch: 2 }] });
        assert.deepStrictEqual(view.calls, [['getRollcalls', 20], ['getRollcallAbsencesBySource', 'bc1q', 100]]);
        sinon.stub(observability.getLogger(), 'error');
        view.getRollcalls = async () => { throw new Error('x'); };
        view.getRollcallAbsencesBySource = async () => { throw new Error('x'); };
        assert.deepStrictEqual(await rpc.getrollcalls({}), { error: 'failed to look up roll calls' });
        assert.deepStrictEqual(await rpc.getrollcallabsences({}), { error: 'failed to look up roll call absences' });
        const notReady = buildRollcallRpc({ indexer: fakeIndexer({ indexerDb: null }), rollcallManifestHash: () => null });
        assert.deepStrictEqual(await notReady.getrollcalls({}), NOT_READY);
        assert.deepStrictEqual(await notReady.getrollcallabsences({}), NOT_READY);
    });
});

describe('JSON-RPC reorg history family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('reads the decoder view, probes the live halt flag and matches an orphaned hash', async function () {
        const hash = 'ab'.repeat(32);
        const decoderView = recordingView({
            getReorgEventsSince: [{ id: 3, block_index: 40, data: JSON.stringify([{ block_index: 41, block_hash: hash }]) }],
            isReorgHalted: { halted: true }
        });
        const rpc = buildReorgHistoryRpc({ indexer: fakeIndexer({ decoderView }) });
        const res = await rpc.getreorghistory({ since_id: 0, block_index: 41, block_hash: hash, limit: 5 });
        assert.strictEqual(res.decoderReorgHalted, true);
        assert.strictEqual(res.matched, true);
        assert.deepStrictEqual(decoderView.calls.map(c => c[0]), ['getReorgEventsSince', 'isReorgHalted']);
        assert.deepStrictEqual(decoderView.calls[0], ['getReorgEventsSince', 0, 5]);
    });

    it('falls back to the indexer\'s last-known halt flag when the probe faults', async function () {
        const decoderView = recordingView({ getReorgEventsSince: [], isReorgHalted: () => { throw new Error('probe'); } });
        const rpc = buildReorgHistoryRpc({ indexer: fakeIndexer({ decoderView, decoderReorgHalted: true }) });
        assert.strictEqual((await rpc.getreorghistory({})).decoderReorgHalted, true);
    });

    it('validates, refuses without the decoder database and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const rpc = buildReorgHistoryRpc({ indexer: fakeIndexer({ decoderView: recordingView({ getReorgEventsSince: () => { throw new Error('x'); } }) }) });
        assert.deepStrictEqual(await rpc.getreorghistory({ since_id: -1 }), { error: 'since_id must be a non-negative integer' });
        assert.deepStrictEqual(await rpc.getreorghistory({}), { error: 'failed to look up reorg history' });
        assert.deepStrictEqual(await buildReorgHistoryRpc({ indexer: fakeIndexer({ decoderDb: null }) }).getreorghistory({}), { error: 'decoder database not ready' });
    });
});
