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
 * test/unit/anchor/anchor_action_query.test/anchor_action_query_getanchorconfirmations.test.js
 *
 * Sibling block of the anchor_action_query.test.js suite, carrying:
 *   anchor-action-query: getanchorconfirmations
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { concatSrcTreeFiles } = require('../../../helpers/src_tree_files');


function dbSource(){
    const dir = path.join(__dirname, '..', '..', '..', '..', 'src', 'db');
    return concatSrcTreeFiles(dir);
}

const { CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, ANCHOR_ACTIONS_SQL,
        validateAnchorActionParams, selectAnchorRow,
        buildAnchorActionResponse } = require('../../../../src/actions/anchor/anchor_action_query');
const { ARCHIVE_HEAD_VERSIONS } = require('../../../../src/consensus/state_hash.js');

const CONFIG = { COIN: 'DOGE', NETWORK: 'regtest' };

function anchorRow(overrides) {
    return Object.assign({
        action_index: 42, version: 0, chain: 'BTC', network: 'regtest', block_index: 850000,
        block_hash: 'a'.repeat(64), ledger_hash: 'b'.repeat(64), actions_hash: 'c'.repeat(64),
        contract_hash: 'd'.repeat(64), checkpoint_seq: 7, snapshot_block: 950000,
        state_root: null, state_root_version: null, block_merkle_root: null, block_merkle_version: null,
        block_index_doge: 100, status: 'valid'
    }, overrides || {});
}






const TXID_A = '1'.repeat(64);
const TXID_B = '2'.repeat(64);

const SECTION_TXID = '7'.repeat(64);
const ARCHIVE_TXID = '6'.repeat(64);

const { ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL, ANCHOR_ROW_LIMIT,
        validateAnchorConfirmationsParams,
        buildAnchorConfirmationsResponse } = require('../../../../src/actions/anchor/anchor_action_query');

function txidRow(overrides) {
    return Object.assign({
        action_index: 9, section_index: 0, version: 0, chain: 'BTC', network: 'regtest',
        block_index: 850000,
        checkpoint_seq: 7, snapshot_block: 950000, publisher: 'AA'.repeat(32),
        match_batch_seq: null, block_index_doge: 100, status: 'valid'
    }, overrides || {});
}

describe('anchor-action-query: getanchorconfirmations', function () {
    describe('buildAnchorConfirmationsResponse', function () {
        it('reports a short window as complete, with no cursor', function () {
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, [txidRow(), txidRow({ action_index: 10 })]);
            assert.strictEqual(r.truncated, false);
            assert.strictEqual(r.next_after_action_index, null);
            assert.strictEqual(r.anchors.length, 2);
        });

        it('reports an exactly-full page as complete rather than guessing', function () {
            // Exactly ANCHOR_ROW_LIMIT rows means the probe found nothing: the set really did
            // end here. Calling this truncated would turn a legitimate 'rejected' into an
            // endless walk, which is why the flag is probed rather than inferred from length.
            let rows = [];
            for (let i = 0; i < ANCHOR_ROW_LIMIT; i++) rows.push(txidRow({ action_index: 100 + i }));
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, rows);
            assert.strictEqual(r.truncated, false);
            assert.strictEqual(r.next_after_action_index, null);
            assert.strictEqual(r.anchors.length, ANCHOR_ROW_LIMIT);
        });

        // A row is (action_index, section_index): a v0 bundle writes one row per chain
        // section under ONE action_index. The cursor is exclusive on action_index alone, so a
        // page that ends between two sections of the same bundle resumes strictly past it and
        // loses the rest of that bundle for good - and a bundle missing its header-block
        // section reads to the caller as a complete non-matching set, i.e. a memoized
        // 'rejected' and a forfeited reward. So a truncated page is cut on an ACTION boundary.
        it('never ends a truncated page inside a multi-section bundle', function () {
            let rows = [];
            for (let i = 0; i < ANCHOR_ROW_LIMIT - 1; i++) rows.push(txidRow({ action_index: 100 + i }));
            // The bundle straddles the cut: section 0 is the 20th row, section 1 the probe.
            rows.push(txidRow({ action_index: 200, section_index: 0, snapshot_block: 894 }));
            rows.push(txidRow({ action_index: 200, section_index: 1, snapshot_block: 900 }));
            assert.strictEqual(rows.length, ANCHOR_ROW_LIMIT + 1);

            let page1 = buildAnchorConfirmationsResponse(CONFIG, 200, rows);
            assert.strictEqual(page1.truncated, true);
            assert.ok(page1.anchors.every(a => a.action_index !== 200),
                'no partial bundle may be served: the split action is trimmed off the page');
            assert.strictEqual(page1.anchors.length, ANCHOR_ROW_LIMIT - 1,
                'a truncated page is variable-length, never longer than the cap');
            assert.strictEqual(page1.next_after_action_index, 100 + ANCHOR_ROW_LIMIT - 2,
                'the cursor is the last WHOLE action on the page');

            // Resuming on that cursor returns the bundle entire, so the concatenated walk
            // loses no section and repeats none.
            let page2 = buildAnchorConfirmationsResponse(CONFIG, 200, rows.filter(
                row => row.action_index > page1.next_after_action_index));
            assert.strictEqual(page2.truncated, false);
            assert.deepStrictEqual(page2.anchors.map(a => a.section_index), [0, 1]);
            let walked = page1.anchors.concat(page2.anchors)
                .map(a => a.action_index + ':' + a.section_index);
            assert.strictEqual(new Set(walked).size, walked.length, 'no row may repeat across pages');
            assert.strictEqual(walked.length, ANCHOR_ROW_LIMIT + 1, 'no row may be lost across pages');
        });
    });
});

describe('anchor-action-query: getanchorconfirmations', function () {
    describe('buildAnchorConfirmationsResponse', function () {
        // Trimming to an action boundary must never produce an empty page: its cursor would
        // not advance and the walk would never terminate. Unreachable while a bundle carries
        // at most one section per allowed chain, so it is a loud guard, not a code path.
        it('keeps the page rather than emitting an empty one when a single action overflows the cap', function () {
            let rows = [];
            for (let i = 0; i < ANCHOR_ROW_LIMIT + 1; i++)
                rows.push(txidRow({ action_index: 7, section_index: i }));
            let errs = [];
            let realError = console.error;
            console.error = (...a) => errs.push(a.join(' '));
            let r;
            try { r = buildAnchorConfirmationsResponse(CONFIG, 200, rows); }
            finally { console.error = realError; }
            assert.strictEqual(r.anchors.length, ANCHOR_ROW_LIMIT, 'the page is kept, not emptied');
            assert.strictEqual(r.next_after_action_index, 7);
            assert.strictEqual(errs.length, 1, 'the unreachable case must be reported, not swallowed');
            assert.match(errs[0], /action_index 7 spans more than/);
        });

        it('serves the row identity so a caller can tell two anchors on one transaction apart', function () {
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, [
                txidRow({ action_index: 11, section_index: 0 }),
                txidRow({ action_index: 11, section_index: 1 }),
                txidRow({ action_index: 12, section_index: 0 })
            ]);
            assert.deepStrictEqual(r.anchors.map(a => a.action_index), [11, 11, 12]);
            assert.deepStrictEqual(r.anchors.map(a => a.section_index), [0, 1, 0]);
        });
    });
});

describe('anchor-action-query: getanchorconfirmations', function () {
    describe('ANCHOR_BY_TXID_SQL', function () {
        it('keys on the transaction hash and joins through to anchor_actions', function () {
            assert.match(ANCHOR_BY_TXID_SQL, /FROM index_transactions it/);
            assert.match(ANCHOR_BY_TXID_SQL, /JOIN anchor_actions a/);
            assert.match(ANCHOR_BY_TXID_SQL, /WHERE it\.hash = \?/);
        });

        it('selects the columns the reward binding compares against', function () {
            for (const col of ['a.publisher', 'a.snapshot_block', 'a.checkpoint_seq', 'a.match_batch_seq', 'a.version', 's.status'])
                assert.ok(ANCHOR_BY_TXID_SQL.includes(col), 'missing ' + col);
        });

        it('fetches exactly one row past the cap as a truncation probe', function () {
            assert.ok(ANCHOR_BY_TXID_SQL.includes('LIMIT ' + (ANCHOR_ROW_LIMIT + 1)),
                'the read must fetch ANCHOR_ROW_LIMIT+1 so the builder can tell a full page from a cut-off one');
        });

        it('resumes exclusively after a cursor, so pages partition the set', function () {
            assert.match(ANCHOR_BY_TXID_AFTER_SQL, /WHERE it\.hash = \? AND a\.action_index > \?/);
            assert.match(ANCHOR_BY_TXID_AFTER_SQL, /ORDER BY a\.action_index ASC/);
            assert.ok(ANCHOR_BY_TXID_AFTER_SQL.includes('LIMIT ' + (ANCHOR_ROW_LIMIT + 1)));
        });

        // The row identity is (action_index, section_index). Without the section tiebreak the
        // within-bundle order is whatever the engine returns, so which section a page cut
        // lands on could differ between two nodes reading the same rows.
        it('selects and orders the section index, the other half of the row identity', function () {
            for (const sql of [ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL]) {
                assert.ok(sql.includes('a.section_index'), 'section_index must be projected');
                assert.match(sql, /ORDER BY a\.action_index ASC, a\.section_index ASC/);
            }
        });
    });

    describe('the page cursor is validated, never coerced', function () {
        it('accepts an absent cursor as "first page"', function () {
            assert.strictEqual(validateAnchorConfirmationsParams({ txid: 'a'.repeat(64) }).after, null);
            assert.strictEqual(
                validateAnchorConfirmationsParams({ txid: 'a'.repeat(64), after_action_index: null }).after, null);
        });

        it('accepts a non-negative integer cursor', function () {
            assert.strictEqual(
                validateAnchorConfirmationsParams({ txid: 'a'.repeat(64), after_action_index: 0 }).after, 0);
            assert.strictEqual(
                validateAnchorConfirmationsParams({ txid: 'a'.repeat(64), after_action_index: 41 }).after, 41);
        });

        it('refuses a junk cursor rather than silently restarting the walk at page one', function () {
            for (const bad of ['x', -1, 1.5, NaN, Infinity, {}, []])
                assert.strictEqual(
                    validateAnchorConfirmationsParams({ txid: 'a'.repeat(64), after_action_index: bad }).ok, false,
                    'cursor ' + String(bad) + ' must be refused');
        });
    });
});
