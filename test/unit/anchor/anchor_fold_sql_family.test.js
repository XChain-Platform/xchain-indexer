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
const anchorSql = require('../../../src/db/anchor_sql.js');
const { ARCHIVE_HEAD_VERSIONS_SQL, archiveHeadPredicate } =
    require('../../../src/consensus/state_hash.js');

const ARCHIVE_HEAD_SELECTS = [
    ['ARCHIVE_HEAD_AUTHOR_SQL', 'h'],
    ['ARCHIVE_CHUNK_SET_SQL', 'h'],
    ['ARCHIVE_HEAD_GATE_SQL', 'h'],
    ['ARCHIVE_ANCHOR_BY_CONTENT_SQL', 'a'],
];

describe('anchor read SQL folded row families @regression @tier1', function(){
    it('admits v3 checkpoints and classifies folded chain rows as sections', function(){
        assert.ok(anchorSql.CHECKPOINT_VERSIONS.includes(3));
        assert.deepStrictEqual(anchorSql.CHECKPOINT_SECTION_VERSIONS, [0, 3]);
    });

    for(const [name, alias] of ARCHIVE_HEAD_SELECTS){
        it(name + ' selects archive heads by row attributes', function(){
            const sql = anchorSql[name];
            assert.ok(sql.includes(archiveHeadPredicate(alias)));
            assert.ok(sql.includes(alias + '.match_batch_seq IS NOT NULL AND'));
            assert.ok(!sql.includes(alias + '.version ' + ARCHIVE_HEAD_VERSIONS_SQL));
        });
    }
});
