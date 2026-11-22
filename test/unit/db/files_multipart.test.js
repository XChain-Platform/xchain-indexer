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

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./db_queries.test/helpers/db_stub.js');
const lifecycle  = require('../../../src/hub/table_lifecycle.js');
const rederive   = require('../../../src/db/rollback/rederive.js');

describe('multipart file database rows @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('installs the multipart mixin on Database instances', function () {
        const db = makeDb();
        for(const method of ['createManifest', 'createPart', 'createCompletion', 'getGroup'])
            assert.strictEqual(typeof db[method], 'function', method);
    });

    it('writes manifest, part, and completion rows under their action indexes', async function () {
        const db = makeDb();
        sinon.stub(db, 'normalizeDataValues').callsFake(data => data);
        sinon.stub(db, 'getAddressId').resolves(41);
        sinon.stub(db, 'createStatus').resolves(7);
        const doQuery = sinon.stub(db, 'doQuery').resolves([]);

        await db.createManifest({
            ACTION_INDEX: 10, SOURCE: 'source', FILE_HASH: 'a'.repeat(64),
            TOTAL_PARTS: '2', TOTAL_BYTES: '9', STATUS: 'valid'
        });
        await db.createPart({
            ACTION_INDEX: 11, SOURCE: 'source', FILE_HASH: 'a'.repeat(64),
            PART_INDEX: '0', BYTE_LENGTH: '4', PART_DIGEST: 'b'.repeat(64),
            BLOCK_INDEX: 5, STATUS: 'valid'
        });
        await db.createCompletion({
            ACTION_INDEX: 12, MANIFEST_ACTION_INDEX: 10, RESULT: 'complete', BLOCK_INDEX: 5
        });

        assert.match(doQuery.getCall(0).args[0], /INSERT INTO file_manifests/);
        assert.deepStrictEqual(doQuery.getCall(0).args[1], [10, 41, 'a'.repeat(64), 2, 9, 7]);
        assert.match(doQuery.getCall(1).args[0], /INSERT INTO file_parts/);
        assert.deepStrictEqual(doQuery.getCall(1).args[1], [11, 41, 'a'.repeat(64), 0, 4, 'b'.repeat(64), 5, 7]);
        assert.match(doQuery.getCall(2).args[0], /INSERT INTO file_completions/);
        assert.deepStrictEqual(doQuery.getCall(2).args[1], [12, 10, 'complete', 5]);
    });

    it('reads one valid manifest and the lowest valid action index for each part position', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(41);
        const manifest = {
            action_index: 10, source_id: 41, file_hash: 'a'.repeat(64),
            total_parts: 2, total_bytes: 9
        };
        const parts = [
            { action_index: 11, part_index: 0, byte_length: 4 },
            { action_index: 14, part_index: 1, byte_length: 5 }
        ];
        const doQuery = sinon.stub(db, 'doQuery');
        doQuery.onFirstCall().resolves([manifest]);
        doQuery.onSecondCall().resolves(parts);

        assert.deepStrictEqual(await db.getGroup('source', 'a'.repeat(64)), { manifest, parts });
        assert.strictEqual(doQuery.callCount, 2);
        assert.match(doQuery.firstCall.args[0], /FROM file_manifests/);
        assert.match(doQuery.firstCall.args[0], /s\.status='valid'/);
        assert.deepStrictEqual(doQuery.firstCall.args[1], [41, 'a'.repeat(64)]);
        assert.match(doQuery.secondCall.args[0], /MIN\(p\.action_index\) AS action_index/);
        assert.match(doQuery.secondCall.args[0], /p\.part_index < \?/);
        assert.match(doQuery.secondCall.args[0], /GROUP BY p\.part_index/);
        assert.match(doQuery.secondCall.args[0],
            /ORDER BY fp\.part_index ASC, fp\.action_index ASC/);
        assert.deepStrictEqual(doQuery.secondCall.args[1], [41, 'a'.repeat(64), 2]);
    });

    it('returns an empty group without table reads when the source is unknown', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(null);
        const doQuery = sinon.stub(db, 'doQuery').resolves([]);
        assert.deepStrictEqual(await db.getGroup('missing', 'a'.repeat(64)), { manifest: null, parts: [] });
        assert.strictEqual(doQuery.callCount, 0);
    });

    it('purges an orphaned part and its completion while retaining the earlier manifest', async function () {
        const rows = {
            file_manifests: [{ action_index: 10 }],
            file_parts: [{ action_index: 20 }],
            file_completions: [{ action_index: 21, manifest_action_index: 10 }]
        };
        const db = {
            async doQuery(sql, args){
                const match = /^DELETE FROM (file_manifests|file_parts|file_completions) WHERE action_index >= \?$/.exec(sql);
                if(!match) return [];
                rows[match[1]] = rows[match[1]].filter(row => row.action_index < args[0]);
                return [];
            }
        };
        const dataTables = lifecycle.rollbackTables().dataTables;
        for(const table of Object.keys(rows)) assert.ok(dataTables.includes(table), table);

        await rederive.purgeActionScopedTables(db, dataTables, 20);
        assert.deepStrictEqual(rows.file_manifests, [{ action_index: 10 }]);
        assert.deepStrictEqual(rows.file_parts, []);
        assert.deepStrictEqual(rows.file_completions, []);
    });
});
