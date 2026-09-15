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
// ANCHOR v1 replay guards: the match batch seq and checkpoint seq watermarks,
// a batch seq restarted by a rebase, and archive reward determinism. Part of
// the ANCHOR suite; see ../anchor.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../../fixtures/mocks');
const { v1Params, ARCHIVE_JSON, armAnchor, disarmAnchor } = require('./helpers/anchor_fixtures.js');
const Anchor = require('../../../../../src/actions/anchor/index.js');

let indexer, handler, verifyStub, swqStub, deriveGateStub;

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('v1 replay guard: a match_batch_seq below the recorded max is stale', async function () {
        // Both watermarks are behind-worthy: seq 2 < 3 AND the payload's checkpoint
        // seq (0) is behind the newest archive's (5). made the second half
        // load-bearing, so a fixture that only pinned the batch seq would now pass
        // for the wrong reason.
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 3, checkpointSeq: 5 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '2' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: MATCH_BATCH_SEQ (stale'));
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    // The rebase resets the hub's dense batch-seq allocator
    // (StateAnchorPublisher._getNextBatchSeq counts its own tables) while this
    // watermark, read from replayed anchor_actions, returns to the pre-rebase max.
    // Both directions are pinned here because the two failures are opposite and
    // equally bad: reject the fresh batch and the archive rail is dead for as many
    // batches as history had; admit the old one and a stale archive can be replayed.
    it('v1 replay guard: a restarted batch seq is ACCEPTED when its wrapper checkpoint advances', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 40, checkpointSeq: 900000 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        // Post-rebase: the hub's counter restarted at 0, but checkpoint_seq is
        // snapshot_block and the chain kept moving.
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '0', seq: '961000' }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('v1 replay guard: a stale batch seq with a stale checkpoint is still rejected', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 40, checkpointSeq: 900000 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        // A genuine replay is signature-bound to its original canonical, so it can
        // only carry the OLD checkpoint seq. That is what still catches it.
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '12', seq: '880000' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: MATCH_BATCH_SEQ (stale'));
    });

    it('v1 replay guard: a second batch riding the SAME checkpoint is not treated as stale', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 40, checkpointSeq: 961000 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        // Equal, not ahead: one cadence can publish a second batch draining leftover
        // rows, and the guard elsewhere already treats an equal seq as the tolerated
        // duplicate case rather than a replay.
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '2', seq: '961000' }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('v1 replay guard: the reward rail rides the same exemption, so a restarted batch still derives its reward', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 40, checkpointSeq: 900000 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '0', seq: '961000' }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createValidatorReward.called);
    });

    it('determinism: two independent parses of identical v1 bytes derive the identical archive reward row', async function () {
        let h2 = new Anchor(indexer);
        let d1 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        let d2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON), d1, null);
        let firstArgs = indexer.indexerDb.createValidatorReward.lastCall.args;
        await h2.parse(v1Params(ARCHIVE_JSON), d2, null);
        let secondArgs = indexer.indexerDb.createValidatorReward.lastCall.args;
        assert.deepStrictEqual(firstArgs, secondArgs);
    });

    it('replay guard: a checkpoint_seq below the recorded max is stale; equal is allowed (a v0 section and its v1 archive share a seq)', async function () {
        indexer.indexerDb.getMaxAnchorCheckpointSeq.resolves(5);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { seq: '4' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: CHECKPOINT_SEQ (stale'));

        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 2 });
        await handler.parse(v1Params(ARCHIVE_JSON, { seq: '5' }), data2, null);
        assert.strictEqual(data2['STATUS'], 'valid');
    });

    it('replay guard: a v1 match_batch_seq below the recorded max is stale', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 3, checkpointSeq: 5 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '2' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: MATCH_BATCH_SEQ (stale'));
    });
});
