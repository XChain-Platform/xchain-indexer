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
const sinon  = require('sinon');

const { makeMultipartIo } = require('../../../src/db/files/multipart_io.js');

const COMPLETION_QUERY = 'SELECT action_index, manifest_action_index, result, block_index FROM file_completions WHERE manifest_action_index=? ORDER BY action_index ASC LIMIT 1';

describe('multipart I/O group reads @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('passes the source and file hash through to the database', async function () {
        const group = { manifest: { action_index: 10 }, parts: [] };
        const db = { getGroup: sinon.stub().resolves(group) };

        assert.strictEqual(await makeMultipartIo(db).getGroup('source', 'hash'), group);
        sinon.assert.calledOnceWithExactly(db.getGroup, 'source', 'hash');
    });
});

describe('multipart I/O completion reads @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('returns the first completion using one parameterized query', async function () {
        const row = {
            action_index: 12, manifest_action_index: 10,
            result: 'complete', block_index: 5,
        };
        const db = { doQuery: sinon.stub().resolves([row]) };

        assert.strictEqual(await makeMultipartIo(db).getCompletion(10), row);
        sinon.assert.calledOnceWithExactly(db.doQuery, COMPLETION_QUERY, [10]);
        assert.strictEqual(db.doQuery.firstCall.args[0].includes('10'), false);
    });

    it('returns null from one query when no completion exists', async function () {
        const db = { doQuery: sinon.stub().resolves([]) };

        assert.strictEqual(await makeMultipartIo(db).getCompletion(27), null);
        sinon.assert.calledOnceWithExactly(db.doQuery, COMPLETION_QUERY, [27]);
    });
});

describe('multipart I/O completion writes @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('maps lowercase keys without mutating the input row', async function () {
        const db = { createCompletion: sinon.stub().resolves('written') };
        const row = {
            action_index: 12, manifest_action_index: 10,
            result: 'complete', block_index: 5,
        };
        const before = { ...row };

        assert.strictEqual(await makeMultipartIo(db).createCompletion(row), 'written');
        sinon.assert.calledOnceWithExactly(db.createCompletion, {
            ACTION_INDEX: 12, MANIFEST_ACTION_INDEX: 10,
            RESULT: 'complete', BLOCK_INDEX: 5,
        });
        assert.deepStrictEqual(row, before);
    });
});
