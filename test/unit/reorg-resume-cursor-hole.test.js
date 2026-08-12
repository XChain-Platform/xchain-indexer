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
 * test/unit/reorg-resume-cursor-hole.test.js
 *
 * Regression coverage for the post-rollback RESUME cursor in
 * XChainIndexer.start() - the reorg-hole consensus bug fixed in e2b36c4 and
 * re-audited under.
 *
 * The bug: start() reads `lastIndexerBlock` BEFORE handling reorgs. rollback()
 * then deletes every `blocks` row >= the reorg point. Resuming from the stale
 * pre-rollback tip + 1 permanently skips the new chain's version of the
 * rolled-back range, leaving exactly one missing `blocks` row per depth-1
 * reorg. Missing rows are not cosmetic: getBlockHashes then hashes the next
 * block with `previous_hash` undefined (JSON.stringify drops it), silently
 * restarting the ledger/actions/contract hash chains, and any XChain
 * transaction confirmed in the skipped block never enters the ledger.
 *
 * The catch-up loop lives inside start() and is not importable in isolation,
 * so these tests exercise the real db primitive it composes (getBlockIndex)
 * over an in-memory `blocks` table and assert the load-bearing properties:
 *   1. Resuming from the PRE-rollback cursor leaves a permanent hole (the bug),
 *      and the hole never heals because the loop only ever moves forward.
 *   2. Re-reading the cursor AFTER rollback resumes exactly at the reorg point,
 *      so the new chain's blocks are parsed and the height range stays dense.
 *   3. The re-read survives a multi-block (depth > 1) rollback.
 * A fourth test guards the source shape itself, so the one-line re-read cannot
 * be dropped again without a red suite.
 */

'use strict';

const assert   = require('assert');
const fs       = require('fs');
const path     = require('path');
const Database = require('../../src/db');

// Minimal indexer stub: the Database constructor only touches config + util.
function stubIndexer() {
    return {
        config: {},
        util: {
            isNull: (v) => v === null || v === undefined,
            logError: () => {}
        }
    };
}

// A Database whose doQuery runs against an in-memory `blocks` table, emulating
// the exact query shape getBlockIndex issues (SELECT MIN/MAX(block_index)).
// `heights` is the live set of indexed block heights.
function makeIndexerDb(heights) {
    const db  = new Database('h', 0, 'd', 'u', 'p', stubIndexer());
    const set = new Set(heights);

    const exec = (query) => {
        const m = /SELECT (MIN|MAX)\(block_index\) AS block_index FROM blocks/.exec(query);
        if (m) {
            const all = [...set];
            if (all.length === 0) return [{ block_index: null }];
            return [{ block_index: m[1] === 'MIN' ? Math.min(...all) : Math.max(...all) }];
        }
        throw new Error('unexpected query in test harness: ' + query);
    };

    db.doQuery       = async (q) => exec(q);
    db.doQueryStrict = async (q) => exec(q);

    // rollback() deletes every row at or above the reorg point, exactly as
    // Rollback.rollback does to `blocks`.
    db._rollbackBlocks = (minReorgBlock) => {
        for (const h of [...set]) if (h >= minReorgBlock) set.delete(h);
    };
    db._parse   = (h) => set.add(h);
    db._heights = () => [...set].sort((a, b) => a - b);
    return db;
}

// Heights missing between the low and high watermark: the reorg holes the
// 2026-06-11 fleet evidence found (DOGE mainnet 6241887 et al.).
function holes(heights) {
    if (heights.length === 0) return [];
    const set  = new Set(heights);
    const gaps = [];
    for (let h = heights[0]; h <= heights[heights.length - 1]; h++)
        if (!set.has(h)) gaps.push(h);
    return gaps;
}

describe('reorg resume cursor - permanent block holes (XChainIndexer.start, e2b36c4 /)', function () {

    // A depth-1 reorg at 6241887 on a chain indexed through 6241887.
    const TIP            = 6241887;
    const MIN_REORG      = 6241887;
    const SEED           = [6241884, 6241885, 6241886, 6241887];
    const NEW_CHAIN_TIP  = 6241889;

    it('leaves a permanent hole when the resume cursor is NOT re-read (the bug)', async function () {
        const db = makeIndexerDb(SEED);

        // start() reads the cursor BEFORE handling the reorg.
        let lastIndexerBlock = await db.getBlockIndex('indexer', 'last');
        assert.strictEqual(lastIndexerBlock, TIP, 'pre-rollback cursor is the old-chain tip');

        db._rollbackBlocks(MIN_REORG);

        // Bug: resume from the stale cursor + 1, skipping the new chain's 6241887.
        for (let h = lastIndexerBlock + 1; h <= NEW_CHAIN_TIP; h++) db._parse(h);

        assert.deepStrictEqual(holes(db._heights()), [MIN_REORG],
            'exactly one missing blocks row per depth-1 reorg');
    });

    it('never heals the hole on later passes, because the loop only moves forward', async function () {
        const db = makeIndexerDb(SEED);
        let lastIndexerBlock = await db.getBlockIndex('indexer', 'last');
        db._rollbackBlocks(MIN_REORG);
        for (let h = lastIndexerBlock + 1; h <= NEW_CHAIN_TIP; h++) db._parse(h);

        // A subsequent quiet pass re-reads the cursor from the DB, which is now
        // the post-hole tip - so the missing height is never revisited.
        const resumed = await db.getBlockIndex('indexer', 'last');
        assert.strictEqual(resumed, NEW_CHAIN_TIP);
        for (let h = resumed + 1; h <= NEW_CHAIN_TIP + 2; h++) db._parse(h);

        assert.deepStrictEqual(holes(db._heights()), [MIN_REORG],
            'the hole is permanent: only a re-index from below it can close it');
    });

    it('re-reading the cursor after rollback resumes at the reorg point (the fix)', async function () {
        const db = makeIndexerDb(SEED);

        let lastIndexerBlock = await db.getBlockIndex('indexer', 'last');
        assert.ok(lastIndexerBlock >= MIN_REORG, 'rollback is only taken when the tip reached the reorg');

        db._rollbackBlocks(MIN_REORG);
        // The fix: re-read the cursor from the DB after the rollback committed.
        lastIndexerBlock = await db.getBlockIndex('indexer', 'last');
        assert.strictEqual(lastIndexerBlock, MIN_REORG - 1,
            'post-rollback cursor sits one below the reorg point');

        for (let h = lastIndexerBlock + 1; h <= NEW_CHAIN_TIP; h++) db._parse(h);

        assert.deepStrictEqual(holes(db._heights()), [], 'dense height range, no dropped blocks');
        assert.ok(db._heights().includes(MIN_REORG),
            "the new chain's version of the rolled-back block is parsed");
    });

    it('re-reads correctly for a multi-block (depth > 1) rollback', async function () {
        const deepSeed = [6241880, 6241881, 6241882, 6241883, 6241884, 6241885, 6241886, 6241887];
        const deepMin  = 6241883;
        const db       = makeIndexerDb(deepSeed);

        const stale = await db.getBlockIndex('indexer', 'last');
        db._rollbackBlocks(deepMin);
        const fresh = await db.getBlockIndex('indexer', 'last');

        assert.strictEqual(stale, 6241887);
        assert.strictEqual(fresh, deepMin - 1, 'cursor drops by the full rollback depth');

        for (let h = fresh + 1; h <= NEW_CHAIN_TIP; h++) db._parse(h);
        assert.deepStrictEqual(holes(db._heights()), [],
            'all five rolled-back heights are re-parsed from the new chain');
    });

    it('start() still re-reads the resume cursor immediately after rollback (source guard)', function () {
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'XChainIndexer.js'), 'utf8');

        const rollbackCall = 'await this.rollback.rollback(minReorgBlock);';
        const at = src.indexOf(rollbackCall);
        assert.notStrictEqual(at, -1, 'the reorg rollback call must exist in start()');

        // Everything between the rollback and the end of the enclosing block.
        const after = src.slice(at + rollbackCall.length, at + rollbackCall.length + 1500);
        const reRead = /lastIndexerBlock\s*=\s*await\s+indexerReorgView\.getBlockIndex\(\s*'indexer'\s*,\s*'last'\s*\)/;

        assert.ok(reRead.test(after),
            'the resume cursor must be re-read from the DB after rollback(); dropping this ' +
            'line re-introduces the permanent reorg holes fixed in e2b36c4');

        // And it must land before the processed-reorg markers are written, so a
        // throw inside the rollback window cannot advance the cursor past it.
        const markerLoop = after.indexOf('for(let reorg of unprocessedReorgs)');
        const reReadAt   = after.search(reRead);
        assert.ok(markerLoop === -1 || reReadAt < markerLoop,
            'the re-read must precede the processed-reorg marker writes');
    });
});
