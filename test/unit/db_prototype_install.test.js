/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db_prototype_install.test.js
 *
 * The Database class is one file per DDL family under src/db/, installed onto
 * Database.prototype by db/index.js. A class body produces non-enumerable
 * prototype methods; Object.assign or a plain object spread produces enumerable
 * ones, and nothing else in the suite notices the difference. What notices it in
 * production is every `for (const k in row)` and every Object.keys/JSON.stringify
 * over an object that inherits from this prototype: an enumerable install puts
 * several hundred method names into those walks. Hub payloads, RPC responses and
 * the mirror rows are built that way, so this is a wire-shape invariant, not a
 * style preference.
 *
 * The mixin list is read out of db/index.js rather than hard-coded, so a family
 * added later is covered without touching this file.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const Database = require('../../src/db');

const DB_DIR = path.join(__dirname, '..', '..', 'src', 'db');

// The paths db/index.js actually installs, taken from its MIXIN_FILES declaration
// so this guard and the loader cannot disagree about the set.
function declaredMixinFiles() {
    const src   = fs.readFileSync(path.join(DB_DIR, 'index.js'), 'utf8');
    const start = src.indexOf('const MIXIN_FILES = [');
    assert.notStrictEqual(start, -1, 'db/index.js no longer declares MIXIN_FILES');
    const block = src.slice(start, src.indexOf('];', start));
    return block.match(/'\.\/[a-z0-9_]+\.js'/g).map((q) => q.slice(1, -1));
}

describe('Database prototype install @regression @tier1', function () {

    it('carries every declared mixin method, non-enumerable, and nothing enumerable at all', function () {
        const files = declaredMixinFiles();
        assert.ok(files.length >= 50, 'expected the per-family mixin set, found ' + files.length);

        let installed = 0;
        for (const file of files) {
            const mixin = require(path.join(DB_DIR, file));
            const keys  = Reflect.ownKeys(mixin);
            assert.ok(keys.length > 0, file + ' exports no methods');
            for (const key of keys) {
                const d = Object.getOwnPropertyDescriptor(Database.prototype, key);
                assert.ok(d, file + ' method ' + String(key) + ' is not on Database.prototype');
                assert.strictEqual(d.value, mixin[key], String(key) + ' on the prototype is not the mixin function');
                assert.strictEqual(d.enumerable, false, String(key) + ' is enumerable; a class body would not have made it so');
                assert.strictEqual(d.writable, true, String(key) + ' is not writable, so sinon cannot stub it');
                assert.strictEqual(d.configurable, true, String(key) + ' is not configurable, so sinon cannot restore it');
                installed += 1;
            }
        }
        assert.ok(installed >= 350, 'expected the bulk of the class on mixins, found ' + installed);

        // The class-body properties (constructor, migrations, transaction plumbing)
        // are non-enumerable by language rule, so the whole prototype must be.
        assert.deepStrictEqual(Object.keys(Database.prototype), []);
    });

    it('keeps the methods out of a for-in walk over an object that inherits them', function () {
        const row = Object.create(Database.prototype);
        row.block_index = 1;
        const walked = [];
        for (const key in row) walked.push(key);
        assert.deepStrictEqual(walked, ['block_index'],
            'prototype methods leaked into a for-in walk: ' + walked.slice(0, 8).join(', '));
        assert.deepStrictEqual(Object.keys(row), ['block_index']);
        assert.strictEqual(JSON.stringify(row), '{"block_index":1}');
    });

    it('lets a mixin method be stubbed and restored on the prototype', function () {
        const before = Database.prototype.getOrderInfo;
        const stub   = sinon.stub(Database.prototype, 'getOrderInfo').resolves('stubbed');
        try {
            assert.strictEqual(Database.prototype.getOrderInfo, stub);
            assert.strictEqual(Object.getOwnPropertyDescriptor(Database.prototype, 'getOrderInfo').enumerable, false,
                'stubbing must not turn the property enumerable');
        } finally {
            stub.restore();
        }
        assert.strictEqual(Database.prototype.getOrderInfo, before);
        assert.strictEqual(Object.getOwnPropertyDescriptor(Database.prototype, 'getOrderInfo').enumerable, false);
    });

});
