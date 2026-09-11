// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// CONTRACT_META_REQUIRED: the text grammar and the seven-row verdict ladder,
// exercised directly on src/contract_meta.js. The deploy-path half (which string
// a real DEPLOY lands, and what reaches createContract) lives in
// test/unit/actions/deploy-contract-meta.test.js.

const assert = require('assert');
const cm     = require('../../src/contract_meta.js');

// Build the manifest report shape the VM wrapper emits (seam S1) around a meta value.
function report(meta, overrides = {}) {
    let json = null, metaType = 'undefined', metaError = false, metaOversize = false;
    if (meta !== undefined) {
        metaType = meta === null ? 'null' : (Array.isArray(meta) ? 'array' : typeof meta);
        if (metaType === 'object') {
            json = JSON.stringify(meta);
            if (json.length > cm.META_JSON_MAX_CHARS) { metaOversize = true; json = null; }
            else if (json.charAt(0) !== '{')          { metaError = true;    json = null; }
        }
    }
    return {
        success: true,
        error:   null,
        manifest: Object.assign({
            permissions: null, permissionsType: 'undefined',
            maxTakeBps:  null, maxTakeBpsType:  'undefined',
            hasInitialize: false,
            metaType, metaJson: json, metaError, metaOversize
        }, overrides)
    };
}

const GOOD = { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '1.0.0' };

describe('contract_meta text grammar (CONTRACT_META_REQUIRED) @regression @tier1', function () {

    describe('isValidMetaText', function () {

        it('accepts a plain ASCII name inside the cap', function () {
            assert.strictEqual(cm.isValidMetaText('Escrow', 64, false), true);
        });

        it('rejects a non-string', function () {
            for (const v of [undefined, null, 7, true, {}, [], Symbol('x')])
                assert.strictEqual(cm.isValidMetaText(v, 64, false), false, String(typeof v));
        });

        it('rejects the empty string (0 bytes is below the 1-byte floor)', function () {
            assert.strictEqual(cm.isValidMetaText('', 64, false), false);
            assert.strictEqual(cm.isValidMetaText('', 512, true), false);
        });

        it('measures BYTES, not characters: a 64-char multibyte name overflows a 64-byte cap', function () {
            const sixtyFourChars = '\u00E9'.repeat(64);                 // 64 code points, 128 bytes
            assert.strictEqual(sixtyFourChars.length, 64);
            assert.strictEqual(Buffer.byteLength(sixtyFourChars, 'utf8'), 128);
            assert.strictEqual(cm.isValidMetaText(sixtyFourChars, 64, false), false);
            assert.strictEqual(cm.isValidMetaText('\u00E9'.repeat(32), 64, false), true);   // exactly 64 bytes
        });

        it('accepts exactly maxBytes and rejects maxBytes + 1', function () {
            assert.strictEqual(cm.isValidMetaText('a'.repeat(64), 64, false), true);
            assert.strictEqual(cm.isValidMetaText('a'.repeat(65), 64, false), false);
        });

        it('rejects a lone surrogate (not well-formed)', function () {
            assert.strictEqual(cm.isValidMetaText('Escrow\uD800', 64, false), false);
            assert.strictEqual(cm.isValidMetaText('\uDC00Escrow', 64, false), false);
        });

        it('accepts a paired surrogate (an astral character is one code point)', function () {
            assert.strictEqual(cm.isValidMetaText('Escrow \u{1F510}', 64, false), true);
        });

        it('rejects every banned class anywhere in the string', function () {
            const banned = {
                'NUL':          '\u0000',
                'TAB':          '\t',
                'LF':           '\u000A',
                'CR':           '\u000D',
                'DEL':          '\u007F',
                'C1 (U+0085)':  '\u0085',
                'ZWSP':         '\u200B',
                'ZWNJ':         '\u200C',
                'ZWJ':          '\u200D',
                'word joiner':  '\u2060',
                'BOM':          '\uFEFF',
                'LRM':          '\u200E',
                'RLM':          '\u200F',
                'LRE':          '\u202A',
                'RLO':          '\u202E',
                'LRI':          '\u2066',
                'PDI':          '\u2069'
            };
            for (const [label, ch] of Object.entries(banned))
                assert.strictEqual(cm.isValidMetaText('Es' + ch + 'crow', 64, false), false, label + ' must be banned');
        });

        it('admits an interior LF only when allowLf is set', function () {
            assert.strictEqual(cm.isValidMetaText('one\ntwo', 512, true),  true);
            assert.strictEqual(cm.isValidMetaText('one\ntwo', 512, false), false);
        });

        it('rejects a leading or trailing LF even when allowLf is set (LF is an edge code point too)', function () {
            assert.strictEqual(cm.isValidMetaText('\none', 512, true), false);
            assert.strictEqual(cm.isValidMetaText('one\n', 512, true), false);
        });

        it('rejects every EDGE code point at the first or last position, and admits it in the interior', function () {
            const edge = {
                'SPACE':          ' ',
                'NBSP':           '\u00A0',
                'OGHAM SPACE':    '\u1680',
                'EN QUAD':        '\u2000',
                'HAIR SPACE':     '\u200A',
                'LINE SEP':       '\u2028',
                'PARA SEP':       '\u2029',
                'NNBSP':          '\u202F',
                'MMSP':           '\u205F',
                'IDEOGRAPHIC SP': '\u3000'
            };
            for (const [label, ch] of Object.entries(edge)) {
                assert.strictEqual(cm.isValidMetaText(ch + 'Escrow', 64, false), false, 'leading ' + label);
                assert.strictEqual(cm.isValidMetaText('Escrow' + ch, 64, false), false, 'trailing ' + label);
                assert.strictEqual(cm.isValidMetaText('Es' + ch + 'crow', 64, false), true,  'interior ' + label);
            }
        });

        it('does NOT normalise or repair: a conforming value is returned as valid, a non-conforming one is refused outright', function () {
            // The rule rejects; nothing anywhere trims, so the stored bytes are the author's.
            assert.strictEqual(cm.isValidMetaText(' Escrow ', 64, false), false);
            assert.strictEqual(cm.isValidMetaText('Escrow',   64, false), true);
        });

        it('a single edge code point is both the first and the last position and is refused', function () {
            assert.strictEqual(cm.isValidMetaText(' ', 64, false), false);
        });

    });

    describe('evaluateContractMeta ladder', function () {

        it('row 1: a null/undefined read, success:false or manifest:null is (manifest read failed)', function () {
            assert.strictEqual(cm.evaluateContractMeta(null).error, cm.VERDICTS.READ_FAILED);
            assert.strictEqual(cm.evaluateContractMeta(undefined).error, cm.VERDICTS.READ_FAILED);
            assert.strictEqual(cm.evaluateContractMeta({ success: false, manifest: null, error: 'boom' }).error, cm.VERDICTS.READ_FAILED);
            assert.strictEqual(cm.evaluateContractMeta({ success: true, manifest: null, error: null }).error, cm.VERDICTS.READ_FAILED);
        });

        it('row 2: no meta export, and a manifest report from a VM that predates the fields', function () {
            assert.strictEqual(cm.evaluateContractMeta(report(undefined)).error, cm.VERDICTS.REQUIRED);
            assert.strictEqual(cm.evaluateContractMeta({
                success: true, error: null,
                manifest: { permissionsType: 'undefined', maxTakeBpsType: 'undefined', hasInitialize: false }
            }).error, cm.VERDICTS.REQUIRED);
        });

        it('row 3: null, array, function, string, number, boolean and a stringify error are (meta must be a plain object)', function () {
            assert.strictEqual(cm.evaluateContractMeta(report(null)).error,   cm.VERDICTS.NOT_OBJECT);
            assert.strictEqual(cm.evaluateContractMeta(report([1, 2])).error, cm.VERDICTS.NOT_OBJECT);
            assert.strictEqual(cm.evaluateContractMeta(report('Escrow')).error, cm.VERDICTS.NOT_OBJECT);
            assert.strictEqual(cm.evaluateContractMeta(report(7)).error,      cm.VERDICTS.NOT_OBJECT);
            assert.strictEqual(cm.evaluateContractMeta(report(true)).error,   cm.VERDICTS.NOT_OBJECT);
            assert.strictEqual(cm.evaluateContractMeta(report(undefined, { metaType: 'function' })).error, cm.VERDICTS.NOT_OBJECT);
            assert.strictEqual(cm.evaluateContractMeta(report(GOOD, { metaError: true })).error, cm.VERDICTS.NOT_OBJECT);
        });

        it('row 3: a Date serialises to a non-object, which the isolate flags as metaError', function () {
            const r = report(new Date('2026-09-08T00:00:00Z'));
            assert.strictEqual(r.manifest.metaError, true, 'the report builder must mirror the wrapper: a Date is metaError');
            assert.strictEqual(cm.evaluateContractMeta(r).error, cm.VERDICTS.NOT_OBJECT);
        });

        it('row 3: a circular object cannot be serialised, which the isolate flags as metaError', function () {
            const circular = { name: 'Escrow', description: 'Circular' };
            circular.self = circular;
            let threw = false;
            try { JSON.stringify(circular); } catch (e) { threw = true; }
            assert.strictEqual(threw, true, 'the vector must actually be unserialisable');
            assert.strictEqual(cm.evaluateContractMeta(report(undefined, { metaType: 'object', metaJson: null, metaError: true })).error,
                cm.VERDICTS.NOT_OBJECT);
        });

        it('row 3: a well-typed report whose metaJson is missing or unparseable falls to (meta must be a plain object)', function () {
            assert.strictEqual(cm.evaluateContractMeta(report(undefined, { metaType: 'object', metaJson: null })).error, cm.VERDICTS.NOT_OBJECT);
            assert.strictEqual(cm.evaluateContractMeta(report(undefined, { metaType: 'object', metaJson: '{not json' })).error, cm.VERDICTS.NOT_OBJECT);
            // metaType is never trusted alone: an array's JSON is re-checked host-side.
            assert.strictEqual(cm.evaluateContractMeta(report(undefined, { metaType: 'object', metaJson: '[1,2]' })).error, cm.VERDICTS.NOT_OBJECT);
        });

        it('row 4: a 5000-character meta is (meta exceeds 4096 characters)', function () {
            const big = { name: 'Escrow', description: 'Big', filler: 'x'.repeat(5000) };
            const r = report(big);
            assert.strictEqual(r.manifest.metaOversize, true);
            assert.strictEqual(cm.evaluateContractMeta(r).error, cm.VERDICTS.OVERSIZE);
        });

        it('row 5: name missing, non-string, oversize, banned or untrimmed is the name string', function () {
            const vectors = [
                { description: 'no name at all' },
                { name: 7,  description: 'numeric name' },
                { name: '', description: 'empty name' },
                { name: 'a'.repeat(65), description: 'oversize name' },
                { name: 'Esc\u202Erow',  description: 'bidi override in the name' },
                { name: '\u00A0Escrow',  description: 'leading NBSP' },
                { name: 'Escrow ',       description: 'trailing space' }
            ];
            for (const meta of vectors)
                assert.strictEqual(cm.evaluateContractMeta(report(meta)).error, cm.VERDICTS.NAME, JSON.stringify(meta.description));
        });

        it('row 5: a lone surrogate in the name is refused (would re-encode as U+FFFD on the wire)', function () {
            // Built from the report directly: JSON.stringify escapes a lone surrogate, and
            // JSON.parse hands the same lone surrogate back, which is exactly what a real
            // isolate report does.
            const json = JSON.stringify({ name: 'Escrow\uD800', description: 'Lone surrogate' });
            const parsedBack = JSON.parse(json);
            assert.strictEqual(parsedBack.name.isWellFormed(), false, 'the vector must actually survive the round trip as ill-formed');
            assert.strictEqual(cm.evaluateContractMeta(report(undefined, { metaType: 'object', metaJson: json })).error, cm.VERDICTS.NAME);
        });

        it('row 6: description missing, non-string, oversize, banned or untrimmed is the description string', function () {
            const vectors = [
                { name: 'Escrow' },
                { name: 'Escrow', description: 7 },
                { name: 'Escrow', description: '' },
                { name: 'Escrow', description: 'd'.repeat(513) },
                { name: 'Escrow', description: 'bad\u200Bzero width' },
                { name: 'Escrow', description: '\nleading LF' },
                { name: 'Escrow', description: 'trailing LF\n' }
            ];
            for (const meta of vectors)
                assert.strictEqual(cm.evaluateContractMeta(report(meta)).error, cm.VERDICTS.DESCRIPTION, JSON.stringify(meta));
        });

        it('row 6: an INTERIOR LF in the description is valid', function () {
            const out = cm.evaluateContractMeta(report({ name: 'Escrow', description: 'line one\nline two' }));
            assert.strictEqual(out.error, null);
            assert.strictEqual(out.meta.description, 'line one\nline two');
        });

        it('row 7: version present and bad is the version string; version absent is valid with a null version', function () {
            for (const bad of ['', 7, null, 'v'.repeat(33), '1.0.0 ', '1.0\u202E0'])
                assert.strictEqual(cm.evaluateContractMeta(report({ name: 'Escrow', description: 'Escrow', version: bad })).error,
                    cm.VERDICTS.VERSION, JSON.stringify(bad));

            const out = cm.evaluateContractMeta(report({ name: 'Escrow', description: 'Escrow' }));
            assert.strictEqual(out.error, null);
            assert.strictEqual(out.meta.version, null);
        });

        it('first failure wins: a vector bad on rows 5 AND 6 reports the NAME string', function () {
            const out = cm.evaluateContractMeta(report({ name: '', description: '' }));
            assert.strictEqual(out.error, cm.VERDICTS.NAME);
        });

        it('first failure wins: a vector bad on rows 6 AND 7 reports the DESCRIPTION string', function () {
            const out = cm.evaluateContractMeta(report({ name: 'Escrow', description: '', version: '' }));
            assert.strictEqual(out.error, cm.VERDICTS.DESCRIPTION);
        });

        it('first failure wins: an oversize meta whose name is also bad reports the OVERSIZE string', function () {
            const out = cm.evaluateContractMeta(report({ name: '', description: 'x', filler: 'y'.repeat(5000) }));
            assert.strictEqual(out.error, cm.VERDICTS.OVERSIZE);
        });

        it('a conforming meta returns the parsed fields and the isolate JSON verbatim', function () {
            const r   = report(GOOD);
            const out = cm.evaluateContractMeta(r);
            assert.strictEqual(out.error, null);
            assert.deepStrictEqual(out.meta, {
                name:        'Escrow',
                description: 'Two-party escrow with an arbiter',
                version:     '1.0.0',
                json:        r.manifest.metaJson
            });
            assert.strictEqual(out.meta.json, JSON.stringify(GOOD), 'meta_json is the isolate bytes, not a re-serialisation');
        });

        it('unknown keys are allowed, ignored by the verdict and preserved in the stored JSON', function () {
            const out = cm.evaluateContractMeta(report({ name: 'Escrow', description: 'Escrow', author: 'nobody', url: 'x' }));
            assert.strictEqual(out.error, null);
            assert.ok(out.meta.json.includes('"author":"nobody"'));
            assert.ok(out.meta.json.includes('"url":"x"'));
        });

        it('every failing row returns meta:null, so nothing non-conforming can reach a column', function () {
            const failing = [null, report(undefined), report(null), report({ name: '' }), report({ name: 'Escrow', description: '' })];
            for (const r of failing) {
                const out = cm.evaluateContractMeta(r);
                assert.ok(out.error, 'vector must fail');
                assert.strictEqual(out.meta, null);
            }
        });

        it('never throws, whatever shape it is handed', function () {
            const junk = [null, undefined, 0, '', [], { success: true, manifest: 'nope' },
                { success: true, manifest: { metaType: 'object', metaJson: {} } }];
            for (const j of junk)
                assert.doesNotThrow(() => cm.evaluateContractMeta(j), 'threw on ' + JSON.stringify(j));
        });

    });

    describe('the seven strings are frozen consensus tokens', function () {

        it('each verdict string is byte-exact to the spec', function () {
            assert.strictEqual(cm.VERDICTS.READ_FAILED, 'invalid: CONTRACT_MANIFEST (manifest read failed)');
            assert.strictEqual(cm.VERDICTS.REQUIRED,    'invalid: CONTRACT_MANIFEST (meta required)');
            assert.strictEqual(cm.VERDICTS.NOT_OBJECT,  'invalid: CONTRACT_MANIFEST (meta must be a plain object)');
            assert.strictEqual(cm.VERDICTS.OVERSIZE,    'invalid: CONTRACT_MANIFEST (meta exceeds 4096 characters)');
            assert.strictEqual(cm.VERDICTS.NAME,        'invalid: CONTRACT_MANIFEST (meta.name must be a string of 1..64 bytes, printable, trimmed)');
            assert.strictEqual(cm.VERDICTS.DESCRIPTION, 'invalid: CONTRACT_MANIFEST (meta.description must be a string of 1..512 bytes, printable, trimmed)');
            assert.strictEqual(cm.VERDICTS.VERSION,     'invalid: CONTRACT_MANIFEST (meta.version must be a string of 1..32 bytes, printable, trimmed)');
        });

        it('all seven are in the house form and cannot be mutated at runtime', function () {
            for (const [k, v] of Object.entries(cm.VERDICTS))
                assert.ok(/^invalid: CONTRACT_MANIFEST \([a-z][^)]*\)$/.test(v), k + ' is not in the house form: ' + v);
            assert.throws(() => { 'use strict'; cm.VERDICTS.REQUIRED = 'x'; });
        });

        it('the caps named by the strings equal the caps the grammar enforces', function () {
            assert.strictEqual(cm.META_NAME_MAX_BYTES, 64);
            assert.strictEqual(cm.META_DESCRIPTION_MAX_BYTES, 512);
            assert.strictEqual(cm.META_VERSION_MAX_BYTES, 32);
            assert.strictEqual(cm.META_JSON_MAX_CHARS, 4096);
            assert.ok(cm.VERDICTS.NAME.includes('1..' + cm.META_NAME_MAX_BYTES + ' bytes'));
            assert.ok(cm.VERDICTS.DESCRIPTION.includes('1..' + cm.META_DESCRIPTION_MAX_BYTES + ' bytes'));
            assert.ok(cm.VERDICTS.VERSION.includes('1..' + cm.META_VERSION_MAX_BYTES + ' bytes'));
            assert.ok(cm.VERDICTS.OVERSIZE.includes(String(cm.META_JSON_MAX_CHARS)));
        });

    });

});
