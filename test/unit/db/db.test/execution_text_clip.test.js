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

// test/unit/db/db.test/execution_text_clip.test.js
//
// contract_executions.error_message (TEXT, 65,535 bytes) and method_name (VARCHAR(250),
// 250 characters) are clipped to their column capacity before the bind. A contract's
// revert reason reaches error_message verbatim and a wire EXECUTE's METHOD reaches
// method_name verbatim, so without the clip a long value is refused by a strict sql_mode
// session (errno 1406, or 1366 when a byte cut would land inside a UTF-8 character).

'use strict';

const { assert, makeDbLike } = require('./helpers/db.js');

const TEXT_MAX_BYTES     = 65535;
const VARCHAR_250_CHARS  = 250;
const EMOJI              = '\u{1F600}';   // 4 bytes in UTF-8, 2 UTF-16 code units

// Characters as the database counts them: one per code point.
function codePoints(s) { return Array.from(s).length; }

function assertCleanPrefix(out, input) {
    assert.strictEqual(typeof out, 'string');
    assert.ok(out.isWellFormed(), 'clipped value must be well-formed UTF-16');
    assert.ok(input.startsWith(out), 'clipped value must be a prefix of the input');
    assert.ok(!out.includes('�'), 'clip must never leave a replacement character');
}

let normalize;

function bindNormalize() {
    const built = makeDbLike();
    normalize   = built.obj.normalizeDataValues.bind(built.obj);
}

// ── ERROR_MESSAGE: byte capacity of a TEXT column ────────────────────────

describe('Database.normalizeDataValues() ERROR_MESSAGE clip to the TEXT byte capacity @regression @tier1', function () {
    beforeEach(bindNormalize);

    it('ERROR_MESSAGE: clips a 70,008-character ASCII revert reason to the 65,535-byte column capacity', function () {
        const input = 'revert: ' + 'r'.repeat(70000);
        assert.strictEqual(input.length, 70008);
        const out = normalize({ ACTION: 'EXECUTE', ERROR_MESSAGE: input }).ERROR_MESSAGE;
        assertCleanPrefix(out, input);
        assert.strictEqual(Buffer.byteLength(out, 'utf8'), TEXT_MAX_BYTES);
    });

    it('ERROR_MESSAGE: clips an 80,000-byte emoji revert reason on a character boundary', function () {
        const input = 'revert: ' + EMOJI.repeat(20000);
        assert.strictEqual(Buffer.byteLength(input, 'utf8'), 80008);
        const out = normalize({ ACTION: 'EXECUTE', ERROR_MESSAGE: input }).ERROR_MESSAGE;
        assertCleanPrefix(out, input);
        const bytes = Buffer.byteLength(out, 'utf8');
        assert.ok(bytes <= TEXT_MAX_BYTES, 'clipped value is ' + bytes + ' bytes');
        // 8 prefix bytes + the most whole 4-byte characters that fit: 16,381 of them.
        assert.strictEqual(bytes, 8 + 4 * 16381);
    });

    it('ERROR_MESSAGE: steps back off 2- and 3-byte characters that straddle the cut', function () {
        for (const ch of ['é', '€']) {
            const input = 'x' + ch.repeat(40000);
            const out = normalize({ ACTION: 'EXECUTE', ERROR_MESSAGE: input }).ERROR_MESSAGE;
            assertCleanPrefix(out, input);
            const bytes = Buffer.byteLength(out, 'utf8');
            assert.ok(bytes <= TEXT_MAX_BYTES && bytes > TEXT_MAX_BYTES - Buffer.byteLength(ch, 'utf8'));
        }
    });
});

describe('Database.normalizeDataValues() ERROR_MESSAGE clip leaves fitting values alone @regression @tier1', function () {
    beforeEach(bindNormalize);

    it('ERROR_MESSAGE: keeps a value of exactly 65,535 bytes unchanged', function () {
        const input = 'e'.repeat(TEXT_MAX_BYTES);
        const out = normalize({ ACTION: 'EXECUTE', ERROR_MESSAGE: input }).ERROR_MESSAGE;
        assert.strictEqual(out, input);
    });

    it('ERROR_MESSAGE: keeps a short value and a within-capacity lone surrogate unchanged', function () {
        assert.strictEqual(normalize({ ACTION: 'EXECUTE', ERROR_MESSAGE: 'revert: no' }).ERROR_MESSAGE, 'revert: no');
        const lone = 'revert: \uD800 tail';
        assert.strictEqual(normalize({ ACTION: 'EXECUTE', ERROR_MESSAGE: lone }).ERROR_MESSAGE, lone);
    });

    it('ERROR_MESSAGE: leaves null as null and clips the same input to the same value every time', function () {
        assert.strictEqual(normalize({ ACTION: 'EXECUTE', ERROR_MESSAGE: null }).ERROR_MESSAGE, null);
        const input = 'invalid: constructor failed: revert: ' + EMOJI.repeat(17000) + 'r'.repeat(5);
        const a = normalize({ ACTION: 'DEPLOY', ERROR_MESSAGE: input }).ERROR_MESSAGE;
        const b = normalize({ ACTION: 'DEPLOY', ERROR_MESSAGE: input }).ERROR_MESSAGE;
        assert.strictEqual(a, b);
        assertCleanPrefix(a, input);
        assert.ok(Buffer.byteLength(a, 'utf8') <= TEXT_MAX_BYTES);
    });

    it('ERROR_MESSAGE: does not mutate the caller object', function () {
        const input = 'revert: ' + 'r'.repeat(70000);
        const data  = { ACTION: 'EXECUTE', ERROR_MESSAGE: input };
        normalize(data);
        assert.strictEqual(data.ERROR_MESSAGE, input);
    });
});

// ── METHOD_NAME: character capacity of a VARCHAR(250) column ──────────────

describe('Database.normalizeDataValues() METHOD_NAME clip to the VARCHAR(250) character capacity @regression @tier1', function () {
    beforeEach(bindNormalize);

    it('METHOD_NAME: clips a 300-character method name to 250 characters', function () {
        const input = 'm'.repeat(300);
        const out = normalize({ ACTION: 'EXECUTE', METHOD_NAME: input }).METHOD_NAME;
        assert.strictEqual(out, 'm'.repeat(VARCHAR_250_CHARS));
    });

    it('METHOD_NAME: counts a 4-byte character as one and never splits it', function () {
        const fits = EMOJI.repeat(VARCHAR_250_CHARS);
        assert.strictEqual(normalize({ ACTION: 'EXECUTE', METHOD_NAME: fits }).METHOD_NAME, fits);
        const input = 'a' + EMOJI.repeat(300);
        const out = normalize({ ACTION: 'EXECUTE', METHOD_NAME: input }).METHOD_NAME;
        assertCleanPrefix(out, input);
        assert.strictEqual(codePoints(out), VARCHAR_250_CHARS);
    });

    it('METHOD_NAME: keeps a 250-character name, a short name and null unchanged', function () {
        const exact = 'n'.repeat(VARCHAR_250_CHARS);
        assert.strictEqual(normalize({ ACTION: 'EXECUTE', METHOD_NAME: exact }).METHOD_NAME, exact);
        assert.strictEqual(normalize({ ACTION: 'DEPLOY', METHOD_NAME: 'constructor' }).METHOD_NAME, 'constructor');
        assert.strictEqual(normalize({ ACTION: 'EXECUTE', METHOD_NAME: null }).METHOD_NAME, null);
    });
});
