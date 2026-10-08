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
 *
 * The state_hash attest_batch_head class: the in-place verdict stamp that
 * setAttestBatchStatus writes on a surviving v5 batch head when the completing
 * v6 continuation fails reassembly or quorum. Asserts (a) the per-network gate,
 * (b) an inert block keeps the pre-feature preimage and issues no query,
 * (c) an active block folds the stamped heads in last before block_index, so a
 * follower that dropped the stamp hashes differently and halts, and (d) the
 * literal twins of the wire constants equal the canonical values.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../../../src/utility');
const {
    buildStateHashData, isAttestBatchHeadStateHashActive, ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION,
    POLL_FINALIZE_STATE_HASH_ACTIVATION, INDEX_MAP_STATE_HASH_ACTIVATION,
    BET_STATUS_STATE_HASH_ACTIVATION, TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
} = require('../../../../src/consensus/state_hash');
const G   = require('../../../../src/consensus/state_hash/gated_sections');
const abw = require('../../../../src/actions/attest/attest_batch_wire.js');
const { ATTEST_BATCH_COMPLETION_STAMP } = require('../../../../src/actions/attest/constants.js');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];
const STAMPED = 'invalid: ATTEST_BATCH (reassembly CRC mismatch)' + ATTEST_BATCH_COMPLETION_STAMP;

function dbFor(results, calls){
    let i = 0;
    return {
        doQuery: async (sql, args) => { if(calls) calls.push({ sql, args }); return results[i++]; },
        getStatusId: async () => null,
    };
}

// activationDelay null and a null completed id skip the deactivation and credits
// queries: slashes x4, request_status x2, cooldown x2, anchor_invalid x1 = 9 slots.
function baseResults(){ return [[], [], [], [], [], [], [], [], []]; }

async function build(results, calls){
    const data = await buildStateHashData(dbFor(results || baseResults(), calls), 7,
        { activationDelay: null, gasTick: 'XCHAIN', network: 'regtest', coin: 'BTC' });
    return { data, hash: util.getDataHash(data) };
}

describe('state_hash attest_batch_head class @regression', function(){
    const maps = { poll: POLL_FINALIZE_STATE_HASH_ACTIVATION, index: INDEX_MAP_STATE_HASH_ACTIVATION,
                   bet: BET_STATUS_STATE_HASH_ACTIVATION, token: TOKEN_SUPPLY_STATE_HASH_ACTIVATION };
    let prev;
    before(function(){
        prev = {};
        for(const k of Object.keys(maps)){ prev[k] = maps[k].regtest; maps[k].regtest = 999999999; }
    });
    after(function(){
        for(const k of Object.keys(maps)) maps[k].regtest = prev[k];
    });

    it('gate: regtest armed from genesis, mainnet and testnet inert, unknown network off', function(){
        assert.strictEqual(isAttestBatchHeadStateHashActive(1, 'regtest', 'DOGE'), true);
        assert.strictEqual(isAttestBatchHeadStateHashActive(999999999, 'mainnet', 'DOGE'), false);
        assert.strictEqual(isAttestBatchHeadStateHashActive(999999999, 'testnet', 'DOGE'), false);
        assert.strictEqual(isAttestBatchHeadStateHashActive(999999999, 'mainnet', null), false);
        assert.strictEqual(isAttestBatchHeadStateHashActive(7, 'nonexistent', 'BTC'), false);
        assert.strictEqual(isAttestBatchHeadStateHashActive('x', 'regtest', 'BTC'), false);
    });

    it('below threshold: no attest_batch_head key and no extra query', async function(){
        const prevH = ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION.regtest;
        ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION.regtest = 999999999;
        try {
            const calls = [];
            const { data } = await build(null, calls);
            assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS);
            assert.strictEqual(calls.length, 9);
        } finally { ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION.regtest = prevH; }
    });

    it('active: stamped heads fold in before block_index and a dropped stamp changes the hash', async function(){
        const source = baseResults().concat([[{ action_index: 100, status: STAMPED }]]);
        const stale  = baseResults().concat([[]]);
        const calls  = [];
        const s = await build(source, calls);
        assert.deepStrictEqual(Object.keys(s.data),
            ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid',
             'attest_batch_head', 'block_index', 'state_hash_version']);
        assert.deepStrictEqual(s.data.attest_batch_head, [{ action_index: 100, status: STAMPED }]);
        assert.strictEqual(calls.length, 10);
        assert.deepStrictEqual(calls[9].args,
            ['%' + ATTEST_BATCH_COMPLETION_STAMP, abw.ATTEST_BATCH_HEAD_VERSION, abw.ATTEST_BATCH_CONTINUATION_VERSION, 7]);
        const st = await build(stale);
        assert.notStrictEqual(st.hash, s.hash, 'a follower that dropped the stamp must diverge');
        const same = await build(baseResults().concat([[{ action_index: 100, status: STAMPED }]]));
        assert.strictEqual(same.hash, s.hash);
    });

    it('selection: stamped v5 head keyed by the completing chunk block, resolved status, total order', async function(){
        const calls = [];
        await G.collectAttestBatchHead(dbFor([[]], calls), 7);
        const sql = calls[0].sql;
        assert.match(sql, /s\.status LIKE \?/);
        assert.match(sql, /p\.version = \? AND p\.batch_chunk_index = 0/);
        assert.match(sql, /ca\.source_id = pa\.source_id/);
        assert.match(sql, /cs\.status = 'valid'/);
        assert.match(sql, /\) = \? ORDER BY p\.action_index ASC$/);
        assert.doesNotMatch(sql, /status_id,|p\.status_id AS/);
    });

    it('literal twins equal the canonical wire constants', function(){
        assert.strictEqual(G.ATTEST_BATCH_HEAD_VERSION, abw.ATTEST_BATCH_HEAD_VERSION);
        assert.strictEqual(G.ATTEST_BATCH_CONTINUATION_VERSION, abw.ATTEST_BATCH_CONTINUATION_VERSION);
        assert.strictEqual(G.ATTEST_BATCH_COMPLETION_STAMP, ATTEST_BATCH_COMPLETION_STAMP);
        assert.strictEqual(/[%_]/.test(ATTEST_BATCH_COMPLETION_STAMP), false);
    });
});
