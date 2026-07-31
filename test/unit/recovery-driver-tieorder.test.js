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
 * test/unit/recovery-driver-tieorder.test.js
 *
 * CONSENSUS REGRESSION GUARD for AnchorRecovery.run() replay determinism (#2695).
 *
 * The rebuild driver query (recovery.js ~106-110) selects every valid/unverified archive
 * head and replays them in query order. The rebuild is order-dependent: later batches
 * supersede earlier ones per match_id (latest-status-wins) and the finalized-wins branch
 * overwrites the FULL non-key column set of cross_chain_calls per (call_id, phase).
 *
 * match_batch_seq is NOT unique on anchor_actions: the _parseCheckpoint replay guard accepts
 * an EQUAL MATCH_BATCH_SEQ, so a permissionless re-broadcast or a failover double-publish
 * stores a SECOND v1/v6 head for the same batch. The pre-fix driver ordered ONLY by
 * `match_batch_seq ASC`, so two equal-seq heads carrying different status/content replayed in
 * MySQL-unspecified order and two honest nodes could persist divergent finalized rows
 * fleet-wide (same failure class as the db.getAnchorV1ByBatchSeq tie-order fork).
 *
 * The intended rule (PINNED here): break the tie on `action_index ASC`, unique and
 * consensus-visible on this single-network table, matching the live head pick
 * (db.getAnchorV1ByBatchSeq) and the chunk-assembly query in the same file. Ordering on the
 * local AUTO_INCREMENT id would reintroduce per-node divergence.
 *
 * Technique mirrors db.getAnchorV1ByBatchSeq-tieorder.test.js: run the REAL run() far enough
 * to capture the live driver-query string, model MySQL by applying the query's OWN trailing
 * ORDER BY to scrambled equal-seq rows, and assert the deterministic replay order. A negative
 * control (the pre-fix single-key ORDER BY) proves the test has teeth.
 */

'use strict';

process.env.INDEXER_COIN    = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../src/recovery.js');
const Utility        = require('../../src/utility.js');

// Extract the trailing ORDER BY clause (columns + directions) of a query, or '' if none.
function orderClause(sql) {
    const idx = sql.toUpperCase().lastIndexOf('ORDER BY');
    if (idx < 0) return '';
    return sql.slice(idx + 'ORDER BY'.length).split(/;|\bLIMIT\b/i)[0].trim();
}

// Model MySQL honoring a possibly multi-key ORDER BY (`col [ASC|DESC], col [ASC|DESC]`)
// numerically. An empty clause leaves the injected scramble order intact.
function applyOrder(rows, clause) {
    if (!clause) return rows.slice();
    const keys = clause.split(',').map(k => {
        const [rawCol, dir] = k.trim().split(/\s+/);
        return { col: rawCol.replace(/^[A-Za-z0-9_]+\./, ''), sign: /DESC/i.test(dir || '') ? -1 : 1 };
    });
    return rows.slice().sort((a, b) => {
        for (const { col, sign } of keys) {
            const d = Number(a[col]) - Number(b[col]);
            if (d) return sign * d;
        }
        return 0;
    });
}

// Two v1 heads sharing match_batch_seq 42 (a failover double-publish), injected HIGH-first so
// insertion order alone would replay them in the wrong order. action_index 5 must replay
// before action_index 9 so the later head (9) supersedes deterministically on every node.
const dupHeads = [
    { action_index: 9, match_batch_seq: 42, version: 1 },
    { action_index: 5, match_batch_seq: 42, version: 1 }
];

// Drive the REAL run() only until the driver query fires, capture its SQL, then abort the run
// by returning [] (an empty head set short-circuits run() before any _verifyBatch work).
async function captureDriverSql() {
    const util = new Utility();
    let captured = null;
    const db = {
        async doQuery(sql) {
            // Leading `SELECT a.*`, not a literal prefix:  LEFT-joined the head's
            // author into this select list, and a prefix match would have gone silently
            // blind to the driver query it exists to pin.
            if (/^SELECT a\.\*/.test(String(sql).replace(/\s+/g, ' ').trim())) { captured = sql; return []; }
            return [];
        }
    };
    const rec = new AnchorRecovery(db, { util, log: () => {} });
    await rec.run();
    return captured;
}

describe('AnchorRecovery.run() driver replay determinism @regression @tier1', function () {

    it('orders the archive-head driver query by match_batch_seq ASC, action_index ASC', async function () {
        const sql = await captureDriverSql();
        assert.ok(sql, 'driver query was issued');
        const clause = orderClause(sql);
        assert.match(clause, /match_batch_seq\s+ASC/i, 'primary order is match_batch_seq ASC');
        assert.match(clause, /action_index\s+ASC/i, 'tie-break on action_index ASC is required');
        // action_index tie-break must come AFTER match_batch_seq.
        assert.ok(/match_batch_seq[\s\S]*action_index/i.test(clause),
            'action_index must be the secondary key, after match_batch_seq');
        // Must NOT order on the local AUTO_INCREMENT surrogate (per-node divergent).
        assert.doesNotMatch(clause, /\bid\b/i);
    });

    it('replays equal-batch_seq heads in a deterministic total order (earliest action_index first)', async function () {
        const sql = await captureDriverSql();
        const replayed = applyOrder(dupHeads, orderClause(sql));
        assert.deepStrictEqual(replayed.map(r => r.action_index), [5, 9],
            'canonical replay: lowest action_index first, so the later head supersedes last');
    });

    it('negative control: a match_batch_seq-only ORDER BY leaves the equal-seq tie unspecified', function () {
        // Model the pre-fix query. sort() is stable, so the HIGH-first scramble survives:
        // the later head (9) would replay FIRST and be wrongly superseded by the earlier one.
        const replayed = applyOrder(dupHeads, 'a.match_batch_seq ASC');
        assert.deepStrictEqual(replayed.map(r => r.action_index), [9, 5],
            'pre-fix single-key order leaves the tie in insertion order (non-deterministic across nodes)');
    });
});
