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
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const blockFaults = require('../../../src/XChainIndexer/block_faults.js');
const blockParse = require('../../../src/XChainIndexer/block_parse.js');
const blockCommit = require('../../../src/XChainIndexer/block_commit.js');

const { MirroredRowError } = blockFaults;
const ROWS = [{ id: 1, body: 'a' }, { id: 2, body: '' }, { id: 3, body: 'c' }];

function follower(rows, applySite) {
    const node = Object.assign({
        config: { BLOCK_CHECK_INTERVAL: 1 },
        util: { logError: sinon.stub(), withTimeout: (p) => p },
        indexerDb: {
            beginTransaction: sinon.stub().resolves(),
            commitTransaction: sinon.stub().resolves(),
            rollbackTransaction: sinon.stub().resolves(),
            currentTxEpoch: () => 1,
            runInTxEpoch: (e, fn) => fn()
        },
        stallReason: null,
        stallClearsAt: null,
        applied: [],
        openBlockTransaction: async () => false,
        blockWatchdogTimeout: () => 1000,
        afterBlockCommit: async (blk, counts, last) => last + 1
    }, blockFaults, blockParse, { abandonBlock: blockCommit.abandonBlock });
    node.runBlockPasses = async (blk) => {
        node.applied = [];
        for (const row of rows) applySite(node, blk.blockToParse, row);
        return [0, 0, 0];
    };
    return node;
}

function decodingSite(node, block, row) {
    if (node.isMirroredRowRejected(block, 'attestation_responses', row.id)) return;
    if (typeof row.body !== 'string' || row.body.length === 0)
        throw new MirroredRowError('attestation_responses', row.id, 'EMPTY_BODY');
    node.applied.push(row.id);
}

describe('malformed mirrored row rejection @regression @tier1', function () {

    beforeEach(function () { sinon.stub(console, 'warn'); });
    afterEach(function () { sinon.restore(); });

    it('has two followers reject the same row identically while the block loop continues', async function () {
        const one = follower(ROWS, decodingSite);
        const two = follower(ROWS, decodingSite);
        const a = await one.processBlock({ blockToParse: 700 }, 699, 699);
        const b = await two.processBlock({ blockToParse: 700 }, 699, 699);

        assert.deepStrictEqual(a, { committed: true, stop: false, lastDecoderBlock: 700 });
        assert.deepStrictEqual(a, b);
        assert.deepStrictEqual(one.applied, [1, 3]);
        assert.deepStrictEqual(one.applied, two.applied);
        assert.strictEqual(one.indexerDb.rollbackTransaction.callCount, 1);
        assert.strictEqual(one.indexerDb.commitTransaction.callCount, 1);
        assert.strictEqual(one.stallReason, null);
        assert.strictEqual(one.util.logError.callCount, 0);
        assert.strictEqual(one.isMirroredRowRejected(700, 'attestation_responses', 2), false);
    });

    it('returns a verdict that depends only on the row identity', function () {
        const one = follower(ROWS, decodingSite);
        const two = follower(ROWS, decodingSite);
        const err = new MirroredRowError('attestation_responses', 2, 'EMPTY_BODY');
        const want = { rejected: true, source: 'attestation_responses', row: 2, code: 'EMPTY_BODY' };
        assert.deepStrictEqual(one.rejectMirroredRow(700, err), want);
        assert.deepStrictEqual(two.rejectMirroredRow(701, err), want);
        assert.strictEqual(one.rejectMirroredRow(700, err), null);
    });

    it('ends the block when a decode site ignores the rejection', async function () {
        const node = follower(ROWS, (n, block, row) => {
            if (row.id === 2) throw new MirroredRowError('attestation_responses', 2, 'EMPTY_BODY');
        });
        sinon.stub(console, 'error');
        const res = await node.processBlock({ blockToParse: 700 }, 699, 699);
        assert.strictEqual(res.stop, true);
        assert.strictEqual(res.committed, false);
        assert.strictEqual(node.indexerDb.commitTransaction.callCount, 0);
        assert.strictEqual(node.indexerDb.rollbackTransaction.callCount, 2);
    });

    it('still ends the block on a host fault', async function () {
        const fault = Object.assign(new Error('no executor'), { code: 'EXECUTOR_UNAVAILABLE' });
        const node = follower(ROWS, () => { throw fault; });
        sinon.stub(console, 'error');
        const res = await node.processBlock({ blockToParse: 700 }, 699, 699);
        assert.strictEqual(res.stop, true);
        assert.strictEqual(node.stallReason, 'vm_executor_unavailable');
        assert.strictEqual(node.indexerDb.rollbackTransaction.callCount, 1);
    });
});
