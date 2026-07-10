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
const { CHECKPOINT_VERSIONS, validateAnchorActionParams, buildAnchorActionResponse } =
    require('../../src/anchor-action-query');

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
        assert.deepStrictEqual(CHECKPOINT_VERSIONS, [0, 1, 3, 4, 5]);
        assert.ok(!CHECKPOINT_VERSIONS.includes(2), 'v2 (archive continuation) is not a checkpoint');
    });
});

describe('anchor-action-query: validateAnchorActionParams()', function () {
    it('accepts a well-formed request and coerces numeric strings to integers', function () {
        let v = validateAnchorActionParams({ chain: 'BTC', network: 'regtest', block_index: '850000', checkpoint_seq: '7' });
        assert.deepStrictEqual(v, { ok: true, block_index: 850000, checkpoint_seq: 7 });
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
        assert.deepStrictEqual(r, { coin: 'DOGE', network: 'regtest', exists: false, latest_block_index: 159, confirmations: 0 });
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
