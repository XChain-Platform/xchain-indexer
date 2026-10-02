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
const sinon = require('sinon');

const Database = require('../../../../src/db');
const { createListMeta, getListMeta } = require('../../../../src/db/lists/meta');

function normalized(sql){
    return sql.replace(/\s+/g, ' ').trim();
}

afterEach(function(){ sinon.restore(); });

describe('list meta storage reads', function(){
    it('registers list meta storage on the Database prototype', function(){
        assert.strictEqual(Database.prototype.createListMeta, createListMeta);
        assert.strictEqual(Database.prototype.getListMeta, getListMeta);
    });

    it('never reads a newer invalid row as the current meta', async function(){
        const stored = [
            { action_index: 301, list_action_index: 100, block_index: 30,
              status: 'valid', name: 'Valid name', description: 'Valid description' },
            { action_index: 302, list_action_index: 100, block_index: 31,
              status: 'invalid: NAME (format)', name: null, description: null }
        ];
        const db = {
            doQuery: sinon.stub().callsFake(async (sql, args) => {
                const query = normalized(sql);
                assert.match(query, /INNER JOIN actions a ON \(a\.action_index=lm\.action_index\)/);
                assert.match(query, /INNER JOIN index_statuses s ON \(s\.id=lm\.status_id\)/);
                assert.match(query, /lm\.list_action_index=\?/);
                assert.match(query, /s\.status='valid'/);
                assert.match(query, /ORDER BY lm\.action_index DESC LIMIT 1$/);
                assert.doesNotMatch(query, /a\.block_index<=\?/);
                assert.deepStrictEqual(args, [100]);
                return stored
                    .filter(row => row.list_action_index === args[0] && row.status === 'valid')
                    .sort((left, right) => right.action_index - left.action_index)
                    .slice(0, 1)
                    .map(({ name, description }) => ({ name, description }));
            })
        };

        assert.deepStrictEqual(await getListMeta(db, 100, null), {
            name: 'Valid name',
            description: 'Valid description'
        });
    });

    it('bounds a historical read at the requested block', async function(){
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            const query = normalized(sql);
            assert.match(query, /a\.block_index<=\?/);
            assert.match(query, /ORDER BY lm\.action_index DESC LIMIT 1$/);
            assert.deepStrictEqual(args, [100, 450]);
            return [{ name: 'Earlier name', description: null }];
        });

        assert.deepStrictEqual(await getListMeta({ doQuery }, 100, 450), {
            name: 'Earlier name',
            description: null
        });
    });

    it('returns null when the root has no valid meta row', async function(){
        const doQuery = sinon.stub().resolves([]);

        assert.strictEqual(await getListMeta({ doQuery }, 101, null), null);
        assert.deepStrictEqual(doQuery.firstCall.args[1], [101]);
    });

    it('writes the root, memo and status ids with the resolved text', async function(){
        const queries = [];
        const db = {
            normalizeDataValues: sinon.stub().callsFake(data => ({ ...data })),
            createMemo: sinon.stub().resolves(7),
            createStatus: sinon.stub().resolves(8),
            doQuery: sinon.stub().callsFake(async (sql, args) => {
                queries.push({ sql: normalized(sql), args });
                if(/^SELECT action_index/.test(normalized(sql))) return [];
                return { affectedRows: 1 };
            })
        };
        const data = {
            ACTION_INDEX: 302,
            LIST_ACTION_INDEX: 100,
            MEMO: 'rename',
            STATUS: 'valid'
        };

        const result = await createListMeta.call(db, data, 'New name', 'New description');

        assert.deepStrictEqual(result, { affectedRows: 1 });
        assert.ok(db.normalizeDataValues.calledOnceWithExactly(data));
        assert.ok(db.createMemo.calledOnceWithExactly('rename'));
        assert.ok(db.createStatus.calledOnceWithExactly('valid'));
        assert.match(queries[1].sql, /^INSERT INTO list_metas /);
        assert.deepStrictEqual(queries[1].args, [
            100, 'New name', 'New description', 7, 8, 302
        ]);
    });
});
