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
 * test/unit/anchor/anchor_action_query.test.js
 *
 * Unit coverage for the getanchoraction RPC's pure logic (api.js delegates to it;
 * startApi is not importable). Guards the request validation and the row -> response
 * mapping, especially the DOGE confirmation-depth math the hub gates on (an off-by-one
 * or a negative depth silently trusted would defeat the anchor verification).
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { concatSrcTreeFiles } = require('../../helpers/src_tree_files');
// The Database class is a directory of per-family mixins under src/db/, so a source
// scan over it concatenates every file in a fixed order instead of reading one path.
function dbSource(){
    const dir = path.join(__dirname, '..', '..', '..', 'src', 'db');
    return concatSrcTreeFiles(dir);
}

const { CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, ANCHOR_ACTIONS_SQL,
        validateAnchorActionParams, selectAnchorRow,
        buildAnchorActionResponse } = require('../../../src/actions/anchor/anchor_action_query');
const { ARCHIVE_HEAD_VERSIONS } = require('../../../src/consensus/state_hash.js');

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

// ── txid / version narrowing (elected-publisher forgery) ──────────────────────────
// Without these filters getanchoraction answers "this checkpoint is anchored",
// which an elected publisher satisfies while announcing a never-mined or
// real-but-different txid. These guard the filter that binds the announced tx.

const TXID_A = '1'.repeat(64);
const TXID_B = '2'.repeat(64);

const SECTION_TXID = '7'.repeat(64);   // the bundle section's transaction
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
}

describe('anchor-action-query: CHECKPOINT_VERSIONS', function () {
    it('is exactly the checkpoint-bearing versions (v2 continuation excluded)', function () {
        // 0 is the bundle SECTION, which carries a full checkpoint identity of its own;
        // 1 is the archive head, which carries its wrapper checkpoint's. Every pre-restart
        // version is OUT: nothing parses them any more, and admitting one would let a
        // pre-restart row keep raising the replay watermark that
        // getMaxAnchorCheckpointSeq reads off this same set.
        assert.deepStrictEqual(CHECKPOINT_VERSIONS, [0, 1]);
        assert.ok(!CHECKPOINT_VERSIONS.includes(2), 'v2 (archive continuation) is not a checkpoint');
        for (const retired of [3, 4, 5, 6, 7])
            assert.ok(!CHECKPOINT_VERSIONS.includes(retired),
                'ANCHOR v' + retired + ' is pre-restart and must not re-enter the checkpoint set');
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
});

describe('anchor-action-query: buildAnchorActionResponse()', function () {
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
        assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { version: 0 })).version, 0);
        assert.strictEqual(validateAnchorActionParams(Object.assign({}, base, { version: 7 })).ok, false);
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

    it('with no filter ranks the section family first, then the highest action_index', function () {
        // Both rows are now live versions: v0 is the bundle SECTION and v1 the archive
        // head that wraps the same checkpoint, so FAMILY ranks ahead of recency and the
        // unfiltered answer is the section even though the archive head lands later.
        assert.strictEqual(selectAnchorRow(rows, {}).action_index, 42);
        assert.strictEqual(selectAnchorRow(rows, null).action_index, 42);
        // Within ONE family recency still governs.
        let sameFamily = [anchorRow({ action_index: 91, version: 1, txid: TXID_B }),
                          anchorRow({ action_index: 90, version: 1, txid: TXID_A })];
        assert.strictEqual(selectAnchorRow(sameFamily, {}).action_index, 91);
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