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
 * test/unit/db.getArchiveReplayWatermarks.test.js
 *
 * CONSENSUS REGRESSION GUARD for the v1/v6 archive replay guard .
 *
 * The guard rejects a stale MATCH_BATCH_SEQ only when the wrapper CHECKPOINT_SEQ
 * is also behind, because the batch seq is a DENSE counter the hub allocates from
 * its own tables and a wipe-and-replay rebase resets those while this watermark,
 * read from replayed anchor_actions, returns to the pre-rebase maximum.
 *
 * Two properties keep that safe, and both are pinned here because neither is
 * observable from a result set:
 *
 *   1. Both watermarks come from ONE statement over ONE row set. Two separate
 *      reads could describe row sets that never coexisted, and the guard would
 *      then either reject a legitimate post-rebase archive or admit a replay.
 *   2. The version filter is parameterized from the shared ARCHIVE_HEAD_VERSIONS
 *      constant, never a hand-copied `IN (1, 6)`. That literal is exactly how
 *      #2239 froze the sibling checkpoint watermark by omitting v4/v5.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig }          = require('../fixtures/config');
const Utility                    = require('../../src/utility');
const Database                   = require('../../src/db');
const { ARCHIVE_HEAD_VERSIONS }  = require('../../src/stateHash');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

describe('getArchiveReplayWatermarks() ', function () {

    afterEach(() => sinon.restore());

    it('returns both watermarks from a SINGLE statement over the same row set', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery')
                          .resolves([{ max_batch_seq: 40, max_checkpoint_seq: 961000 }]);

        const wm = await db.getArchiveReplayWatermarks();
        assert.deepStrictEqual(wm, { batchSeq: 40, checkpointSeq: 961000 });

        assert.strictEqual(stub.callCount, 1,
                  'one query: two reads could describe row sets that never coexisted');
        const [query] = stub.firstCall.args;
        assert.ok(/MAX\(a\.match_batch_seq\)/i.test(query) && /MAX\(a\.checkpoint_seq\)/i.test(query),
                  'both watermarks must be aggregated in the same statement');
        assert.ok(/FROM\s+anchor_actions/i.test(query) &&
                  (query.match(/FROM\s+anchor_actions/gi) || []).length === 1,
                  'one row set, not a join of two');
    });

    it('parameterizes the version filter from the shared ARCHIVE_HEAD_VERSIONS constant', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery')
                          .resolves([{ max_batch_seq: 1, max_checkpoint_seq: 2 }]);

        await db.getArchiveReplayWatermarks();
        const [query, params] = stub.firstCall.args;

        assert.ok(!/version\s+IN\s*\(\s*\d/i.test(query),
                  'version filter must be parameterized, not a hardcoded IN (1, 6)');
        assert.deepStrictEqual(params, ARCHIVE_HEAD_VERSIONS,
                  'watermark version set must equal stateHash ARCHIVE_HEAD_VERSIONS');
        const placeholders = (query.match(/version\s+IN\s*\(([^)]*)\)/i) || [])[1] || '';
        assert.strictEqual((placeholders.match(/\?/g) || []).length, ARCHIVE_HEAD_VERSIONS.length,
                  'one placeholder per archive-head version');
    });

    it('counts unverified rows, so the watermark does not differ between mirrored and unmirrored nodes', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery')
                          .resolves([{ max_batch_seq: 1, max_checkpoint_seq: 2 }]);

        await db.getArchiveReplayWatermarks();
        const [query] = stub.firstCall.args;
        // A node with no mirrored oracle_publish snapshot stores every well-formed
        // ANCHOR 'unverified'; excluding that status would fork the watermark.
        assert.ok(/status\s+IN\s*\(\s*'valid'\s*,\s*'unverified'\s*\)/i.test(query),
                  "status filter must admit both 'valid' and 'unverified'");
    });

    it('returns nulls when no archive row exists, leaving the guard inert', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ max_batch_seq: null, max_checkpoint_seq: null }]);
        assert.deepStrictEqual(await db.getArchiveReplayWatermarks(),
                               { batchSeq: null, checkpointSeq: null });
    });

    it('returns nulls on an empty result set rather than throwing', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.deepStrictEqual(await db.getArchiveReplayWatermarks(),
                               { batchSeq: null, checkpointSeq: null });
    });
});
