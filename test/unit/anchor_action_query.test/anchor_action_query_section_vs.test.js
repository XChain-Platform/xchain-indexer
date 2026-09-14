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
 * test/unit/anchor_action_query.test/anchor_action_query_section_vs.test.js
 *
 * Sibling block of the anchor_action_query.test.js suite, carrying:
 *   anchor-action-query: section vs co-located archive head
 *   anchor-action-query: response txid + checkpoint_anchored
 *   anchor-action-query: ANCHOR_ACTIONS_SQL
 *   anchor-action-query: getanchorconfirmations
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { concatSrcTreeFiles } = require('../../helpers/src_tree_files');


function dbSource(){
    const dir = path.join(__dirname, '..', '..', '..', 'src', 'db');
    return concatSrcTreeFiles(dir);
}

const { CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, ANCHOR_ACTIONS_SQL,
        validateAnchorActionParams, selectAnchorRow,
        buildAnchorActionResponse } = require('../../../src/actions/anchor/anchor_action_query');
const { ARCHIVE_HEAD_VERSIONS } = require('../../../src/stateHash.js');

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
        buildAnchorConfirmationsResponse } = require('../../../src/actions/anchor/anchor_action_query');

function txidRow(overrides) {
    return Object.assign({
        action_index: 9, section_index: 0, version: 0, chain: 'BTC', network: 'regtest',
        block_index: 850000,
        checkpoint_seq: 7, snapshot_block: 950000, publisher: 'AA'.repeat(32),
        match_batch_seq: null, block_index_doge: 100, status: 'valid'
    }, overrides || {});
}   // the archive head's, a different transaction

// ── A v0 section and a v1 archive head sharing ONE checkpoint key ───────────────
//
// The archive leg wraps the same checkpoint the bundle section anchors, so both rows
// carry the identical (chain, network, block_index, checkpoint_seq), and the archive
// head lands later, at the higher action_index. Reproduced on the DOGE
// regtest indexer: getanchoraction(BTC, regtest, 11237, 11243) with no version and no
// txid answered from the archive head, so a caller asking "is this checkpoint
// anchored" was handed a different transaction's txid and status and could not tell.
// The hub's own adopt path filters on the bundle version and never saw it; every unfiltered
// reader (the SDK, the e2e harnesses, third parties) did.
describe('anchor-action-query: section vs co-located archive head', function () {
    // The venue's own key and action indexes, in the pure action_index DESC order the
    // read used before the family term, which is what makes the archive head win.
    function colocated() {
        return [
            anchorRow({ action_index: 1305, version: 1, chain: 'BTC', block_index: 11237,
                        checkpoint_seq: 11243, txid: ARCHIVE_TXID }),
            anchorRow({ action_index: 1298, version: 0, chain: 'BTC', block_index: 11237,
                        checkpoint_seq: 11243, txid: SECTION_TXID })
        ];
    }

    it('unfiltered, returns the checkpoint SECTION, not the higher-action_index archive head', function () {
        let row = selectAnchorRow(colocated(), {});
        assert.strictEqual(Number(row.version), 0);
        assert.strictEqual(row.action_index, 1298);
        assert.strictEqual(row.txid, SECTION_TXID);
    });

    it('answers the same with no filter object at all', function () {
        assert.strictEqual(Number(selectAnchorRow(colocated(), null).version), 0);
        assert.strictEqual(Number(selectAnchorRow(colocated(), undefined).version), 0);
    });

    it('is independent of the arrival order (the family ranks, not the position)', function () {
        // As ANCHOR_ACTIONS_SQL now delivers them (section first) and reversed.
        let sectionFirst = colocated().reverse();
        assert.strictEqual(selectAnchorRow(sectionFirst, {}).action_index, 1298);
        assert.strictEqual(selectAnchorRow(colocated(), {}).action_index, 1298);
    });

    it('still reaches the archive head through an explicit archive version filter', function () {
        for (const v of ARCHIVE_HEAD_VERSIONS) {
            let rows = colocated();
            rows[0].version = v;
            let row = selectAnchorRow(rows, { version: v });
            assert.strictEqual(Number(row.version), v, 'v' + v + ' archive head must stay reachable');
            assert.strictEqual(row.txid, ARCHIVE_TXID);
        }
    });

    it('still reaches the archive head by its own txid', function () {
        let row = selectAnchorRow(colocated(), { txid: ARCHIVE_TXID });
        assert.strictEqual(Number(row.version), 1);
        assert.strictEqual(row.action_index, 1305);
    });

    it('resolves the section by version 0 and by its own txid', function () {
        assert.strictEqual(selectAnchorRow(colocated(), { version: 0 }).action_index, 1298);
        assert.strictEqual(selectAnchorRow(colocated(), { txid: SECTION_TXID }).action_index, 1298);
    });

    it('leaves an archive-only key answering unfiltered (the archive leg is not broken)', function () {
        let archiveOnly = [colocated()[0]];
        let row = selectAnchorRow(archiveOnly, {});
        assert.strictEqual(Number(row.version), 1);
        assert.strictEqual(row.action_index, 1305);
    });
});

describe('anchor-action-query: section vs co-located archive head', function () {
    it('keeps newest-wins WITHIN the section family (a reorg-replayed re-anchor supersedes)', function () {
        let rows = [
            anchorRow({ action_index: 1310, version: 1, checkpoint_seq: 11243, txid: ARCHIVE_TXID }),
            anchorRow({ action_index: 1301, version: 0, checkpoint_seq: 11243, txid: TXID_B }),
            anchorRow({ action_index: 1298, version: 0, checkpoint_seq: 11243, txid: SECTION_TXID })
        ];
        assert.strictEqual(selectAnchorRow(rows, {}).action_index, 1301);
    });

    it('partitions the served version set into exactly two families', function () {
        // Neither family may be empty, and together they must be the whole served set:
        // a version in CHECKPOINT_VERSIONS that is in neither would be silently
        // unrankable, which is the defect wearing a new version byte.
        assert.deepStrictEqual(CHECKPOINT_SECTION_VERSIONS, [0]);
        let union = CHECKPOINT_SECTION_VERSIONS.concat(
            CHECKPOINT_VERSIONS.filter(v => ARCHIVE_HEAD_VERSIONS.includes(v)));
        assert.deepStrictEqual(union.slice().sort((a, b) => a - b), CHECKPOINT_VERSIONS.slice().sort((a, b) => a - b));
        for (const v of CHECKPOINT_SECTION_VERSIONS)
            assert.ok(!ARCHIVE_HEAD_VERSIONS.includes(v), 'v' + v + ' cannot be in both families');
    });

    it('leaves the stale-seq replay watermark reading the FULL checkpoint set', function () {
        // getMaxAnchorCheckpointSeq is the ANCHOR replay guard and must keep counting
        // archive rows: narrowing it to the section family would lower the watermark and
        // re-admit replays. A hand-copied literal there froze the guard once already, so
        // this asserts the shared constant, not a number.
        // The Database class is a directory of per-family mixins, so the scan reads all of it.
        let src = dbSource();
        let body = src.slice(src.indexOf('async getMaxAnchorCheckpointSeq('));
        body = body.slice(0, body.indexOf('\n    }'));
        assert.match(body, /let versions = ANCHOR_CHECKPOINT_VERSIONS;/);
        assert.ok(!/CHECKPOINT_SECTION_VERSIONS/.test(body),
            'the replay watermark must not be narrowed to the section family');
    });
});

describe('anchor-action-query: response txid + checkpoint_anchored', function () {
    it('surfaces the lowercased txid of the matched row', function () {
        let r = buildAnchorActionResponse(CONFIG, 200, anchorRow({ txid: 'AB'.repeat(32) }));
        assert.strictEqual(r.txid, 'ab'.repeat(32));
    });

    it('reports txid null when the tx linkage is missing', function () {
        assert.strictEqual(buildAnchorActionResponse(CONFIG, 200, anchorRow({ txid: null })).txid, null);
    });

    it('distinguishes a forged txid (anchored, no match) from a never-anchored checkpoint', function () {
        let forged = buildAnchorActionResponse(CONFIG, 200, null, { checkpoint_anchored: true });
        assert.strictEqual(forged.exists, false);
        assert.strictEqual(forged.checkpoint_anchored, true);   // caller -> positively-detected forge

        let absent = buildAnchorActionResponse(CONFIG, 200, null, { checkpoint_anchored: false });
        assert.strictEqual(absent.exists, false);
        assert.strictEqual(absent.checkpoint_anchored, false);  // caller -> benign, not anchored yet
    });

    it('defaults checkpoint_anchored to !!row so a filterless caller is unchanged', function () {
        assert.strictEqual(buildAnchorActionResponse(CONFIG, 200, anchorRow()).checkpoint_anchored, true);
        assert.strictEqual(buildAnchorActionResponse(CONFIG, 200, null).checkpoint_anchored, false);
    });
});

describe('anchor-action-query: ANCHOR_ACTIONS_SQL', function () {
    it('resolves the txid through actions -> transactions -> index_transactions', function () {
        assert.match(ANCHOR_ACTIONS_SQL, /it\.hash\s+AS\s+txid/);
        assert.match(ANCHOR_ACTIONS_SQL, /LEFT JOIN actions/);
        assert.match(ANCHOR_ACTIONS_SQL, /LEFT JOIN transactions/);
        assert.match(ANCHOR_ACTIONS_SQL, /LEFT JOIN index_transactions/);
    });

    it('LEFT-JOINs the tx linkage so a present anchor never reads as absent', function () {
        assert.doesNotMatch(ANCHOR_ACTIONS_SQL, /INNER JOIN actions/);
    });

    it('orders sections before archive heads, newest-first within a family, and bounds the set', function () {
        // The family term must rank AHEAD of action_index: archive rows sharing a
        // checkpoint key sit at higher action_index values, so under a pure
        // action_index DESC order enough of them would push the bundle section out of
        // the LIMIT window, where no downstream tie-break can recover it.
        assert.match(ANCHOR_ACTIONS_SQL,
            /ORDER BY \(a\.version IN \([\d, ]+\)\) DESC, a\.action_index DESC/);
        assert.match(ANCHOR_ACTIONS_SQL, /LIMIT \d+/);
    });

    it('ranks the family on the section version set, not a hand-copied literal', function () {
        let ranked = ANCHOR_ACTIONS_SQL.match(/ORDER BY \(a\.version IN \(([\d, ]+)\)\) DESC/)[1];
        assert.deepStrictEqual(ranked.split(',').map(s => Number(s.trim())), CHECKPOINT_SECTION_VERSIONS);
    });

    it('has one version placeholder per checkpoint-bearing version', function () {
        let inClause = ANCHOR_ACTIONS_SQL.match(/a\.version IN \(([^)]*)\)/)[1];
        assert.strictEqual(inClause.split(',').length, CHECKPOINT_VERSIONS.length);
    });
});

// ── getanchorconfirmations: DOGE anchor visibility for the BTC indexer ──────────
//
// The read the BTC side uses to re-prove that the anchor it is about to pay for was
// actually mined. Keyed on the txid alone, because that is the only DOGE-side identity a
// mirrored anchor_reward_attestations row carries. The response has to keep three things
// separable for the caller: what the transaction anchored, how deep it is, and whether it
// exists at all - collapsing any of those into a bare boolean loses the caller's ability to
// tell a forge from a lagging DOGE indexer.
describe('anchor-action-query: getanchorconfirmations', function () {
    describe('validateAnchorConfirmationsParams', function () {
        it('accepts a 64-hex txid and lowercases it', function () {
            let v = validateAnchorConfirmationsParams({ txid: 'A'.repeat(64) });
            assert.strictEqual(v.ok, true);
            assert.strictEqual(v.txid, 'a'.repeat(64));
        });

        it('rejects a short, non-hex, missing or non-string txid', function () {
            for (const bad of ['a'.repeat(63), 'z'.repeat(64), undefined, null, 12345, ''])
                assert.strictEqual(validateAnchorConfirmationsParams({ txid: bad }).ok, false);
        });
    });
});

describe('anchor-action-query: getanchorconfirmations', function () {
    describe('buildAnchorConfirmationsResponse', function () {
        it('reports depth as DOGE-relative burial of the block the tx landed in', function () {
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, [txidRow()]);
            assert.strictEqual(r.exists, true);
            assert.strictEqual(r.anchors[0].confirmations, 101);   // 200 - 100 + 1
        });

        it('reports 0 confirmations for a row deeper than tip or a non-finite latest', function () {
            assert.strictEqual(buildAnchorConfirmationsResponse(CONFIG, 50, [txidRow()]).anchors[0].confirmations, 0);
            assert.strictEqual(buildAnchorConfirmationsResponse(CONFIG, null, [txidRow()]).anchors[0].confirmations, 0);
        });

        it('lowercases the publisher and nulls it on an unattested version', function () {
            assert.strictEqual(buildAnchorConfirmationsResponse(CONFIG, 200, [txidRow()]).anchors[0].publisher,
                'aa'.repeat(32));
            assert.strictEqual(
                buildAnchorConfirmationsResponse(CONFIG, 200, [txidRow({ version: 2, publisher: null })]).anchors[0].publisher,
                null);
        });

        // A decoded-invalid row is a positively-detected forge for the caller; filtering it
        // out would make it indistinguishable from "the DOGE indexer has not seen this tx",
        // which is the one case the caller must treat as retryable rather than final.
        it('reports a decoded-invalid anchor rather than hiding it', function () {
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, [txidRow({ status: 'invalid: bad sigs' })]);
            assert.strictEqual(r.exists, true);
            assert.strictEqual(r.anchors[0].status, 'invalid: bad sigs');
        });

        it('returns every anchor the transaction carries, not just one', function () {
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, [txidRow({ version: 1, match_batch_seq: 3 }), txidRow()]);
            assert.strictEqual(r.anchors.length, 2);
            assert.strictEqual(r.anchors[0].match_batch_seq, 3);
        });

        it('reports exists:false with an empty list for an unseen txid', function () {
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, []);
            assert.strictEqual(r.exists, false);
            assert.deepStrictEqual(r.anchors, []);
        });

        // The bound must be visible on the wire: a page cut off at ANCHOR_ROW_LIMIT reads
        // exactly like a complete non-matching set, and anchor_proof_client turns that into
        // a memoized permanent 'rejected' forfeiting a legitimate COLLECT-spendable reward.
        // So the response states both that it was cut off and where to resume.
        it('reports a full window as truncated and drops the probe row', function () {
            let rows = [];
            for (let i = 0; i < ANCHOR_ROW_LIMIT + 1; i++) rows.push(txidRow({ action_index: 100 + i }));
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, rows);
            assert.strictEqual(r.truncated, true);
            assert.strictEqual(r.anchors.length, ANCHOR_ROW_LIMIT,
                'the ANCHOR_ROW_LIMIT+1st row is a truncation probe and must never reach the caller');
            assert.strictEqual(r.next_after_action_index, 100 + ANCHOR_ROW_LIMIT - 1,
                'the cursor must be the LAST RETURNED action_index, so the next page neither skips nor repeats');
        });
    });
});
