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
 **********************************************************************/

// test/unit/db/db.test/continued_normalization.test.js
//
// Continues normalization coverage for action-specific text fields and copy semantics.

'use strict';

const { assert, makeDbLike } = require('./helpers/db.js');

let normalize;
let config;
let util;

describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    // ── BROADCAST truncation ──────────────────────────────────────────────

    it('BROADCAST: truncates MESSAGE at 250 chars', function () {
        const long = 'x'.repeat(300);
        const data = { ACTION: 'BROADCAST', MESSAGE: long, VALUE: null, FEE: null };
        const out  = normalize(data);
        assert.strictEqual(out.MESSAGE.length, 250);
    });

    it('BROADCAST: keeps MESSAGE when <= 250 chars', function () {
        const data = { ACTION: 'BROADCAST', MESSAGE: 'hello', VALUE: null, FEE: null };
        const out  = normalize(data);
        assert.strictEqual(out.MESSAGE, 'hello');
    });

    it('BROADCAST: leaves MESSAGE null when null', function () {
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: null, FEE: null };
        const out  = normalize(data);
        assert.strictEqual(out.MESSAGE, null);
    });

    it('BROADCAST: VALUE is set to null because VALUE is a NUMBER_FIELD (non-numeric)', function () {
        // VALUE is listed in NUMBER_FIELDS, so a non-numeric string gets nulled before truncation
        const long = 'v'.repeat(50);
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: long, FEE: null };
        const out  = normalize(data);
        // Non-numeric VALUE is wiped by NUMBER_FIELDS normalisation pass
        assert.strictEqual(out.VALUE, null);
    });

    it('BROADCAST: keeps numeric VALUE and truncates at 25 chars', function () {
        // A numeric VALUE string passes NUMBER_FIELDS check, then gets truncated
        const longNum = '1'.repeat(30);
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: longNum, FEE: null };
        const out  = normalize(data);
        assert.strictEqual(out.VALUE.length, 25);
    });

    it('BROADCAST: truncates FEE at 11 chars', function () {
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: null, FEE: '0.00000000000' };
        const out  = normalize(data);
        assert.strictEqual(out.FEE.length, 11);
    });

    it('BROADCAST: keeps FEE when <= 11 chars', function () {
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: null, FEE: '1.5' };
        const out  = normalize(data);
        assert.strictEqual(out.FEE, '1.5');
    });
});

describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    // ── FILE truncation ───────────────────────────────────────────────────

    it('FILE: truncates NAME at 250 chars', function () {
        const long = 'n'.repeat(300);
        const data = { ACTION: 'FILE', NAME: long, TITLE: null };
        const out  = normalize(data);
        assert.strictEqual(out.NAME.length, 250);
    });

    it('FILE: truncates TITLE at 250 chars', function () {
        const long = 't'.repeat(300);
        const data = { ACTION: 'FILE', NAME: null, TITLE: long };
        const out  = normalize(data);
        assert.strictEqual(out.TITLE.length, 250);
    });

    it('FILE: leaves NAME null when null', function () {
        const data = { ACTION: 'FILE', NAME: null, TITLE: null };
        const out  = normalize(data);
        assert.strictEqual(out.NAME, null);
    });

    // ── ISSUE truncation ──────────────────────────────────────────────────

    it('ISSUE: truncates DESCRIPTION at 250 chars', function () {
        const long = 'd'.repeat(300);
        const data = { ACTION: 'ISSUE', DESCRIPTION: long };
        const out  = normalize(data);
        assert.strictEqual(out.DESCRIPTION.length, 250);
    });

    it('ISSUE: keeps DESCRIPTION when exactly 250 chars', function () {
        const desc = 'd'.repeat(250);
        const data = { ACTION: 'ISSUE', DESCRIPTION: desc };
        const out  = normalize(data);
        assert.strictEqual(out.DESCRIPTION.length, 250);
    });

    it('ISSUE: leaves DESCRIPTION null when null', function () {
        const data = { ACTION: 'ISSUE', DESCRIPTION: null };
        const out  = normalize(data);
        assert.strictEqual(out.DESCRIPTION, null);
    });
});

describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    // ── MESSAGE truncation ────────────────────────────────────────────────

    it('MESSAGE: ENCRYPTION_METHOD validated by NUMBER_FIELDS (kept if numeric)', function () {
        // ENCRYPTION_METHOD is in NUMBER_FIELDS: kept as-is if numeric, nullified otherwise.
        // Truncation removed to prevent converting valid numbers to invalid strings.
        const data = { ACTION: 'MESSAGE', ENCRYPTION_METHOD: '12' };
        const out  = normalize(data);
        assert.strictEqual(out.ENCRYPTION_METHOD, '12');
    });

    it('MESSAGE: leaves ENCRYPTION_METHOD null when null', function () {
        const data = { ACTION: 'MESSAGE', ENCRYPTION_METHOD: null };
        const out  = normalize(data);
        assert.strictEqual(out.ENCRYPTION_METHOD, null);
    });

    it('MESSAGE: keeps ENCRYPTION_METHOD when it is 1 character', function () {
        const data = { ACTION: 'MESSAGE', ENCRYPTION_METHOD: '2' };
        const out  = normalize(data);
        assert.strictEqual(out.ENCRYPTION_METHOD, '2');
    });

    // ── SLEEP truncation ──────────────────────────────────────────────────

    it('SLEEP: truncates RESUME_BLOCK at 25 chars', function () {
        const long = '9'.repeat(30);
        const data = { ACTION: 'SLEEP', RESUME_BLOCK: long };
        const out  = normalize(data);
        assert.strictEqual(out.RESUME_BLOCK.length, 25);
    });

    it('SLEEP: leaves RESUME_BLOCK null when null', function () {
        const data = { ACTION: 'SLEEP', RESUME_BLOCK: null };
        const out  = normalize(data);
        assert.strictEqual(out.RESUME_BLOCK, null);
    });

    it('SLEEP: keeps RESUME_BLOCK when <= 25 chars', function () {
        const data = { ACTION: 'SLEEP', RESUME_BLOCK: '100' };
        const out  = normalize(data);
        assert.strictEqual(out.RESUME_BLOCK, '100');
    });
});

describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    // ── MEMO truncation (applies to all actions) ──────────────────────────

    it('truncates MEMO at 250 chars for any action', function () {
        const long = 'm'.repeat(300);
        const data = { ACTION: 'SEND', MEMO: long };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO.length, 250);
    });

    it('keeps MEMO when <= 250 chars', function () {
        const data = { ACTION: 'SEND', MEMO: 'hello' };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO, 'hello');
    });

    it('leaves MEMO null when null', function () {
        const data = { ACTION: 'SEND', MEMO: null };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO, null);
    });

    it('truncates MEMO even for BROADCAST action', function () {
        const long = 'm'.repeat(300);
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: null, FEE: null, MEMO: long };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO.length, 250);
    });

    // ── Unknown action falls through (no ACTION-specific handling) ────────

    it('does not crash on unknown ACTION string', function () {
        const data = { ACTION: 'UNKNOWN', MEMO: 'test' };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO, 'test');
    });

    it('treats null ACTION as UNKNOWN and still normalizes MEMO', function () {
        const long = 'm'.repeat(300);
        const data = { ACTION: null, MEMO: long };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO.length, 250);
    });
});

describe('Database.normalizeDataValues() @regression @tier1', function () {
    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    // ── Return value ──────────────────────────────────────────────────────

    it('returns a copy and never mutates the caller object', function () {
        // AIRDROP's multi-tick loop reuses one `data` across ticks; in-place
        // stringification of TX_OUTPUTS broke fee detection for tick 2+, so
        // normalizeDataValues now operates on a shallow copy.
        const outputs = [{ address: 'addr1', amount: 1 }];
        const data = { AMOUNT: '50', TX_OUTPUTS: outputs };
        const out  = normalize(data);
        assert.notStrictEqual(out, data);
        assert.strictEqual(data.TX_OUTPUTS, outputs);          // caller's array untouched
        assert.strictEqual(typeof out.TX_OUTPUTS, 'string');   // copy got the stringified form
        assert.strictEqual(out.AMOUNT, '50');
    });
});
