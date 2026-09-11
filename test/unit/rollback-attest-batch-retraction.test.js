/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Rollback: the reorg retraction for a landed ATTEST v5/v6 batch push
 * (the ATTEST response-mirror design, §6.3, frontier row 55).
 *
 * A batch that landed on the DOGE rail told a hub to stamp a batch link on every
 * response it carried. When a reorg orphans that batch, the chain behind the link
 * is gone but the hub is still serving it, and this node is the only party that
 * knows: the `attests` rows naming the batch are about to be deleted by the same
 * rollback. So the retraction is collected in the READ phase, write-ahead-staged as
 * a durable queue row inside the rollback transaction (a crash between commit and
 * the live RPC must not lose it), and only then delivered live.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');

const Rollback = require('../../src/rollback.js');
const abw      = require('../../src/attest_batch_wire.js');

const FIRST_ACTION = 50;   // lowest action in the orphaned range
const LAST_ACTION  = 75;   // highest action in the orphaned range
const HEAD_ACTION  = 44;   // the batch HEAD, which may sit BELOW the orphaned range

// One un-landed batch, shaped as the collect query returns it.
function batchRow(overrides){
    return Object.assign({
        batch_key:    'ab'.repeat(32),
        action_index: HEAD_ACTION,
        window_start: 1780000000,
        window_end:   1780003600
    }, overrides || {});
}

// A rollback wired with a hub client and the three reads the read phase makes:
// firstActionIndex, MAX(action_index), and the un-landed batch collect.
function makeRollback(opts){
    opts = opts || {};
    const hubClient = Object.assign({
        enabled: true,
        retractPriceRange:  sinon.stub().resolves(),
        retractXcallRange:  sinon.stub().resolves(),
        retractMatchRange:  sinon.stub().resolves(),
        retractAttestBatch: sinon.stub().resolves()
    }, opts.hubClient || {});

    const idx = createMockIndexer({ hubClient });
    idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };

    // Programmed on doQueryStrict alone (the mock aliases it to doQuery by default, so
    // this also proves the collect read goes through the STRICT view: a transient DB
    // fault must throw and let the reorg be retried, never read as "no batch un-landed").
    const strict = sinon.stub().callsFake(async (sql) => {
        if(/MAX\(a\.action_index\)/.test(sql)) return [{ last_action_index: LAST_ACTION }];
        if(/FROM\s+actions a/.test(sql))       return [{ action_index: FIRST_ACTION }];
        if(/FROM attests h/.test(sql))         return (opts.batches !== undefined ? opts.batches : [batchRow()]);
        return [];
    });
    idx.indexerDb.doQueryStrict = strict;
    idx.indexerDb.doQuery.resolves([]);
    let n = 0;
    idx.indexerDb.enqueueHubPushTx    = sinon.stub().callsFake(async () => ++n);
    idx.indexerDb.markHubPushDelivered = sinon.stub().resolves();

    const rb = new Rollback(idx);
    idx.util.resetLists();
    return { rb, idx, hubClient, strict };
}

function stagedAttestCalls(idx){
    return idx.indexerDb.enqueueHubPushTx.getCalls().filter(c => c.args[0] === 'attest_batch_retraction');
}

describe('Rollback: ATTEST batch-link retraction (spec §6.3, row 55)', function(){

    afterEach(function(){ sinon.restore(); });

    it('collects un-landed batches by joining every rolled-back chunk back to its head', async function(){
        const { rb, strict } = makeRollback();
        await rb.rollback(100);

        const call = strict.getCalls().find(c => /FROM attests h/.test(c.args[0]));
        assert.ok(call, 'the read phase must collect the batches this reorg un-lands');
        assert.deepStrictEqual(call.args[1], [FIRST_ACTION],
            'the collect is bounded by the lowest rolled-back action');
        const sql = call.args[0];
        // A reorg that orphans ONE CONTINUATION un-lands a batch whose head survives (the
        // delivery fires on the action completing coverage, row 52), so the range predicate
        // has to sit on the CHUNK while the identity comes off the HEAD.
        assert.match(sql, /c\.action_index >= \?/, 'the orphaned range is tested on the chunk row');
        assert.match(sql, /h\.action_index\s+AS action_index/, 'the identity is the HEAD action index');
        assert.match(sql, new RegExp('c\\.version IN \\(' + abw.ATTEST_BATCH_HEAD_VERSION + ', ' +
                                     abw.ATTEST_BATCH_CONTINUATION_VERSION + '\\)'),
            'both batch wire versions count as chunks of the batch');
        assert.match(sql, /hs\.status = 'valid'/,
            'a batch stamped invalid on its head was never pushed, so there is no link to retract');
    });

    it('write-ahead-stages a durable attest_batch_retraction naming the batch, then delivers it live', async function(){
        const { rb, idx, hubClient } = makeRollback();
        await rb.rollback(100);

        const staged = stagedAttestCalls(idx);
        assert.strictEqual(staged.length, 1, 'one durable row per un-landed batch');
        const payload = staged[0].args[1];
        assert.strictEqual(payload.coin, rb.config['COIN']);
        assert.strictEqual(payload.network, rb.config['NETWORK']);
        assert.strictEqual(payload.batch_key, batchRow().batch_key);
        assert.strictEqual(payload.window_start, batchRow().window_start);
        assert.strictEqual(payload.window_end, batchRow().window_end);
        // The hub stamped the HEAD's action index on every carried row, so that is the only
        // value that names the link. Neither the rolled-back range's floor nor its ceiling
        // would match anything on the hub.
        assert.strictEqual(payload.action_index, HEAD_ACTION);
        assert.notStrictEqual(payload.action_index, FIRST_ACTION);
        assert.notStrictEqual(payload.action_index, LAST_ACTION);

        // Staged inside the transaction, before the commit, exactly like its siblings.
        assert.ok(staged[0].calledBefore(idx.indexerDb.commitTransaction.getCall(0)),
            'the durable row must commit atomically with the rollback');

        assert.strictEqual(hubClient.retractAttestBatch.callCount, 1);
        assert.strictEqual(hubClient.retractAttestBatch.firstCall.args[0], rb.config['COIN']);
        assert.deepStrictEqual(hubClient.retractAttestBatch.firstCall.args[1], payload,
            'the live delivery sends the staged payload verbatim');
        // Delivered live, so the durable row is dropped.
        const id = await staged[0].returnValue;
        assert.ok(idx.indexerDb.markHubPushDelivered.getCalls().some(c => c.args[0] === id),
            'a delivered retraction drops its durable row');
    });

    it('leaves the durable row for HubPushQueue when the live retraction fails', async function(){
        const { rb, idx } = makeRollback({
            hubClient: { retractAttestBatch: sinon.stub().rejects(new Error('hub unreachable')) } });
        await assert.doesNotReject(() => rb.rollback(100));

        const staged = stagedAttestCalls(idx);
        assert.strictEqual(staged.length, 1);
        const id = await staged[0].returnValue;
        assert.ok(!idx.indexerDb.markHubPushDelivered.getCalls().some(c => c.args[0] === id),
            'a failed live delivery must leave the durable row for the queue');
        assert.ok(idx.indexerDb.commitTransaction.calledOnce,
            'a hub that is down must not roll back the local reorg');
    });

    it('stages one row per un-landed batch, and none when the reorg un-lands no batch', async function(){
        const many = makeRollback({ batches: [
            batchRow({ batch_key: 'aa'.repeat(32), action_index: 44 }),
            batchRow({ batch_key: 'bb'.repeat(32), action_index: 61, window_start: 1780003600, window_end: 1780007200 })
        ]});
        await many.rb.rollback(100);
        assert.strictEqual(stagedAttestCalls(many.idx).length, 2);
        assert.strictEqual(many.hubClient.retractAttestBatch.callCount, 2);
        assert.deepStrictEqual(many.hubClient.retractAttestBatch.getCalls().map(c => c.args[1].action_index),
            [44, 61]);

        const none = makeRollback({ batches: [] });
        await none.rb.rollback(100);
        assert.strictEqual(stagedAttestCalls(none.idx).length, 0);
        assert.strictEqual(none.hubClient.retractAttestBatch.callCount, 0,
            'no batch un-landed means no retraction, not an empty one');
        // The three range retractions are unaffected either way.
        assert.strictEqual(none.hubClient.retractPriceRange.callCount, 1);
    });

    it('never purges its own durable retraction row on a deeper nested reorg', async function(){
        const { rb, idx } = makeRollback();
        await rb.rollback(100);

        const purge = idx.indexerDb.doQuery.getCalls()
            .find(c => /DELETE FROM pending_hub_pushes/.test(String(c.args[0])));
        assert.ok(purge, 'the generic purge must still run');
        assert.match(String(purge.args[0]), /'attest_batch_retraction'/,
            'a deeper reorg purging this row would strand a link whose batch is no longer on chain, ' +
            'because its own range can no longer cover the earlier reorg');
    });

    it('does not collect or stage anything when the hub client is disabled', async function(){
        const { rb, idx, strict } = makeRollback({ hubClient: { enabled: false } });
        await rb.rollback(100);
        assert.ok(!strict.getCalls().some(c => /FROM attests h/.test(c.args[0])),
            'a node with no hub has no link to retract and must not pay for the read');
        assert.strictEqual(stagedAttestCalls(idx).length, 0);
    });
});
