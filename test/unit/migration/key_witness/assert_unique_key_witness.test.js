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
 ********************************************************************/

'use strict';

const assert = require('assert');
const { keyDependentTargets, assertUniqueKeyWitness } = require('../../../../src/db/database/migration_guards/key_witness.js');

const declared = [{ name: 'uq_pair', unique: true, columns: ['a', 'b'] }];
const write = ['INSERT IGNORE INTO target (a, b) VALUES (1, 2)'];
const row = (name, nonUnique, column, seq) => ({
    INDEX_NAME: name, NON_UNIQUE: nonUnique, COLUMN_NAME: column, SEQ_IN_INDEX: seq,
});

describe('automatic migration unique-key witness @regression @tier1', function () {
    it('finds each key-dependent write and ignores one inside a quoted literal', function () {
        assert.deepStrictEqual(keyDependentTargets([
            'INSERT IGNORE INTO index_statuses (status) VALUES (1)',
            'INSERT INTO `VOTES` (a) VALUES (1) ON DUPLICATE KEY UPDATE a=1',
            'REPLACE INTO db.bets (a) VALUES (1)',
            "UPDATE x SET note='INSERT IGNORE INTO y'",
        ]), ['index_statuses', 'votes', 'bets']);
    });

    it('refuses a missing declared unique index and names its complete remedy', async function () {
        const conn = { query: async () => [] };
        await assert.rejects(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', write, () => declared),
            /f\.sql[\s\S]*target[\s\S]*uq_pair[\s\S]*a, b[\s\S]*Boot the indexer once[\s\S]*earlier dated migration/);
    });

    it('passes a live unique index with the same ordered column set under another name', async function () {
        let reads = 0;
        const conn = { query: async () => {
            reads++;
            return [row('live_pair', 0, 'b', 2), row('live_pair', 0, 'a', 1)];
        } };
        await assert.doesNotReject(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', write.concat(write), () => declared));
        assert.strictEqual(reads, 1, 'one target table must have one STATISTICS read');
    });

    it('refuses a non-unique live index with the same columns', async function () {
        const conn = { query: async () => [row('uq_pair', 1, 'a', 1), row('uq_pair', 1, 'b', 2)] };
        await assert.rejects(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', write, () => declared), /uq_pair/);
    });

    it('passes a table created earlier in the same file without reading live metadata', async function () {
        let reads = 0;
        const conn = { query: async () => { reads++; return []; } };
        await assert.doesNotReject(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', [
            'CREATE TABLE target (a INT, b INT, UNIQUE KEY uq_pair (a, b))',
            write[0],
        ], () => declared));
        assert.strictEqual(reads, 0);
    });

    it('ignores a key-dependent statement inside a quoted literal', async function () {
        let reads = 0;
        const conn = { query: async () => { reads++; return []; } };
        await assert.doesNotReject(() => assertUniqueKeyWitness(conn, 'db', 'f.sql', [
            "UPDATE notes SET value = 'REPLACE INTO target (a, b) VALUES (1, 2)'",
        ], () => declared));
        assert.strictEqual(reads, 0);
    });
});
