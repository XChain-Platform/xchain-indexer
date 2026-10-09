// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const blockPollMethods = require('../../../src/XChainIndexer/block_poll');
const { getLogger }    = require('../../../src/observability/index.js');

// The indexer half of the reorg handshake: one warn line that names the deepest block,
// and a processed-reorg count that moves only once each marker row is written.

// An indexer stub carrying just what applyPendingReorgs reads.
function makeIndexer() {
    return Object.assign({}, blockPollMethods, {
        util: { isNull: v => v === null || v === undefined },
        rollback: { rollback: sinon.stub().resolves() },
        decoderDb: { getReorgEventWitness: sinon.stub().resolves(null) },
        reorgsProcessedSinceStart: 0,
    });
}

// The reorg view: the post-rollback cursor re-read, the marker writes and the processed-id read.
function makeView() {
    return {
        getBlockIndex: sinon.stub().resolves(100),
        createReorg: sinon.stub().resolves(),
        getLastProcessedReorgId: sinon.stub().resolves(2),
    };
}

const REORGS = [{ id: 1, block_index: 105 }, { id: 2, block_index: 101 }];

describe('applyPendingReorgs logging and processed-reorg count', function () {
    let warn;

    beforeEach(function () { warn = sinon.stub(getLogger(), 'warn'); });
    afterEach(function () { sinon.restore(); });

    it('logs the detection once at warn with the deepest block number in the message', async function () {
        const info = sinon.stub(getLogger(), 'info');
        await makeIndexer().applyPendingReorgs(makeView(), REORGS, 200);

        const lines = warn.getCalls().map(c => String(c.args[0])).filter(l => l.includes('orphaned block'));
        assert.deepStrictEqual(lines, ['Detected 2 orphaned block(s) from decoder reorg events; deepest at block #101']);
        assert.ok(!info.getCalls().some(c => String(c.args[0]).includes('orphaned block')),
            'the detection must not also be logged at info');
    });

    it('counts each reorg once its marker row is written', async function () {
        const ix = makeIndexer();
        await ix.applyPendingReorgs(makeView(), REORGS, 200);
        assert.strictEqual(ix.reorgsProcessedSinceStart, 2);
        assert.ok(ix.rollback.rollback.calledOnceWithExactly(101), 'rolls back once to the deepest block');
    });

    it('leaves the count unmoved when a marker write fails', async function () {
        const ix = makeIndexer();
        const view = makeView();
        view.createReorg.rejects(new Error('db down'));
        await assert.rejects(ix.applyPendingReorgs(view, REORGS, 200), /db down/);
        assert.strictEqual(ix.reorgsProcessedSinceStart, 0);
    });
});
