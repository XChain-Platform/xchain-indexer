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
 ********************************************************************/

'use strict';

const assert = require('assert');

const anchorMethods = require('../../../src/db/anchors');

async function capture(method, args){
    const calls = [];
    const db = {
        doQuery: async (sql, params) => {
            calls.push({ sql, params });
            return [];
        },
    };
    await anchorMethods[method].apply(db, args);
    assert.strictEqual(calls.length, 1);
    return calls[0];
}

function assertFoldPredicate(sql){
    assert.match(sql, /a\.match_batch_seq IS NOT NULL AND a\.version <> 2/);
    assert.doesNotMatch(sql, /a\.version\s+IN\s*\(/i);
}

describe('archive-head database readers', function(){
    it('uses the fold row predicate for replay watermarks without version parameters', async function(){
        const { sql, params } = await capture('getArchiveReplayWatermarks', []);
        assertFoldPredicate(sql);
        assert.deepStrictEqual(params, []);
    });

    it('uses the fold row predicate for an unscoped batch lookup', async function(){
        const { sql, params } = await capture('getAnchorV1ByBatchSeq', [42]);
        assertFoldPredicate(sql);
        assert.deepStrictEqual(params, [42]);
        assert.match(sql, /ORDER BY a\.action_index ASC LIMIT 1/i);
    });

    it('keeps only batch and author parameters for a scoped batch lookup', async function(){
        const author = 'DPublisher';
        const { sql, params } = await capture('getAnchorV1ByBatchSeq', [42, author]);
        assertFoldPredicate(sql);
        assert.deepStrictEqual(params, [42, author]);
        assert.match(sql, /ORDER BY a\.action_index ASC LIMIT 1/i);
    });
});
