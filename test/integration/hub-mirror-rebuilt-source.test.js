// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// A REBUILT HUB DATABASE, against a real MariaDB.
//
// WHY THIS CANNOT BE A UNIT TEST. The unit suite stubs _applyRow, so it can prove the
// bootstrap cursor restarts and that the hub's rows were OFFERED, but never that they
// LANDED. The whole defect lives in the difference: the mirror apply is id-parity
// INSERT IGNORE, so when a rebuilt hub reuses id 1 for a new checkpoint, the stale local
// row 1 silently swallows it. No error, no log, and a re-page that looks successful while
// mirroring almost nothing. Only a real database has that collision.
//
// The shape these fixtures reproduce: a hub database is dropped and recreated, so its
// state_checkpoints restarts at id 1 while every indexer mirror still holds rows from the
// retired id space at far higher ids. The mirror can then never catch up, and the explorer
// serves checkpoints for a chain history that no longer exists while every service reports
// healthy. The ids below are sized to that shape.
//
// Reader-visible symptom, and what these tests assert: readers of this table take the
// newest row (MAX(checkpoint_seq)), so a stale row keeps winning over everything the
// re-page delivers.
//
// One case here is a PINNED LIMITATION rather than a guarantee, and it is named as such:
// the detection is a comparison of ids, so an id space that overlaps the retired one
// exactly is invisible to it. Writing this suite against a real database is what surfaced
// that; the stubbed unit suite reported the same scenario as working.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const sinon   = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility   = require('../../src/utility');
const Database  = require('../../src/db');
const HubDbSync = require('../../src/hub_db_sync.js');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = process.env.TEST_HUB_MIRROR_DB || 'xchain_hub_mirror_rebuilt';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// The product's own stripper, for the reason archive-replay-watermarks.test.js documents:
// the licence banner starts `--***` with no whitespace, which MySQL does not treat as a
// comment, so a verbatim send is errno 1064 on the first line.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, 'state_checkpoints.sql'), 'utf8'));

const NETWORK = 'regtest';

// A checkpoint row shaped like the hub's snapshot wire (every NOT NULL column present).
function row(id, chain, seq, blockIndex) {
    return {
        id: id, chain: chain, network: NETWORK, block_index: blockIndex,
        block_hash:  String(id).padStart(64, 'a'),
        ledger_hash: String(id).padStart(64, 'b'),
        actions_hash: String(id).padStart(64, 'c'),
        contract_hash: String(id).padStart(64, 'd'),
        checkpoint_seq: seq, snapshot_block: seq,
        state_root: String(id).padStart(64, 'e'), state_root_version: 1,
        block_merkle_root: String(id).padStart(64, 'f'), block_merkle_version: 1,
        validator_signatures: JSON.stringify([{ pubkey: 'a'.repeat(64), sig: 'b'.repeat(128) }])
    };
}

describe('HubDbSync against a REBUILT hub database, real MariaDB @tier3', function () {
    this.timeout(60000);

    let db;

    before(async function () {
        if (!DB_PASS) this.skip();
        const admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
        await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
        await admin.end();

        const config = getTestConfig();
        db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config, util: new Utility() });
    });

    afterEach(function () { sinon.restore(); });

    // Seed the mirror as it stood before the hub was rebuilt: rows carrying a retired id
    // space, at ids and checkpoint_seqs far above anything the new hub will ever serve.
    async function seedPreResetMirror(ids) {
        const conn = await db.getConnection();
        try {
            await conn.query('DELETE FROM state_checkpoints');
            for (const id of ids) {
                const r = row(id, 'BTC', 11000 + id, 3900 + id);
                await conn.query(
                    'INSERT INTO state_checkpoints (id, chain, network, block_index, block_hash, ledger_hash, ' +
                    'actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, ' +
                    'block_merkle_root, block_merkle_version, validator_signatures) ' +
                    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    [r.id, r.chain, r.network, r.block_index, r.block_hash, r.ledger_hash, r.actions_hash,
                     r.contract_hash, r.checkpoint_seq, r.snapshot_block, r.state_root, r.state_root_version,
                     r.block_merkle_root, r.block_merkle_version, r.validator_signatures]);
            }
        } finally { await conn.release(); }
    }

    // A HubDbSync wired to the real database, serving the REBUILT hub's table over the
    // snapshot endpoint exactly as the live hub does (rows strictly above since_id).
    function makeSync(hubRows, advertisedCeiling) {
        const sync = new HubDbSync(db, { hubUrl: 'http://hub.test', network: NETWORK });
        if (advertisedCeiling !== undefined) sync._readyMaxIds = { state_checkpoints: advertisedCeiling };
        sinon.stub(sync, '_httpGet').callsFake(async (p) => {
            const since = Number(/since_id=(\d+)/.exec(p)[1]);
            return { rows: hubRows.filter((r) => r.id > since), watermark: 4242 };
        });
        return sync;
    }

    async function mirrorState() {
        const conn = await db.getConnection();
        try {
            const rows = await conn.query(
                'SELECT id, checkpoint_seq FROM state_checkpoints ORDER BY id ASC');
            return {
                ids:  rows.map((r) => Number(r.id)),
                maxSeq: rows.length ? Math.max(...rows.map((r) => Number(r.checkpoint_seq))) : null
            };
        } finally { await conn.release(); }
    }

    // The exact venue shape: the hub restarted its ids at 1 and holds three checkpoints,
    // the mirror still holds the pre-reset id space.
    it('rebuilds the mirror to exactly what a rebuilt hub holds', async function () {
        await seedPreResetMirror([11241, 11242, 11243]);
        const hubRows = [row(1, 'BTC', 124, 118), row(2, 'LTC', 124, 101), row(3, 'DOGE', 124, 102)];

        await makeSync(hubRows, 3)._bootstrapTable('state_checkpoints');

        const after = await mirrorState();
        assert.deepStrictEqual(after.ids, [1, 2, 3],
            'the mirror must hold the rebuilt hub table and nothing else');
        assert.strictEqual(after.maxSeq, 124,
            'readers take MAX(checkpoint_seq); a surviving pre-reset row keeps winning forever');
    });

    // KNOWN LIMITATION, pinned deliberately so it cannot change unnoticed and so the fix
    // that closes it flips this assertion on purpose.
    //
    // The ceiling comparison detects a replaced id space only when the local cursor sits
    // ABOVE what the hub advertises. When a rebuilt hub has re-grown far enough that its
    // ids overlap the retired ones exactly, the two sides agree on every id and disagree
    // only on what those ids MEAN, which no comparison of ids alone can see. Nothing then
    // purges, and INSERT IGNORE drops each incoming row against the stale one holding its
    // id, so the mirror keeps serving the retired rows.
    //
    // Narrow in practice and not the shape that was measured: a mirror re-bootstraps within
    // seconds of reconnecting, long before a rebuilt hub grows thousands of rows, so the
    // observed case (a large local cursor against a near-empty hub) is the detected one.
    // A mirror holding only a handful of rows is the exposure.
    //
    // Closing it needs a different signal: this table is append-only and never updated, so
    // a row the hub serves at id N whose content differs from local id N is a CONTRADICTION
    // rather than an absence, and contradiction is evidence page contents can legitimately
    // carry (the rule _purgeForeignNetworkRows sets is about inferring from absence, which
    // a filtered endpoint or a paging hole can fake; neither can fabricate a conflicting row).
    it('LIMITATION: an exactly-overlapping id space is not detectable from ids alone', async function () {
        await seedPreResetMirror([1, 2, 3]);
        const before = await mirrorState();
        assert.strictEqual(before.maxSeq, 11003, 'pre-condition: the stale rows own ids 1-3');

        const hubRows = [row(1, 'BTC', 124, 118), row(2, 'LTC', 124, 101), row(3, 'DOGE', 124, 102)];
        await makeSync(hubRows, 3)._bootstrapTable('state_checkpoints');

        const after = await mirrorState();
        assert.deepStrictEqual(after.ids, [1, 2, 3]);
        assert.strictEqual(after.maxSeq, 11003,
            'cursor 3 does not sit above ceiling 3, so nothing trips and the stale rows survive; ' +
            'when the content-contradiction detector lands, this becomes 124');
    });

    // A hub whose database was rebuilt moments ago has an EMPTY table and advertises 0.
    // That is the state the indexers actually reconnected into on the venue, and reading
    // 0 as "no information" is what let the stale mirror survive.
    it('clears the mirror when the rebuilt hub is still empty and advertises a ceiling of 0', async function () {
        await seedPreResetMirror([11241, 11242, 11243]);

        await makeSync([], 0)._bootstrapTable('state_checkpoints');

        const after = await mirrorState();
        assert.deepStrictEqual(after.ids, [], 'an empty source means an empty mirror, not a preserved one');
    });

    // The safety half. An older hub advertises no max_ids at all, and a missing ceiling is
    // evidence of nothing: the mirror must be left alone rather than wiped.
    it('leaves the mirror untouched when the hub advertises no ceiling', async function () {
        await seedPreResetMirror([11241, 11242, 11243]);

        await makeSync([row(11244, 'BTC', 11244, 3999)], undefined)._bootstrapTable('state_checkpoints');

        const after = await mirrorState();
        assert.deepStrictEqual(after.ids, [11241, 11242, 11243, 11244],
            'with no ceiling the cursor resumes and nothing is deleted');
    });

    // A healthy mirror on a hub that never rebuilt must keep resuming incrementally; the
    // fence must not turn every bootstrap into a wipe-and-repage.
    it('resumes incrementally and deletes nothing when the mirror is in the hub id space', async function () {
        await seedPreResetMirror([11241, 11242, 11243]);

        await makeSync([row(11244, 'BTC', 11244, 3999)], 11244)._bootstrapTable('state_checkpoints');

        const after = await mirrorState();
        assert.deepStrictEqual(after.ids, [11241, 11242, 11243, 11244],
            'a cursor at or below the ceiling is a valid position, not a rebuild');
    });
});
