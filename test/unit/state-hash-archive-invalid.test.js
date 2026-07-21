/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * anchor_invalid state_hash class: archive-head v6 coverage (, gated).
 *
 * The anchor_invalid class hashes invalid_archive stamps on archive-head
 * parent rows. Pre-fix it selected `p.version = 1` only, so a stamp on a v6
 * (publisher-bearing, ARCHIVE_REWARD flag-day) parent was invisible to the
 * follower's recompute: a dropped upsert diverged with no halt. The fix
 * widens the predicate to the shared ARCHIVE_HEAD_VERSIONS set, gated on
 * the ARCHIVE_INVALID_STATE_HASH activation (default INERT on mainnet/
 * testnet; regtest armed from genesis) so the pre-flag preimage stays
 * byte-identical. Asserts: (a) the shared constant's value and SQL shape;
 * (b) the gate function's per-chain lookup and fail-inert paths; (c) the
 * class's SQL keeps the legacy v1-only predicate below the threshold and
 * uses IN (1, 6) at/after it, with the preimage KEY SET unchanged either
 * way (the class is always present; only row selection widens); (d) when
 * active, a v6 stamp row changes state_hash (follower halts on a drop).
 * No DB needed: buildStateHashData is driven with a SQL-capturing mock.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility');
const {
    buildStateHashData,
    ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL,
    ARCHIVE_INVALID_STATE_HASH_ACTIVATION, isArchiveInvalidStateHashActive,
    POLL_FINALIZE_STATE_HASH_ACTIVATION, TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
    INDEX_MAP_STATE_HASH_ACTIVATION,
} = require('../../src/stateHash');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];

// db whose doQuery captures every SQL string and answers from a matcher:
// the anchor_actions self-join query returns `anchorRows`, everything else [].
function dbFor(anchorRows, captured){
    return {
        doQuery: async (sql) => {
            captured.push(sql);
            if(sql.indexOf('anchor_actions p') !== -1) return anchorRows;
            return [];
        },
        getStatusId: async () => null,
    };
}

async function build(anchorRows, captured){
    const data = await buildStateHashData(dbFor(anchorRows, captured || []), 7,
        { activationDelay: null, gasTick: 'XCHAIN', network: 'regtest', coin: 'BTC' });
    return { data, hash: util.getDataHash(data) };
}

// Temporarily set the regtest archive-invalid gate around a body, always restoring it.
async function withRegtestHeight(height, fn){
    const prev = ARCHIVE_INVALID_STATE_HASH_ACTIVATION.regtest;
    ARCHIVE_INVALID_STATE_HASH_ACTIVATION.regtest = height;
    try { return await fn(); } finally { ARCHIVE_INVALID_STATE_HASH_ACTIVATION.regtest = prev; }
}

function anchorSqlOf(captured){
    return captured.find(sql => sql.indexOf('anchor_actions p') !== -1);
}

describe('state_hash anchor_invalid class: archive-head v6 coverage  @regression', function(){

    // Isolate this suite from the other regtest-armed classes (their keys/query
    // slots would shift the expected key set); always restored.
    let pollPrev, tokenPrev, indexPrev;
    before(function(){
        pollPrev  = POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest;  POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest  = 999999999;
        tokenPrev = TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest;   TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest   = 999999999;
        indexPrev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;      INDEX_MAP_STATE_HASH_ACTIVATION.regtest      = 999999999;
    });
    after(function(){
        POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest  = pollPrev;
        TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest   = tokenPrev;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest      = indexPrev;
    });

    it('shared constant: ARCHIVE_HEAD_VERSIONS is [1, 6] and renders IN (1, 6)', function(){
        assert.deepStrictEqual(ARCHIVE_HEAD_VERSIONS, [1, 6]);
        assert.strictEqual(ARCHIVE_HEAD_VERSIONS_SQL, 'IN (1, 6)');
    });

    it('gate: regtest armed from genesis; mainnet/testnet keys present but INERT placeholders pending ; fail-inert paths', function(){
        assert.strictEqual(isArchiveInvalidStateHashActive(0, 'regtest'), true, 'regtest armed at 0');
        for(const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet']){
            const h = ARCHIVE_INVALID_STATE_HASH_ACTIVATION[key];
            assert.ok(Number.isFinite(h), `${key} must carry a numeric height`);
        }
        const h = ARCHIVE_INVALID_STATE_HASH_ACTIVATION['BTC:mainnet'];
        assert.strictEqual(isArchiveInvalidStateHashActive(h - 1, 'mainnet', 'BTC'), false, 'below threshold');
        assert.strictEqual(isArchiveInvalidStateHashActive(h, 'mainnet', 'BTC'), true, 'at threshold');
        assert.strictEqual(isArchiveInvalidStateHashActive(h + 1, 'mainnet'), false, 'coin-less mainnet lookup stays inert');
        assert.strictEqual(isArchiveInvalidStateHashActive(7, 'nonexistent', 'BTC'), false, 'unknown network -> off (safe)');
        assert.strictEqual(isArchiveInvalidStateHashActive(7, null, 'BTC'), false);
        assert.strictEqual(isArchiveInvalidStateHashActive('not-a-number', 'regtest'), false);
    });

    it('below threshold: the class keeps the legacy v1-only predicate (preimage byte-identical pre-flag)', async function(){
        await withRegtestHeight(999999999, async () => {
            const captured = [];
            const { data } = await build([], captured);
            const sql = anchorSqlOf(captured);
            assert.ok(sql, 'anchor_invalid class query must always run');
            assert.ok(/p\.version = 1 /.test(sql), 'below the flag-day the predicate stays p.version = 1');
            assert.ok(sql.indexOf(ARCHIVE_HEAD_VERSIONS_SQL) === -1, 'the widened set must NOT leak below the flag-day');
            assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS, 'key set unchanged (class always present)');
        });
    });

    it('at/after threshold: the class selects the full archive-head set IN (1, 6), key set unchanged', async function(){
        await withRegtestHeight(0, async () => {
            const captured = [];
            const { data } = await build([], captured);
            const sql = anchorSqlOf(captured);
            assert.ok(sql.indexOf('p.version ' + ARCHIVE_HEAD_VERSIONS_SQL) !== -1,
                'active predicate must be p.version IN (1, 6), or a v6 invalid_archive stamp stays invisible to the integrity hash');
            assert.ok(!/p\.version = 1 /.test(sql), 'the v1-only predicate must be gone when active');
            assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS,
                'widening changes row selection only, never the preimage key set');
        });
    });

    it('active: a stamped v6 parent folds into state_hash; a follower that drops it HALTS (different hash)', async function(){
        await withRegtestHeight(0, async () => {
            const stamped = [{ action_index: 301, status: 'invalid_archive' }];
            const s = await build(stamped);
            const d = await build([]);
            assert.strictEqual(s.data.anchor_invalid[0].action_index, 301);
            assert.notStrictEqual(d.hash, s.hash,
                'a dropped invalid_archive upsert MUST change state_hash so the follower halts');
            const s2 = await build(stamped);
            assert.strictEqual(s2.hash, s.hash, 'identical stamps hash identically (no false halt)');
        });
    });
});
