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
 * test/unit/state_commitment/state_hash_archive_invalid.test/state_hash_anchor_invalid_class.test.js
 *
 * Sibling block of the state_hash_archive_invalid.test.js suite, carrying:
 *   state_hash anchor_invalid class: archive-head coverage and chunk-height key @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../../../src/utility');
const { makeAnchorDb } = require('../../../helpers/sqlAnchorDb');
const {
    buildStateHashData,
    ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL,
    ARCHIVE_INVALID_STATE_HASH_ACTIVATION, isArchiveInvalidStateHashActive,
    ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, isArchiveInvalidHeightKeyActive,
    ARCHIVE_CHUNK_HEIGHT_COL, ARCHIVE_CHUNK_HEIGHT_COL_LEGACY,
    POLL_FINALIZE_STATE_HASH_ACTIVATION, TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
    INDEX_MAP_STATE_HASH_ACTIVATION, BET_STATUS_STATE_HASH_ACTIVATION,
} = require('../../../../src/consensus/state_hash');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];


const B = 7;






function seedFailedBatch(db, { headVersion = 1, batchSeq = 7, headActionIndex = 100, chunkActionIndex = 301 } = {}){
    const validId   = db.status('valid');
    const invalidId = db.status('invalid_archive');
    db.anchor({
        action_index: headActionIndex, version: headVersion, chain: 'BTC', network: 'regtest',
        block_index: 5000,
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



async function build(db){
    const data = await buildStateHashData(db, B,
        { activationDelay: null, gasTick: 'XCHAIN', network: 'regtest', coin: 'BTC' });
    return { data, hash: util.getDataHash(data) };
}


async function withHeight(map, height, fn){
    const prev = map.regtest;
    map.regtest = height;
    try { return await fn(); } finally { map.regtest = prev; }
}

function anchorSqlOf(captured){
    return captured.find(sql => sql.indexOf('anchor_actions p') !== -1);
};

describe('state_hash anchor_invalid class: archive-head coverage and chunk-height key @regression', () => {
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
});

describe('state_hash anchor_invalid class: archive-head coverage and chunk-height key @regression', () => {
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
});

describe('state_hash anchor_invalid class: archive-head coverage and chunk-height key @regression', () => {
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

// Isolate this suite from the other regtest-armed classes (their keys/query

// slots would shift the expected key set); always restored.

// The defect itself, executed rather than mocked: a genuinely stamped batch,

// a genuinely completing chunk at block B, and the legacy key still matches

// nothing. This is the assertion the stubbed predecessor could never make.
