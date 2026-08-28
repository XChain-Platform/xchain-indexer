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
 * test/unit/anchor-action-query.test.js
 *
 * Unit coverage for the getanchoraction RPC's pure logic (api.js delegates to it;
 * startApi is not importable). Guards the request validation and the row -> response
 * mapping, especially the DOGE confirmation-depth math the hub gates on (an off-by-one
 * or a negative depth silently trusted would defeat the anchor verification).
 */

'use strict';

const assert = require('assert');
const { CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, ANCHOR_ACTIONS_SQL,
        validateAnchorActionParams, selectAnchorRow,
        buildAnchorActionResponse } = require('../../src/anchor-action-query');
const { ARCHIVE_HEAD_VERSIONS } = require('../../src/stateHash.js');

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

describe('anchor-action-query: CHECKPOINT_VERSIONS', function () {
    it('is exactly the checkpoint-bearing versions (v2 continuation excluded)', function () {
        // 7 is the bundle SECTION, which carries a full checkpoint identity of its own;
        // 1 and 6 are the archive legs, which carry their wrapper checkpoint's. The
        // retired 0/3/4/5 are OUT: nothing parses them any more, and admitting them would
        // let a pre-retirement row keep raising the replay watermark that
        // getMaxAnchorCheckpointSeq reads off this same set.
        assert.deepStrictEqual(CHECKPOINT_VERSIONS, [1, 6, 7]);
        assert.ok(!CHECKPOINT_VERSIONS.includes(2), 'v2 (archive continuation) is not a checkpoint');
        for (const retired of [0, 3, 4, 5])
            assert.ok(!CHECKPOINT_VERSIONS.includes(retired),
                'ANCHOR v' + retired + ' is retired (D2) and must not re-enter the checkpoint set');
    });
});

describe('anchor-action-query: validateAnchorActionParams()', function () {
    it('accepts a well-formed request and coerces numeric strings to integers', function () {
        let v = validateAnchorActionParams({ chain: 'BTC', network: 'regtest', block_index: '850000', checkpoint_seq: '7' });
        assert.deepStrictEqual(v, { ok: true, block_index: 850000, checkpoint_seq: 7, txid: null, version: null });
    });

    it('rejects a missing or non-string chain/network', function () {
        assert.strictEqual(validateAnchorActionParams({ chain: '', network: 'regtest', block_index: 1, checkpoint_seq: 1 }).ok, false);
        assert.strictEqual(validateAnchorActionParams({ chain: 'BTC', network: null, block_index: 1, checkpoint_seq: 1 }).ok, false);
        assert.strictEqual(validateAnchorActionParams({ chain: 5, network: 'regtest', block_index: 1, checkpoint_seq: 1 }).ok, false);
    });

    it('rejects a negative, non-integer, or non-numeric block_index / checkpoint_seq', function () {
        assert.strictEqual(validateAnchorActionParams({ chain: 'BTC', network: 'regtest', block_index: -1, checkpoint_seq: 1 }).ok, false);
        assert.strictEqual(validateAnchorActionParams({ chain: 'BTC', network: 'regtest', block_index: 1.5, checkpoint_seq: 1 }).ok, false);
        assert.strictEqual(validateAnchorActionParams({ chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 'abc' }).ok, false);
        assert.strictEqual(validateAnchorActionParams({ chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: -3 }).ok, false);
    });

    it('accepts checkpoint_seq 0 (genesis-adjacent) and block_index 0', function () {
        assert.strictEqual(validateAnchorActionParams({ chain: 'BTC', network: 'regtest', block_index: 0, checkpoint_seq: 0 }).ok, true);
    });
});

describe('anchor-action-query: buildAnchorActionResponse()', function () {
    it('reports exists:false with 0 confirmations when no row is found', function () {
        let r = buildAnchorActionResponse(CONFIG, 159, null);
        assert.deepStrictEqual(r, { coin: 'DOGE', network: 'regtest', exists: false, checkpoint_anchored: false,
                                    latest_block_index: 159, confirmations: 0 });
    });

    it('computes DOGE confirmation depth as latest - block_index_doge + 1', function () {
        // Anchor landed in DOGE block 100; tip 159 => 60 confirmations (the XCHAIN_CONFIRMATIONS_DOGE floor).
        assert.strictEqual(buildAnchorActionResponse(CONFIG, 159, anchorRow({ block_index_doge: 100 })).confirmations, 60);
        // Tip == the anchor block => exactly 1 confirmation.
        assert.strictEqual(buildAnchorActionResponse(CONFIG, 100, anchorRow({ block_index_doge: 100 })).confirmations, 1);
    });

    it('reports 0 confirmations (never negative) when the anchor block is above tip (rolled back / lagging)', function () {
        assert.strictEqual(buildAnchorActionResponse(CONFIG, 99, anchorRow({ block_index_doge: 100 })).confirmations, 0);
        assert.strictEqual(buildAnchorActionResponse(CONFIG, null, anchorRow({ block_index_doge: 100 })).confirmations, 0);
    });

    it('maps the checkpoint payload fields the hub verifies against', function () {
        let r = buildAnchorActionResponse(CONFIG, 200, anchorRow());
        assert.strictEqual(r.exists, true);
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(r.checkpoint_chain, 'BTC');
        assert.strictEqual(r.checkpoint_network, 'regtest');
        assert.strictEqual(r.block_index, 850000);
        assert.strictEqual(r.block_hash, 'a'.repeat(64));
        assert.strictEqual(r.ledger_hash, 'b'.repeat(64));
        assert.strictEqual(r.actions_hash, 'c'.repeat(64));
        assert.strictEqual(r.contract_hash, 'd'.repeat(64));
        assert.strictEqual(r.checkpoint_seq, 7);
        assert.strictEqual(r.snapshot_block, 950000);
        assert.strictEqual(r.block_index_doge, 100);
    });

    it('carries an invalid status through so the hub can reject it (never silently trusts)', function () {
        let r = buildAnchorActionResponse(CONFIG, 200, anchorRow({ status: 'invalid: sig quorum not met' }));
        assert.strictEqual(r.exists, true);
        assert.strictEqual(r.status, 'invalid: sig quorum not met');
    });

    it('normalizes null snapshot_block / roots and reflects v3 roots when present', function () {
        let none = buildAnchorActionResponse(CONFIG, 200, anchorRow({ snapshot_block: null, state_root: null, block_merkle_root: null }));
        assert.strictEqual(none.snapshot_block, null);
        assert.strictEqual(none.state_root, null);
        assert.strictEqual(none.block_merkle_root, null);
        let v3 = buildAnchorActionResponse(CONFIG, 200, anchorRow({ version: 3, state_root: 'e'.repeat(64), block_merkle_root: 'f'.repeat(64) }));
        assert.strictEqual(v3.version, 3);
        assert.strictEqual(v3.state_root, 'e'.repeat(64));
        assert.strictEqual(v3.block_merkle_root, 'f'.repeat(64));
    });

    // ── state_root_version / block_merkle_version (item 2750) ────────────────
    // ANCHOR_ACTIONS_SQL selects a.state_root_version and a.block_merkle_version
    // alongside the roots; the response must carry both version discriminators,
    // and a null root must never carry a version (a null root has no version to
    // discriminate, so an ambient value there would be a phantom signal).

    it('carries the stored version fields alongside each root when both are present', function () {
        let r = buildAnchorActionResponse(CONFIG, 200, anchorRow({
            state_root: 'e'.repeat(64), state_root_version: 3,
            block_merkle_root: 'f'.repeat(64), block_merkle_version: 3
        }));
        assert.strictEqual(r.state_root, 'e'.repeat(64));
        assert.strictEqual(r.state_root_version, 3);
        assert.strictEqual(r.block_merkle_root, 'f'.repeat(64));
        assert.strictEqual(r.block_merkle_version, 3);
    });

    it('reports both version fields null when the corresponding root is null', function () {
        let r = buildAnchorActionResponse(CONFIG, 200, anchorRow({
            state_root: null, state_root_version: 3,
            block_merkle_root: null, block_merkle_version: 3
        }));
        assert.strictEqual(r.state_root, null);
        assert.strictEqual(r.state_root_version, null);
        assert.strictEqual(r.block_merkle_root, null);
        assert.strictEqual(r.block_merkle_version, null);
    });

    it('reports version null when the root is present but the stored version column is null (never NaN)', function () {
        let r = buildAnchorActionResponse(CONFIG, 200, anchorRow({
            state_root: 'e'.repeat(64), state_root_version: null,
            block_merkle_root: 'f'.repeat(64), block_merkle_version: undefined
        }));
        assert.strictEqual(r.state_root, 'e'.repeat(64));
        assert.strictEqual(r.state_root_version, null);
        assert.strictEqual(r.block_merkle_root, 'f'.repeat(64));
        assert.strictEqual(r.block_merkle_version, null);
    });
});

// ── txid / version narrowing (XANC-ELECTED-FORGE-1) ──────────────────────────
// Without these filters getanchoraction answers "this checkpoint is anchored",
// which an elected publisher satisfies while announcing a never-mined or
// real-but-different txid. These guard the filter that binds the announced tx.

const TXID_A = '1'.repeat(64);
const TXID_B = '2'.repeat(64);

describe('anchor-action-query: validateAnchorActionParams() txid/version', function () {
    const base = { chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 1 };

    it('defaults txid and version to null when omitted (filterless behavior)', function () {
        let v = validateAnchorActionParams(base);
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.txid, null);
        assert.strictEqual(v.version, null);
    });

    it('accepts and lowercases a 64-hex txid', function () {
        let v = validateAnchorActionParams(Object.assign({}, base, { txid: 'AB'.repeat(32) }));
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.txid, 'ab'.repeat(32));
    });

    it('rejects a malformed txid rather than silently ignoring the filter', function () {
        for (const bad of ['', 'zz'.repeat(32), 'ab'.repeat(31), 123, {}]) {
            if (bad === '') continue;   // empty string means "no filter"
            assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { txid: bad })).ok, false, String(bad));
        }
    });

    it('treats an empty-string txid/version as "no filter", not as a rejection', function () {
        let v = validateAnchorActionParams(Object.assign({}, base, { txid: '', version: '' }));
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.txid, null);
        assert.strictEqual(v.version, null);
    });

    it('accepts a checkpoint-bearing version and rejects v2 / unknown versions', function () {
        assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { version: 1 })).version, 1);
        assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { version: 7 })).version, 7);
        assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { version: 0 })).ok, false);
        assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { version: 2 })).ok, false);
        assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { version: 9 })).ok, false);
        assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { version: 1.5 })).ok, false);
    });
});

describe('anchor-action-query: selectAnchorRow()', function () {
    // action_index DESC, as ANCHOR_ACTIONS_SQL returns them.
    const rows = [
        anchorRow({ action_index: 90, version: 1, txid: TXID_B }),   // v1 archive anchor
        anchorRow({ action_index: 42, version: 0, txid: TXID_A })    // v0 checkpoint anchor
    ];

    it('with no filter returns the highest action_index (pre-filter behavior)', function () {
        assert.strictEqual(selectAnchorRow(rows, {}).action_index, 90);
        assert.strictEqual(selectAnchorRow(rows, null).action_index, 90);
    });

    it('narrows to the announced txid even when a newer anchor supersedes it', function () {
        assert.strictEqual(selectAnchorRow(rows, { txid: TXID_A }).action_index, 42);
    });

    it('matches a txid case-insensitively', function () {
        assert.strictEqual(selectAnchorRow(rows, { txid: TXID_A.toUpperCase() }).action_index, 42);
    });

    it('returns null for a never-mined (phantom) txid', function () {
        assert.strictEqual(selectAnchorRow(rows, { txid: 'f'.repeat(64) }), null);
    });

    it('narrows to a version, so the archive gate binds the v1 head', function () {
        assert.strictEqual(selectAnchorRow(rows, { version: 1 }).action_index, 90);
        assert.strictEqual(selectAnchorRow(rows, { version: 0 }).action_index, 42);
    });

    it('requires txid AND version to agree', function () {
        assert.strictEqual(selectAnchorRow(rows, { txid: TXID_A, version: 1 }), null);
        assert.strictEqual(selectAnchorRow(rows, { txid: TXID_A, version: 0 }).action_index, 42);
    });

    it('treats a row with a missing tx linkage (txid null) as unmatchable by txid', function () {
        assert.strictEqual(selectAnchorRow([anchorRow({ txid: null })], { txid: TXID_A }), null);
    });

    it('returns null on empty / non-array input', function () {
        assert.strictEqual(selectAnchorRow([], { txid: TXID_A }), null);
        assert.strictEqual(selectAnchorRow(undefined, {}), null);
    });
});

// ── A v7 section and a v6 archive head sharing ONE checkpoint key ───────────────
//
// The archive leg wraps the same checkpoint the bundle section anchors, so both rows
// carry the identical (chain, network, block_index, checkpoint_seq), and the archive
// head lands later, at the higher action_index. Reproduced on the DOGE
// regtest indexer: getanchoraction(BTC, regtest, 11237, 11243) with no version and no
// txid answered from the archive head, so a caller asking "is this checkpoint
// anchored" was handed a different transaction's txid and status and could not tell.
// The hub's own adopt path filters on version 7 and never saw it; every unfiltered
// reader (the SDK, the e2e harnesses, third parties) did.
describe('anchor-action-query: section vs co-located archive head', function () {
    const SECTION_TXID = '7'.repeat(64);
    const ARCHIVE_TXID = '6'.repeat(64);

    // The venue's own key and action indexes, in the pure action_index DESC order the
    // read used before the family term, which is what makes the archive head win.
    function colocated() {
        return [
            anchorRow({ action_index: 1305, version: 6, chain: 'BTC', block_index: 11237,
                        checkpoint_seq: 11243, txid: ARCHIVE_TXID }),
            anchorRow({ action_index: 1298, version: 7, chain: 'BTC', block_index: 11237,
                        checkpoint_seq: 11243, txid: SECTION_TXID })
        ];
    }

    it('unfiltered, returns the checkpoint SECTION, not the higher-action_index archive head', function () {
        let row = selectAnchorRow(colocated(), {});
        assert.strictEqual(Number(row.version), 7);
        assert.strictEqual(row.action_index, 1298);
        assert.strictEqual(row.txid, SECTION_TXID);
    });

    it('answers the same with no filter object at all', function () {
        assert.strictEqual(Number(selectAnchorRow(colocated(), null).version), 7);
        assert.strictEqual(Number(selectAnchorRow(colocated(), undefined).version), 7);
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
        assert.strictEqual(Number(row.version), 6);
        assert.strictEqual(row.action_index, 1305);
    });

    it('resolves the section by version 7 and by its own txid', function () {
        assert.strictEqual(selectAnchorRow(colocated(), { version: 7 }).action_index, 1298);
        assert.strictEqual(selectAnchorRow(colocated(), { txid: SECTION_TXID }).action_index, 1298);
    });

    it('leaves an archive-only key answering unfiltered (the archive leg is not broken)', function () {
        let archiveOnly = [colocated()[0]];
        let row = selectAnchorRow(archiveOnly, {});
        assert.strictEqual(Number(row.version), 6);
        assert.strictEqual(row.action_index, 1305);
    });

    it('keeps newest-wins WITHIN the section family (a reorg-replayed re-anchor supersedes)', function () {
        let rows = [
            anchorRow({ action_index: 1310, version: 6, checkpoint_seq: 11243, txid: ARCHIVE_TXID }),
            anchorRow({ action_index: 1301, version: 7, checkpoint_seq: 11243, txid: TXID_B }),
            anchorRow({ action_index: 1298, version: 7, checkpoint_seq: 11243, txid: SECTION_TXID })
        ];
        assert.strictEqual(selectAnchorRow(rows, {}).action_index, 1301);
    });

    it('partitions the served version set into exactly two families', function () {
        // Neither family may be empty, and together they must be the whole served set:
        // a version in CHECKPOINT_VERSIONS that is in neither would be silently
        // unrankable, which is the defect wearing a new version byte.
        assert.deepStrictEqual(CHECKPOINT_SECTION_VERSIONS, [7]);
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
        let src = require('fs').readFileSync(require.resolve('../../src/db.js'), 'utf8');
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
    const { ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL, ANCHOR_ROW_LIMIT,
            validateAnchorConfirmationsParams,
            buildAnchorConfirmationsResponse } = require('../../src/anchor-action-query');

    function txidRow(overrides) {
        return Object.assign({
            action_index: 9, version: 4, chain: 'BTC', network: 'regtest', block_index: 850000,
            checkpoint_seq: 7, snapshot_block: 950000, publisher: 'AA'.repeat(32),
            match_batch_seq: null, block_index_doge: 100, status: 'valid'
        }, overrides || {});
    }

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
                buildAnchorConfirmationsResponse(CONFIG, 200, [txidRow({ version: 0, publisher: null })]).anchors[0].publisher,
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
            let r = buildAnchorConfirmationsResponse(CONFIG, 200, [txidRow({ version: 6, match_batch_seq: 3 }), txidRow()]);
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
    });

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
