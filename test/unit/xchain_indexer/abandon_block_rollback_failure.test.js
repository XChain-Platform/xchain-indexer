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
const blockCommit = require('../../../src/XChainIndexer/block_commit.js');
const { getLogger } = require('../../../src/observability/index.js');

// noteBlockFault is the only place a block-processing error is logged, so a rollback that
// fails alongside it must not skip it; the rollback error still ends the pass afterwards.
describe('abandonBlock records the block fault even when the rollback fails', function () {
    let node, errorLog;

    beforeEach(function () {
        node = {
            indexerDb: { rollbackTransaction: sinon.stub().resolves() },
            priceBarrierSkipped: true,
            noteBlockFault: sinon.spy(),
            abandonBlock: blockCommit.abandonBlock
        };
        errorLog = sinon.stub(getLogger(), 'error');
    });

    afterEach(function () { sinon.restore(); });

    it('notes the original fault, clears the skip flag, then rethrows the rollback error', async function () {
        const original = new Error('block boom');
        node.indexerDb.rollbackTransaction.rejects(new Error('injected driver fault'));
        await assert.rejects(node.abandonBlock(original, 41), /injected driver fault/);
        assert.ok(node.noteBlockFault.calledOnceWithExactly(original, 41));
        assert.strictEqual(node.priceBarrierSkipped, false);
        assert.ok(errorLog.calledOnce, 'the rollback failure is logged');
        assert.match(String(errorLog.firstCall.args[0]), /injected driver fault[\s\S]*block boom/);
    });

    it('control: a clean rollback resolves and still notes the fault', async function () {
        const original = new Error('block boom');
        await node.abandonBlock(original, 41);
        assert.ok(node.noteBlockFault.calledOnceWithExactly(original, 41));
        assert.strictEqual(node.priceBarrierSkipped, false);
        assert.ok(errorLog.notCalled);
    });
});
