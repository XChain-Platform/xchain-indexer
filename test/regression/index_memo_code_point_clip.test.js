/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/regression/index_memo_code_point_clip.test.js
 *
 * createMemo clipped a memo with substring(0,250), which counts UTF-16 units. A refused row
 * whose memo ran past the column then lost half its supplementary-plane characters, or was
 * cut between the two halves of a pair, binding a lone surrogate. The memo is clipped by
 * code points like every other refused-row text.
 */

'use strict';

const assert = require('assert');

const mixin = require('../../src/db/index_tables/index.js');
const { fitColumnText } = require('../../src/db/column_text.js');

function makeDb(){
    const bound = [];
    const db = Object.assign({}, mixin, {
        util: { isNull: v => v === null || v === undefined || v === '' },
        async doQuery(sql, args){
            if(/^INSERT/.test(sql)){ bound.push(args[0]); return []; }
            return bound.length ? [{ id: 1 }] : [];
        }
    });
    return { db, bound };
}

describe('createMemo clips by code points', function(){
    const E = '\u{1F600}';

    it('keeps a 250 code point memo ending in a pair whole', async function(){
        const { db, bound } = makeDb();
        const v = 'a'.repeat(249) + E;
        await db.createMemo(v);
        assert.strictEqual(bound[0], fitColumnText(v, 250, false));
        assert.strictEqual(bound[0], v);
        assert.ok(bound[0].isWellFormed());
        assert.ok(!Buffer.from(bound[0], 'utf8').includes(Buffer.from('efbfbd', 'hex')));
    });

    it('keeps 250 supplementary code points, not 125', async function(){
        const { db, bound } = makeDb();
        const v = E.repeat(250);
        await db.createMemo(v);
        assert.strictEqual(Array.from(bound[0]).length, 250);
        assert.strictEqual(bound[0], fitColumnText(v, 250, false));
    });

    it('clips a longer memo at 250 code points without splitting a pair', async function(){
        const { db, bound } = makeDb();
        await db.createMemo(E.repeat(300));
        assert.strictEqual(bound[0], E.repeat(250));
        assert.ok(bound[0].isWellFormed());
    });

    it('leaves an ASCII memo of 250 units unchanged and null as null', async function(){
        const { db, bound } = makeDb();
        const v = 'x'.repeat(250);
        await db.createMemo(v);
        assert.strictEqual(bound[0], v);
        assert.strictEqual(await db.createMemo(null), null);
    });
});
