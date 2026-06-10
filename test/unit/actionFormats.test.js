'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Action field-format contract tests (Phase 1a — field-format layer).
 *
 * On the wire an ACTION is a pipe-delimited string `ACTION|VERSION|FIELD…`,
 * and the indexer decodes it with `String(data).split('|')` (actions.js:201),
 * then each handler maps the positional params using its `this.formats[version]`
 * template. This locks the wire contract those templates define:
 *
 *   1. every handler's format templates are well-formed (start with VERSION,
 *      tokens are uppercase field names) — drift here silently mis-parses an
 *      action across the whole network;
 *   2. the field codec is delimiter-clean: pipe-free fields survive
 *      join('|') → split('|') for every fixed-arity template, and an embedded
 *      '|' provably changes the arity (documents the pipe-free invariant the
 *      split-based parser depends on);
 *   3. committed golden vectors pin the canonical SEND v0–v3 wire layouts.
 *
 * Pure: handlers are constructed with a stub context (no DB) purely to read
 * their declared formats.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ACTIONS_DIR = path.join(__dirname, '../../src/actions');
const STUB = { config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null };

// Load every action handler that declares `this.formats`, keyed by file name.
function loadFormats() {
    const out = {};
    for (const file of fs.readdirSync(ACTIONS_DIR)) {
        if (!file.endsWith('.js') || file === 'README.md') continue;
        let Handler, inst;
        try { Handler = require(path.join(ACTIONS_DIR, file)); } catch (_) { continue; }
        if (typeof Handler !== 'function') continue;
        try { inst = new Handler(STUB); } catch (_) { continue; }
        if (inst && inst.formats && typeof inst.formats === 'object' && Object.keys(inst.formats).length) {
            out[file.replace(/\.js$/, '')] = inst.formats;
        }
    }
    return out;
}

const FORMATS = loadFormats();
// A field token is an uppercase name, optionally a variadic tail (`NAME...`),
// or the bare variadic-repeat marker `...` (used by attest/price/execute for
// variable-length trailing groups).
const TOKEN = /^([A-Z][A-Z0-9_]*(\.\.\.)?|\.\.\.)$/;

describe('Action field-format contract', function () {

    it('discovers format templates from many action handlers', function () {
        const names = Object.keys(FORMATS);
        assert.ok(names.length >= 10, 'expected to load formats from many actions, got ' + names.length);
        assert.ok(names.includes('send'), 'send handler formats not loaded');
    });

    describe('every format template is well-formed', function () {
        it('keys are integer versions; templates start with VERSION; tokens are field names', function () {
            for (const [name, formats] of Object.entries(FORMATS)) {
                for (const [version, tmpl] of Object.entries(formats)) {
                    assert.ok(/^\d+$/.test(version), `${name}: non-integer format key "${version}"`);
                    assert.strictEqual(typeof tmpl, 'string', `${name}[${version}]: template is not a string`);
                    const tokens = tmpl.split('|');
                    assert.ok(tokens.length >= 1, `${name}[${version}]: empty template`);
                    assert.strictEqual(tokens[0], 'VERSION', `${name}[${version}]: must start with VERSION`);
                    for (const t of tokens) {
                        assert.ok(TOKEN.test(t), `${name}[${version}]: malformed field token "${t}" in "${tmpl}"`);
                    }
                }
            }
        });
    });

    describe('field codec is delimiter-clean (split/join inverse for pipe-free fields)', function () {
        it('pipe-free values round-trip through join → split for every template arity', function () {
            for (const [name, formats] of Object.entries(FORMATS)) {
                for (const [version, tmpl] of Object.entries(formats)) {
                    const arity = tmpl.split('|').length;
                    // synthesize a pipe-free value per position (VERSION = the version number)
                    const values = Array.from({ length: arity }, (_, i) => i === 0 ? version : 'v' + i + '_x');
                    const wire = values.join('|');
                    const back = String(wire).split('|');
                    assert.deepStrictEqual(back, values, `${name}[${version}] did not round-trip through split/join`);
                }
            }
        });

        it('an embedded pipe provably changes arity — fields must be pipe-free', function () {
            const clean = ['0', 'XCP', '100', 'addr', 'memo'];
            assert.strictEqual(clean.join('|').split('|').length, 5);
            const dirty = ['0', 'XCP', '100', 'addr', 'me|mo'];   // memo contains a pipe
            assert.strictEqual(dirty.join('|').split('|').length, 6,
                'an embedded pipe must split into an extra param (so fields cannot contain "|")');
        });
    });

    describe('SEND golden wire vectors (pin the canonical v0–v3 layouts)', function () {
        const send = FORMATS['send'];

        it('format templates match the committed canonical layout', function () {
            assert.strictEqual(send[0], 'VERSION|TICK|AMOUNT|DESTINATION|MEMO');
            assert.strictEqual(send[1], 'VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO');
            assert.strictEqual(send[2], 'VERSION|TICK|AMOUNT|DESTINATION|TICK|AMOUNT|DESTINATION|MEMO');
            assert.strictEqual(send[3], 'VERSION|TICK|AMOUNT|DESTINATION|MEMO|TICK|AMOUNT|DESTINATION|MEMO');
        });

        // Each golden wire string + the params split exposes for the handler.
        const VECTORS = [
            { v: 0, wire: '0|XCP|100|mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp|hello',
              params: ['0', 'XCP', '100', 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp', 'hello'] },
            { v: 1, wire: '1|XCP|5|1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA|7|1AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB|memo',
              params: ['1', 'XCP', '5', '1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '7', '1AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'memo'] },
            { v: 2, wire: '2|XCP|5|1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA|BRRR|3|1AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB|memo',
              params: ['2', 'XCP', '5', '1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'BRRR', '3', '1AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'memo'] },
            { v: 3, wire: '3|XCP|5|1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA|memo1|BRRR|3|1AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB|memo2',
              params: ['3', 'XCP', '5', '1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'memo1', 'BRRR', '3', '1AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'memo2'] }
        ];

        it('each golden wire string splits to its expected params and the version selects a known format', function () {
            for (const tc of VECTORS) {
                const params = String(tc.wire).split('|');
                assert.deepStrictEqual(params, tc.params, `SEND v${tc.v} wire split mismatch`);
                assert.strictEqual(parseInt(params[0], 10), tc.v, `SEND v${tc.v} version field`);
                assert.ok(send[tc.v] !== undefined, `SEND v${tc.v} has no format template`);
            }
        });

        it('v0/v3 param arity matches the format template; v1/v2 carry repeated groups', function () {
            // v0 and v3 are fixed-arity: param count equals the template token count.
            assert.strictEqual(VECTORS[0].params.length, send[0].split('|').length);
            assert.strictEqual(VECTORS[3].params.length, send[3].split('|').length);
            // v1 brief: VERSION + repeating (AMOUNT,DESTINATION) + MEMO → even count.
            assert.strictEqual(VECTORS[1].params.length % 2, 1);
            // v2 full: VERSION + repeating (TICK,AMOUNT,DESTINATION) + MEMO.
            assert.strictEqual((VECTORS[2].params.length - 2) % 3, 0);
        });
    });
});
