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
 * test/unit/anchor/db_get_max_anchor_checkpoint_seq_versions.test.js
 *
 * CONSENSUS REGRESSION GUARD for the ANCHOR replay-guard watermark.
 *
 * getMaxAnchorCheckpointSeq() once hardcoded `a.version IN (0, 1, 3)`, omitting
 * the checkpoint-bearing v4/v5 anchors. Post-ANCHOR_REWARD flag-day the live
 * checkpoint stream is v4/v5, so the watermark froze at the last pre-flag-day
 * seq and a replayed older checkpoint passed the parseCheckpoint staleness
 * guard, getting recorded STATUS='valid' into the permanent anchor_actions
 * record. The fix builds the filter from the shared CHECKPOINT_VERSIONS
 * constant (anchor_action_query.js), same as getAnchorActionByCheckpoint.
 * These tests pin that the query and the constant can never drift again.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig }       = require('../../fixtures/config');
const Utility                 = require('../../../src/utility');
const Database                = require('../../../src/db');
const { CHECKPOINT_VERSIONS } = require('../../../src/actions/anchor/anchor_action_query');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

describe('getMaxAnchorCheckpointSeq() version filter (#2239)', function () {

    afterEach(() => sinon.restore());

    it('parameterizes the version filter from the shared CHECKPOINT_VERSIONS constant', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').resolves([{ max_seq: 42 }]);

        const seq = await db.getMaxAnchorCheckpointSeq('BTC', 'regtest');
        assert.strictEqual(seq, 42);

        const [query, params] = stub.firstCall.args;
        // No hand-copied version literal in the SQL (the drift mechanism).
        assert.ok(!/version\s+IN\s*\(\s*\d/i.test(query),
                  'version filter must be parameterized, not a hardcoded literal');
        // Bound params carry exactly the shared checkpoint-bearing set.
        assert.deepStrictEqual(params.slice(2), CHECKPOINT_VERSIONS,
                  'watermark version set must equal anchor-action-query CHECKPOINT_VERSIONS');
        const placeholders = (query.match(/version\s+IN\s*\(([^)]*)\)/i) || [])[1] || '';
        assert.strictEqual((placeholders.match(/\?/g) || []).length, CHECKPOINT_VERSIONS.length,
                  'one placeholder per checkpoint-bearing version');
    });

    it('still returns null when no watermark row exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ max_seq: null }]);
        assert.strictEqual(await db.getMaxAnchorCheckpointSeq('BTC', 'regtest'), null);
    });

    it('keeps the default statement unchanged and narrows valid-only reads', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').resolves([{ max_seq: 42 }]);

        await db.getMaxAnchorCheckpointSeq('BTC', 'regtest');
        await db.getMaxAnchorCheckpointSeq('BTC', 'regtest', false);
        await db.getMaxAnchorCheckpointSeq('BTC', 'regtest', true);

        assert.deepStrictEqual(stub.secondCall.args, stub.firstCall.args,
                  'an omitted or false valid-only argument must produce the same statement and values');
        assert.ok(/status\s+IN\s*\(\s*'valid'\s*,\s*'unverified'\s*\)/i.test(stub.firstCall.args[0]),
                  'default reads must continue to include unverified rows');
        assert.ok(/status\s+IN\s*\(\s*'valid'\s*\)/i.test(stub.thirdCall.args[0]),
                  'valid-only reads must include valid rows');
        assert.ok(!/unverified/i.test(stub.thirdCall.args[0]),
                  'valid-only reads must exclude unverified rows');
        assert.deepStrictEqual(stub.thirdCall.args[1], stub.firstCall.args[1],
                  'valid-only reads must keep the existing bound values');
    });

    it('narrows an omitted valid-only argument at the bind activation height', async function () {
        const env = 'XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION';
        const saved = process.env[env];
        try {
            process.env[env] = '7';
            const db = makeDb();
            const stub = sinon.stub(db, 'doQuery').resolves([{ max_seq: 42 }]);

            db.blockIndex = 6;
            await db.getMaxAnchorCheckpointSeq('BTC', 'regtest');
            assert.ok(/unverified/i.test(stub.firstCall.args[0]));

            db.blockIndex = 7;
            await db.getMaxAnchorCheckpointSeq('BTC', 'regtest');
            assert.ok(!/unverified/i.test(stub.secondCall.args[0]));

            await db.getMaxAnchorCheckpointSeq('BTC', 'regtest', false);
            assert.ok(/unverified/i.test(stub.thirdCall.args[0]));
        } finally {
            if(saved === undefined) delete process.env[env];
            else process.env[env] = saved;
        }
    });
});
