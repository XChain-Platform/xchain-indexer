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
 * test/unit/db.test.js
 *
 * Unit tests for Database class methods that do not require a live MariaDB connection.
 *
 * Primary target: normalizeDataValues()
 * Secondary:      getBlockIndex() input-validation branches
 */

'use strict';

const { assert, makeDbLike } = require('./db.test/helpers/db.js');

let normalize;
let config;
let util;

// ---------------------------------------------------------------------------
// describe: normalizeDataValues
// ---------------------------------------------------------------------------
describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    // ── Boxed-object coercion ─────────────────────────────────────────────

    it('converts a mathjs bignumber object to string', function () {
        const bn   = util.bcnum('12345678901234567890');
        const data = { AMOUNT: bn };
        const out  = normalize(data);
        assert.strictEqual(typeof out.AMOUNT, 'string');
        assert.strictEqual(util.bcformat(out.AMOUNT, 0), '12345678901234567890');
    });

    it('leaves a plain string value unchanged', function () {
        const data = { AMOUNT: '100' };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, '100');
    });

    it('leaves null values unchanged', function () {
        const data = { AMOUNT: null };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, null);
    });

    // ── LIST_FIELDS (ALLOW_LIST, BLOCK_LIST) ─────────────────────────────

    it('keeps ALLOW_LIST when it is numeric', function () {
        const data = { ALLOW_LIST: '42', BLOCK_LIST: null };
        const out  = normalize(data);
        assert.strictEqual(out.ALLOW_LIST, '42');
    });

    it('keeps BLOCK_LIST when it is a numeric integer string', function () {
        const data = { ALLOW_LIST: null, BLOCK_LIST: '7' };
        const out  = normalize(data);
        assert.strictEqual(out.BLOCK_LIST, '7');
    });

    it('sets ALLOW_LIST to null when it is a non-numeric string', function () {
        const data = { ALLOW_LIST: 'notanumber', BLOCK_LIST: null };
        const out  = normalize(data);
        assert.strictEqual(out.ALLOW_LIST, null);
    });

    it('sets BLOCK_LIST to null when it is a non-numeric string', function () {
        const data = { ALLOW_LIST: null, BLOCK_LIST: 'bad' };
        const out  = normalize(data);
        assert.strictEqual(out.BLOCK_LIST, null);
    });
});

describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    it('leaves ALLOW_LIST null when it is already null', function () {
        const data = { ALLOW_LIST: null, BLOCK_LIST: null };
        const out  = normalize(data);
        assert.strictEqual(out.ALLOW_LIST, null);
    });

    // ── NUMBER_FIELDS ─────────────────────────────────────────────────────

    it('keeps AMOUNT when it is a valid numeric string', function () {
        const data = { AMOUNT: '100' };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, '100');
    });

    it('sets AMOUNT to null when it is a non-numeric string', function () {
        const data = { AMOUNT: 'notanumber' };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, null);
    });

    it('sets AMOUNT to null when it is null', function () {
        const data = { AMOUNT: null };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, null);
    });

    it('sets MAX_SUPPLY to null when it is empty string', function () {
        const data = { MAX_SUPPLY: '' };
        const out  = normalize(data);
        assert.strictEqual(out.MAX_SUPPLY, null);
    });

    it('keeps MAX_SUPPLY when it is a valid large number string', function () {
        const data = { MAX_SUPPLY: '1000000000000000000000' };
        const out  = normalize(data);
        assert.strictEqual(out.MAX_SUPPLY, '1000000000000000000000');
    });

    it('sets DECIMALS to null when it is non-numeric in NUMBER_FIELDS pass', function () {
        const data = { DECIMALS: 'abc' };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, null);
    });
});

describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    it('preserves a FILE action MIME string in TYPE', function () {
        // TYPE sits in NUMBER_FIELDS for LIST's numeric list type, but for
        // FILE it is the MIME string; numeric-normalizing it nulled every
        // stored MIME type (files.type_id was always NULL).
        const data = { ACTION: 'FILE', TYPE: 'application/json' };
        const out  = normalize(data);
        assert.strictEqual(out.TYPE, 'application/json');
    });

    it('still numeric-normalizes TYPE for LIST actions', function () {
        const valid   = normalize({ ACTION: 'LIST', TYPE: '2' });
        assert.strictEqual(valid.TYPE, '2');
        const invalid = normalize({ ACTION: 'LIST', TYPE: 'image/png' });
        assert.strictEqual(invalid.TYPE, null);
    });

    // ── LOCK_FIELDS ───────────────────────────────────────────────────────

    it('keeps LOCK_MAX_SUPPLY when it is 0', function () {
        const data = { LOCK_MAX_SUPPLY: 0 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, 0);
    });

    it('keeps LOCK_MAX_SUPPLY when it is 1', function () {
        const data = { LOCK_MAX_SUPPLY: 1 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, 1);
    });

    it('sets LOCK_MAX_SUPPLY to null when it is 2', function () {
        const data = { LOCK_MAX_SUPPLY: 2 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, null);
    });

    it('sets LOCK_MAX_SUPPLY to null when it is -1', function () {
        const data = { LOCK_MAX_SUPPLY: -1 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, null);
    });

    it('sets LOCK_MAX_SUPPLY to null when it is null', function () {
        const data = { LOCK_MAX_SUPPLY: null };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, null);
    });
});

describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    it('converts LOCK_MINT string "1" to integer 1', function () {
        // String '1' is numeric and converts to valid lock value 1
        const data = { LOCK_MINT: '1' };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MINT, 1);
    });

    it('keeps LOCK_DESCRIPTION at 1', function () {
        const data = { LOCK_DESCRIPTION: 1 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_DESCRIPTION, 1);
    });

    it('sets LOCK_CALLBACK to null for any value other than 0 or 1', function () {
        const data = { LOCK_CALLBACK: 99 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_CALLBACK, null);
    });

    // ── DECIMALS range check ──────────────────────────────────────────────

    it('keeps DECIMALS when it is 0 (MIN boundary)', function () {
        const data = { DECIMALS: 0 };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, 0);
    });

    it('keeps DECIMALS when it is 18 (MAX boundary)', function () {
        const data = { DECIMALS: 18 };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, 18);
    });

    it('sets DECIMALS to null when it is -1 (below MIN)', function () {
        const data = { DECIMALS: -1 };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, null);
    });

    it('sets DECIMALS to null when it is 19 (above MAX)', function () {
        const data = { DECIMALS: 19 };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, null);
    });

    it('leaves DECIMALS as null when it is already null', function () {
        const data = { DECIMALS: null };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, null);
    });
});
