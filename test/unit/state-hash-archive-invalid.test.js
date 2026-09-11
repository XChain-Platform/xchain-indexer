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
 * anchor_invalid state_hash class (stateHash.js class 6), driven against REAL
 * anchor_actions rows in a real SQL engine.
 *
 * The class hashes invalid_archive stamps on archive-head parent rows, scoped to
 * the block the COMPLETING v2 chunk landed in. Two independent flag days gate it,
 * and this suite covers both:
 *
 *   VERSION SET. It once selected `p.version = 1` only, so a stamp on a v6
 *   (publisher-bearing, ARCHIVE_REWARD flag-day) parent was invisible to the
 *   follower's recompute: a dropped upsert diverged with no halt. Widened to the
 *   shared ARCHIVE_HEAD_VERSIONS set behind ARCHIVE_INVALID_STATE_HASH
 *   (armed from genesis on every network: testnet by the 2026-08-11 ruling,
 *   mainnet by the 2026-09-09 one, where the class is empty either way).
 *
 *   CHUNK-HEIGHT KEY. It scoped the completing chunk with `c.block_index`, a
 *   column NO v2 continuation row ever populates: `block_index` carries
 *   BLOCK_INDEX_CHECKPOINTED, assigned only in anchor.js `_parseCheckpoint`, and
 *   db.js binds it NULL when the key is absent. `NULL BETWEEN B AND B` is never
 *   true, so the class selected ZERO rows on every node from the day it landed.
 *   Repaired to `block_index_doge` behind ARCHIVE_INVALID_HEIGHT_KEY (mainnet and
 *   regtest armed from genesis, testnet at real future flag-day heights because a
 *   height of 0 on a chain that has already run would be retroactive).
 *
 * WHY THIS SUITE USES A REAL DATABASE. The predecessor stubbed `dbFor()` to hand
 * back fabricated rows for any SQL containing 'anchor_actions p', so the WHERE
 * clause was never executed and a projection that matched nothing anywhere in the
 * fleet passed green for its whole life. That is a pass-by-mock in a consensus
 * path, and no assertion over a stub can catch it. Every row-level test below
 * instead inserts real rows through the project's own src/sql DDL (node:sqlite,
 * see test/helpers/sqlAnchorDb.js) and lets the engine evaluate the join.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility');
const { makeAnchorDb } = require('../helpers/sqlAnchorDb');
const {
    buildStateHashData,
    ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL,
    ARCHIVE_INVALID_STATE_HASH_ACTIVATION, isArchiveInvalidStateHashActive,
    ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, isArchiveInvalidHeightKeyActive,
    ARCHIVE_CHUNK_HEIGHT_COL, ARCHIVE_CHUNK_HEIGHT_COL_LEGACY,
    POLL_FINALIZE_STATE_HASH_ACTIVATION, TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
    INDEX_MAP_STATE_HASH_ACTIVATION, BET_STATUS_STATE_HASH_ACTIVATION,
} = require('../../src/stateHash');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];

// The block every test hashes at, and the DOGE height the completing chunk lands in.
const B = 7;

// Seed a REAL chunked archive batch whose reassembly failed CRC: an archive head
// stamped 'invalid_archive' in an earlier block, and its completing v2 chunk landing
// at block B. `headVersion` picks v1 (legacy) or v6 (publisher-bearing).
// block_index is deliberately LEFT UNSET on the chunk, which is exactly what
// anchor.js `_parseContinuation` + db.js `createAnchorAction` produce in production.
function seedFailedBatch(db, { headVersion = 1, batchSeq = 7, headActionIndex = 100, chunkActionIndex = 301 } = {}){
    const validId   = db.status('valid');
    const invalidId = db.status('invalid_archive');
    db.anchor({
        action_index: headActionIndex, version: headVersion, chain: 'BTC', network: 'regtest',
        block_index: 5000,              // the CHECKPOINTED height on BTC, not a DOGE height
        match_batch_seq: batchSeq, match_count: 3, batch_crc32: 'deadbeef', total_chunks: 2,
        status_id: invalidId, block_index_doge: B - 3,
    });
    db.anchor({
        action_index: chunkActionIndex, version: 2,
        match_batch_seq: batchSeq, chunk_index: 1, total_chunks: 2, archive_b64: 'AAAA',
        status_id: validId, block_index_doge: B,
    });
    return { headActionIndex, chunkActionIndex };
}

// The db helper collects the issued SQL itself, so callers that want the predicate
// text pass their array to makeAnchorDb() rather than to this.
async function build(db){
    const data = await buildStateHashData(db, B,
        { activationDelay: null, gasTick: 'XCHAIN', network: 'regtest', coin: 'BTC' });
    return { data, hash: util.getDataHash(data) };
}

// Temporarily set a regtest gate height around a body, always restoring it.
async function withHeight(map, height, fn){
    const prev = map.regtest;
    map.regtest = height;
    try { return await fn(); } finally { map.regtest = prev; }
}

function anchorSqlOf(captured){
    return captured.find(sql => sql.indexOf('anchor_actions p') !== -1);
}

describe('state_hash anchor_invalid class: archive-head coverage and chunk-height key @regression', function(){

    // Isolate this suite from the other regtest-armed classes (their keys/query
    // slots would shift the expected key set); always restored.
    let pollPrev, tokenPrev, indexPrev, betPrev;
    before(function(){
        pollPrev  = POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest;  POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest  = 999999999;
        tokenPrev = TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest;   TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest   = 999999999;
        indexPrev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;      INDEX_MAP_STATE_HASH_ACTIVATION.regtest      = 999999999;
        betPrev   = BET_STATUS_STATE_HASH_ACTIVATION.regtest;     BET_STATUS_STATE_HASH_ACTIVATION.regtest     = 999999999;
    });
    after(function(){
        POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest  = pollPrev;
        TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest   = tokenPrev;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest      = indexPrev;
        BET_STATUS_STATE_HASH_ACTIVATION.regtest     = betPrev;
    });

    it('shared constant: ARCHIVE_HEAD_VERSIONS is [1] and renders IN (1)', function(){
        assert.deepStrictEqual(ARCHIVE_HEAD_VERSIONS, [1]);
        assert.strictEqual(ARCHIVE_HEAD_VERSIONS_SQL, 'IN (1)');
    });

    it('shared constant: the chunk-height key is c.block_index_doge, the legacy key c.block_index', function(){
        assert.strictEqual(ARCHIVE_CHUNK_HEIGHT_COL, 'c.block_index_doge');
        assert.strictEqual(ARCHIVE_CHUNK_HEIGHT_COL_LEGACY, 'c.block_index');
    });

    it('version gate: regtest, every testnet chain AND every mainnet chain armed from genesis; fail-inert paths', function(){
        assert.strictEqual(isArchiveInvalidStateHashActive(0, 'regtest'), true, 'regtest armed at 0');
        for(const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet']){
            const h = ARCHIVE_INVALID_STATE_HASH_ACTIVATION[key];
            assert.ok(Number.isFinite(h), `${key} must carry a numeric height`);
        }
        // Testnet armed at genesis on ALL THREE chains by the 2026-08-11 operator ruling.
        // Per-chain, because the widened class is keyed on the chain's own local height:
        // one chain left inert would recompute a different preimage from its siblings.
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            assert.strictEqual(ARCHIVE_INVALID_STATE_HASH_ACTIVATION[`${coin}:testnet`], 0,
                `${coin}:testnet must be armed at genesis`);
            assert.strictEqual(isArchiveInvalidStateHashActive(0, 'testnet', coin), true,
                `${coin}:testnet active at block 0`);
            // Still fails closed on an armed key: NaN must never read as ">= 0".
            assert.strictEqual(isArchiveInvalidStateHashActive('not-a-number', 'testnet', coin), false);
        }
        // Mainnet armed at genesis by the 2026-09-09 ruling. Mainnet holds 0 archive chunks
        // (measured 2026-09-09), so the widened predicate and the legacy v1-only one select
        // the same empty class and arming from genesis leaves the deployed preimage alone.
        // The from-genesis replay witness is the proof; the same NaN/unknown-network
        // fail-inert paths must survive the arming.
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            assert.strictEqual(ARCHIVE_INVALID_STATE_HASH_ACTIVATION[`${coin}:mainnet`], 0,
                `${coin}:mainnet must be armed at genesis`);
            assert.strictEqual(isArchiveInvalidStateHashActive(0, 'mainnet', coin), true,
                `${coin}:mainnet active at block 0`);
            assert.strictEqual(isArchiveInvalidStateHashActive(1, 'mainnet', coin), true,
                `${coin}:mainnet stays on above genesis`);
            assert.strictEqual(isArchiveInvalidStateHashActive('not-a-number', 'mainnet', coin), false,
                `${coin}:mainnet must still fail closed on an unparseable height`);
        }
        assert.strictEqual(isArchiveInvalidStateHashActive(999999999, 'mainnet'), false, 'coin-less mainnet lookup stays inert');
        assert.strictEqual(isArchiveInvalidStateHashActive(7, 'nonexistent', 'BTC'), false, 'unknown network -> off (safe)');
        assert.strictEqual(isArchiveInvalidStateHashActive(7, null, 'BTC'), false);
        assert.strictEqual(isArchiveInvalidStateHashActive('not-a-number', 'regtest'), false);
    });

    it('height-key gate: regtest and mainnet armed at genesis, testnet at real future flag days; fail-inert paths', function(){
        assert.strictEqual(ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION.regtest, 0, 'regtest armed at 0');
        assert.strictEqual(isArchiveInvalidHeightKeyActive(0, 'regtest'), true);
        // Mainnet armed at genesis by the 2026-09-09 ruling: the repair only moves the
        // preimage where a stamped archive batch exists, and mainnet holds 0 archive chunks
        // (measured 2026-09-09), so repaired and broken keys select the same empty class.
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            assert.strictEqual(ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION[`${coin}:mainnet`], 0,
                `${coin}:mainnet must be armed at genesis`);
            assert.strictEqual(isArchiveInvalidHeightKeyActive(0, 'mainnet', coin), true,
                `${coin}:mainnet active at block 0`);
            assert.strictEqual(isArchiveInvalidHeightKeyActive('not-a-number', 'mainnet', coin), false,
                `${coin}:mainnet must still fail closed on an unparseable height`);
        }
        // Testnet does NOT arm at 0: it is a public chain that has run since the 2026-08-10
        // re-genesis, so a height of 0 here would be retroactive rather than a flag day.
        // The heights are sized above the 2026-09-09 tips (TBTC 151701, TLTC 4883295,
        // TDOGE 67881714) so the v0.17.0 train is deployed before the earliest chain crosses.
        const TESTNET = { BTC: 155000, LTC: 4896000, DOGE: 67915000 };
        const TIPS_2026_09_09 = { BTC: 151701, LTC: 4883295, DOGE: 67881714 };
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const key = `${coin}:testnet`;
            const h = ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION[key];
            assert.strictEqual(h, TESTNET[coin], `${key} must carry its ruled flag-day height`);
            assert.ok(h > TIPS_2026_09_09[coin],
                `${key} must sit above the tip it was sized from, or the flag day is retroactive`);
            assert.strictEqual(isArchiveInvalidHeightKeyActive(0, 'testnet', coin), false,
                `${key} must not be retroactively armed at genesis`);
            assert.strictEqual(isArchiveInvalidHeightKeyActive(h - 1, 'testnet', coin), false, `${key} below threshold`);
            assert.strictEqual(isArchiveInvalidHeightKeyActive(h, 'testnet', coin), true, `${key} at threshold`);
            assert.strictEqual(isArchiveInvalidHeightKeyActive(h + 1, 'testnet', coin), true, `${key} above threshold`);
        }
        assert.strictEqual(isArchiveInvalidHeightKeyActive(999999999, 'mainnet'), false, 'coin-less mainnet lookup stays inert');
        assert.strictEqual(isArchiveInvalidHeightKeyActive(999999999, 'testnet'), false, 'coin-less testnet lookup stays inert');
        assert.strictEqual(isArchiveInvalidHeightKeyActive(7, 'nonexistent', 'DOGE'), false, 'unknown network -> off (safe)');
        assert.strictEqual(isArchiveInvalidHeightKeyActive(7, null, 'DOGE'), false);
        assert.strictEqual(isArchiveInvalidHeightKeyActive('not-a-number', 'regtest'), false, 'NaN must never read as ">= 0"');
    });

    it('the schema premise, checked against the real DDL: a v2 chunk row carries NULL block_index and a real block_index_doge', function(){
        const db = makeAnchorDb();
        try {
            seedFailedBatch(db);
            const chunk = db.db.prepare('SELECT block_index, block_index_doge FROM anchor_actions WHERE version = 2').get();
            assert.strictEqual(chunk.block_index, null,
                'a v2 continuation row must have NULL block_index; if this ever becomes non-null the class-6 preimage moves fleet-wide');
            assert.strictEqual(chunk.block_index_doge, B,
                'block_index_doge is the height the completing chunk landed at and is NOT NULL by schema');
        } finally { db.close(); }
    });

    it('below the version threshold: the class keeps the legacy v1-only predicate (preimage byte-identical pre-flag)', async function(){
        await withHeight(ARCHIVE_INVALID_STATE_HASH_ACTIVATION, 999999999, async () => {
            const captured = [];
            const db = makeAnchorDb(captured);
            try {
                const { data } = await build(db);
                const sql = anchorSqlOf(captured);
                assert.ok(sql, 'anchor_invalid class query must always run');
                assert.ok(/p\.version = 1 /.test(sql), 'below the flag-day the predicate stays p.version = 1');
                assert.ok(sql.indexOf(ARCHIVE_HEAD_VERSIONS_SQL) === -1, 'the widened set must NOT leak below the flag-day');
                assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS, 'key set unchanged (class always present)');
            } finally { db.close(); }
        });
    });

    it('at/after the version threshold: the class selects the shared archive-head set, key set unchanged', async function(){
        await withHeight(ARCHIVE_INVALID_STATE_HASH_ACTIVATION, 0, async () => {
            const captured = [];
            const db = makeAnchorDb(captured);
            try {
                const { data } = await build(db);
                const sql = anchorSqlOf(captured);
                assert.ok(sql.indexOf('p.version ' + ARCHIVE_HEAD_VERSIONS_SQL) !== -1,
                    'the active predicate must be spliced from ARCHIVE_HEAD_VERSIONS, or an invalid_archive stamp on a future archive head stays invisible to the integrity hash');
                assert.ok(!/p\.version = 1 /.test(sql), 'the hard-coded v1-only predicate must be gone when active');
                assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS,
                    'widening changes row selection only, never the preimage key set');
            } finally { db.close(); }
        });
    });

    // The defect itself, executed rather than mocked: a genuinely stamped batch,
    // a genuinely completing chunk at block B, and the legacy key still matches
    // nothing. This is the assertion the stubbed predecessor could never make.
    it('height key INERT: a real stamped batch selects ZERO rows, because c.block_index is NULL on the chunk', async function(){
        await withHeight(ARCHIVE_INVALID_STATE_HASH_ACTIVATION, 0, async () => {
            await withHeight(ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, 999999999, async () => {
                const captured = [];
                const db = makeAnchorDb(captured);
                try {
                    seedFailedBatch(db);
                    const { data } = await build(db);
                    const sql = anchorSqlOf(captured);
                    assert.ok(sql.indexOf(' ' + ARCHIVE_CHUNK_HEIGHT_COL_LEGACY + ' BETWEEN') !== -1,
                        'below the flag-day the class must keep the legacy c.block_index key (preimage byte-identical)');
                    assert.deepStrictEqual(data.anchor_invalid, [],
                        'the legacy key compares NULL, so the class matches nothing even with a stamped parent present');
                } finally { db.close(); }
            });
        });
    });

    it('height key ARMED: the same real rows now yield the stamped parent, ordered by action_index', async function(){
        await withHeight(ARCHIVE_INVALID_STATE_HASH_ACTIVATION, 0, async () => {
            await withHeight(ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, 0, async () => {
                const captured = [];
                const db = makeAnchorDb(captured);
                try {
                    seedFailedBatch(db, { headVersion: 1, headActionIndex: 100 });
                    seedFailedBatch(db, { headVersion: 1, batchSeq: 8, headActionIndex: 90, chunkActionIndex: 302 });
                    const { data } = await build(db);
                    const sql = anchorSqlOf(captured);
                    assert.ok(sql.indexOf(' ' + ARCHIVE_CHUNK_HEIGHT_COL + ' BETWEEN') !== -1,
                        'the armed class must scope the completing chunk by block_index_doge');
                    assert.ok(sql.indexOf(' ' + ARCHIVE_CHUNK_HEIGHT_COL_LEGACY + ' BETWEEN') === -1,
                        'the never-populated legacy key must be gone when armed');
                    assert.deepStrictEqual(data.anchor_invalid,
                        [{ action_index: 90, status: 'invalid_archive' }, { action_index: 100, status: 'invalid_archive' }],
                        'every stamped archive head in the block is selected, in action_index order');
                } finally { db.close(); }
            });
        });
    });

    it('height key ARMED: a completing chunk in ANOTHER block is out of scope (the class stays per-block)', async function(){
        await withHeight(ARCHIVE_INVALID_STATE_HASH_ACTIVATION, 0, async () => {
            await withHeight(ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, 0, async () => {
                const db = makeAnchorDb();
                try {
                    const validId   = db.status('valid');
                    const invalidId = db.status('invalid_archive');
                    db.anchor({ action_index: 100, version: 1, match_batch_seq: 7, total_chunks: 2,
                                status_id: invalidId, block_index_doge: B - 3 });
                    db.anchor({ action_index: 301, version: 2, match_batch_seq: 7, chunk_index: 1, total_chunks: 2,
                                status_id: validId, block_index_doge: B + 1 });   // lands in the NEXT block
                    const { data } = await build(db);
                    assert.deepStrictEqual(data.anchor_invalid, [],
                        'a chunk outside block B must not fold the stamp into B, or the stamp is hashed at two heights');
                } finally { db.close(); }
            });
        });
    });

    it('height key ARMED: a non-valid completing chunk does not stamp (rejected duplicate stays out of scope)', async function(){
        await withHeight(ARCHIVE_INVALID_STATE_HASH_ACTIVATION, 0, async () => {
            await withHeight(ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, 0, async () => {
                const db = makeAnchorDb();
                try {
                    const invalidId = db.status('invalid_archive');
                    const dupeId    = db.status('invalid: CHUNK_INDEX (duplicate)');
                    db.anchor({ action_index: 100, version: 1, match_batch_seq: 7, total_chunks: 2,
                                status_id: invalidId, block_index_doge: B - 3 });
                    db.anchor({ action_index: 301, version: 2, match_batch_seq: 7, chunk_index: 1, total_chunks: 2,
                                status_id: dupeId, block_index_doge: B });
                    const { data } = await build(db);
                    assert.deepStrictEqual(data.anchor_invalid, [],
                        'only a valid completing chunk scopes the stamp; a rejected duplicate must not');
                } finally { db.close(); }
            });
        });
    });

    it('active: a real stamped parent folds into state_hash; a follower that drops it HALTS (different hash)', async function(){
        await withHeight(ARCHIVE_INVALID_STATE_HASH_ACTIVATION, 0, async () => {
            await withHeight(ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, 0, async () => {
                const stamped = makeAnchorDb();
                const dropped = makeAnchorDb();
                const again   = makeAnchorDb();
                try {
                    seedFailedBatch(stamped, { headVersion: 1 });
                    seedFailedBatch(again,   { headVersion: 1 });
                    // The follower that silently dropped the invalid_archive upsert: same
                    // batch, same completing chunk, parent still on its pre-stamp status.
                    const validId = dropped.status('valid');
                    dropped.status('invalid_archive');
                    const unverifiedId = dropped.status('unverified');
                    dropped.anchor({ action_index: 100, version: 1, match_batch_seq: 7, total_chunks: 2,
                                     status_id: unverifiedId, block_index_doge: B - 3 });
                    dropped.anchor({ action_index: 301, version: 2, match_batch_seq: 7, chunk_index: 1, total_chunks: 2,
                                     status_id: validId, block_index_doge: B });

                    const s  = await build(stamped);
                    const d  = await build(dropped);
                    const s2 = await build(again);
                    assert.strictEqual(s.data.anchor_invalid[0].action_index, 100);
                    assert.deepStrictEqual(d.data.anchor_invalid, []);
                    assert.notStrictEqual(d.hash, s.hash,
                        'a dropped invalid_archive upsert MUST change state_hash so the follower halts');
                    assert.strictEqual(s2.hash, s.hash, 'identical stamps hash identically (no false halt)');
                } finally { stamped.close(); dropped.close(); again.close(); }
            });
        });
    });
});
