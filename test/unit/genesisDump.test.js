/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Unit tests: genesis state-dump importer (src/genesisDump.js).
 *
 * The importer bulk-loads an UNTRUSTED artifact and its trust is supposed to
 * reduce entirely to the pinned GENESIS_DUMP_HASH. These tests pin the security
 * properties of the read() path with a mock DB (no MariaDB):
 *   - verify-then-import: a pinned-hash mismatch is rejected BEFORE any INSERT;
 *   - SQL identifier injection via table/column names is rejected;
 *   - a malformed structure (row before a table header, missing meta) is rejected;
 *   - a well-formed dump imports and passes the block-hash recompute.
 * The byte-identity vs canonical-injection property is covered by the
 * integration suite (23-genesis-dump-import).
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const zlib   = require('zlib');

const GenesisDump = require('../../src/genesisDump');

const util = { isNull: (v) => v === null || v === undefined || v === '' };

// Uncompressed content bytes == concatenation of `JSON.stringify(obj) + '\n'`,
// exactly what write() hashes; gzip to disk. Returns { file, contentHash }.
let counter = 0;
function buildDump(objs){
    let content = objs.map(o => JSON.stringify(o) + '\n').join('');
    let contentHash = crypto.createHash('sha256').update(content).digest('hex');
    let file = path.join(os.tmpdir(), `xchain-gd-unit-${process.pid}-${counter++}.ndjson.gz`);
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(content, 'utf8')));
    return { file, contentHash };
}

// Mock DB: records every INSERT so a test can assert nothing was written, and
// returns block hashes that match the dump's recorded meta for the happy path.
function mockDb(expectedHashes){
    let inserts = [];
    return {
        inserts,
        async doQuery(sql, args){
            if(/^\s*INSERT/i.test(sql))
                inserts.push({ sql, args });
            return [];
        },
        async getBlockHashes(){
            return {
                ledger:    { hash: expectedHashes.ledger },
                actions:   { hash: expectedHashes.actions },
                state:     { hash: expectedHashes.state },
                contracts: { hash: expectedHashes.contracts },
            };
        },
    };
}

const HASHES = { ledger: 'aa', actions: 'bb', state: 'cc', contracts: 'dd' };
const META   = {
    version: 1, coin: 'BTC', genesisBlock: 100,
    expectedHashes: HASHES, tableOrder: ['tokens'], rowCounts: { tokens: 1 },
};
const GOOD = [
    { meta: META },
    { t: 'tokens', cols: ['id', 'tick_id'] },
    { r: [1, 5] },
    { r: [2, 6] },
];

describe('GenesisDump.read @regression', function () {

    afterEach(function () {
        // best-effort temp cleanup
        for (const f of fs.readdirSync(os.tmpdir()))
            if (f.startsWith(`xchain-gd-unit-${process.pid}-`))
                try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
    });

    it('verify-then-import: a pinned-hash mismatch is rejected BEFORE any INSERT', async function () {
        const { file } = buildDump(GOOD);
        const db = mockDb(HASHES);
        const gd = new GenesisDump(db, util, { GENESIS_BLOCK: 100, GENESIS_DUMP_HASH: 'f'.repeat(64) });
        await assert.rejects(() => gd.read(file), /dump hash mismatch/i);
        assert.equal(db.inserts.length, 0, 'no rows inserted before the hash gate');
    });

    it('imports a well-formed dump when the pinned hash matches', async function () {
        const { file, contentHash } = buildDump(GOOD);
        const db = mockDb(HASHES);
        const gd = new GenesisDump(db, util, { GENESIS_BLOCK: 100, GENESIS_DUMP_HASH: contentHash });
        const res = await gd.read(file);
        assert.equal(res.rowsImported, 2);
        assert.equal(db.inserts.length, 1, 'one batched INSERT for the two rows');
        assert.match(db.inserts[0].sql, /INSERT INTO `tokens`/);
    });

    it('rejects an injected table identifier (unpinned)', async function () {
        const bad = [ { meta: META }, { t: 'tokens`; DROP TABLE tokens; --', cols: ['id'] }, { r: [1] } ];
        const { file } = buildDump(bad);
        const db = mockDb(HASHES);
        const gd = new GenesisDump(db, util, { GENESIS_BLOCK: 100, GENESIS_DUMP_HASH: null });
        await assert.rejects(() => gd.read(file), /invalid SQL identifier/);
        assert.equal(db.inserts.length, 0);
    });

    it('rejects an injected column identifier (unpinned)', async function () {
        const bad = [ { meta: META }, { t: 'tokens', cols: ['id`) VALUES (1) -- '] }, { r: [1] } ];
        const { file } = buildDump(bad);
        const db = mockDb(HASHES);
        const gd = new GenesisDump(db, util, { GENESIS_BLOCK: 100, GENESIS_DUMP_HASH: null });
        await assert.rejects(() => gd.read(file), /invalid SQL identifier/);
        assert.equal(db.inserts.length, 0);
    });

    it('rejects a table header with no columns', async function () {
        const bad = [ { meta: META }, { t: 'tokens', cols: [] }, { r: [1] } ];
        const { file } = buildDump(bad);
        const gd = new GenesisDump(mockDb(HASHES), util, { GENESIS_BLOCK: 100, GENESIS_DUMP_HASH: null });
        await assert.rejects(() => gd.read(file), /missing columns/);
    });

    it('rejects a row that precedes any table header (no unbounded buffering)', async function () {
        const bad = [ { meta: META }, { r: [1, 2] } ];
        const { file } = buildDump(bad);
        const db = mockDb(HASHES);
        const gd = new GenesisDump(db, util, { GENESIS_BLOCK: 100, GENESIS_DUMP_HASH: null });
        await assert.rejects(() => gd.read(file), /row before any table header/);
        assert.equal(db.inserts.length, 0);
    });

    it('rejects a dump whose block does not match GENESIS_BLOCK', async function () {
        const { file } = buildDump(GOOD);
        const gd = new GenesisDump(mockDb(HASHES), util, { GENESIS_BLOCK: 999, GENESIS_DUMP_HASH: null });
        await assert.rejects(() => gd.read(file), /!= configured GENESIS_BLOCK/);
    });

    it('halts when the recomputed block hashes differ from the dump record', async function () {
        const { file } = buildDump(GOOD);
        const db = mockDb({ ledger: 'XX', actions: 'bb', state: 'cc', contracts: 'dd' });
        const gd = new GenesisDump(db, util, { GENESIS_BLOCK: 100, GENESIS_DUMP_HASH: null });
        await assert.rejects(() => gd.read(file), /hash verification failed \(ledger\)/);
    });

    it('rejects a dump missing its meta header', async function () {
        const bad = [ { t: 'tokens', cols: ['id'] }, { r: [1] } ];
        const { file } = buildDump(bad);
        const gd = new GenesisDump(mockDb(HASHES), util, { GENESIS_BLOCK: 100, GENESIS_DUMP_HASH: null });
        await assert.rejects(() => gd.read(file), /missing meta header/);
    });
});
