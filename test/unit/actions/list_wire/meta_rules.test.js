// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const {
    metaFieldVerdict,
    resolveMeta,
    isNoChange,
} = require('../../../../src/actions/list/meta_rules.js');

describe('LIST meta rules', function(){
    describe('metaFieldVerdict', function(){
        it('accepts empty and valid fields', function(){
            assert.strictEqual(metaFieldVerdict('NAME', '', 64, true), null);
            assert.strictEqual(metaFieldVerdict('NAME', 'Treasury wallets', 64, true), null);
            assert.strictEqual(metaFieldVerdict('DESCRIPTION', 'Monitored wallets', 512, false), null);
        });

        it('reports each NAME verdict in validation order', function(){
            assert.strictEqual(metaFieldVerdict('NAME', 'a|b', 64, false), 'invalid: NAME (pipe)');
            assert.strictEqual(metaFieldVerdict('NAME', 'a;b', 64, false), 'invalid: NAME (semicolon)');
            assert.strictEqual(metaFieldVerdict('NAME', 'a'.repeat(65), 64, false), 'invalid: NAME (length)');
            assert.strictEqual(metaFieldVerdict('NAME', '\u202Ename', 64, false), 'invalid: NAME (format)');
            assert.strictEqual(metaFieldVerdict('NAME', '|;'.repeat(33), 64, false), 'invalid: NAME (pipe)');
        });

        it('reports each DESCRIPTION verdict', function(){
            assert.strictEqual(metaFieldVerdict('DESCRIPTION', 'a|b', 512, false), 'invalid: DESCRIPTION (pipe)');
            assert.strictEqual(metaFieldVerdict('DESCRIPTION', 'a;b', 512, false), 'invalid: DESCRIPTION (semicolon)');
            assert.strictEqual(metaFieldVerdict('DESCRIPTION', 'a'.repeat(513), 512, false), 'invalid: DESCRIPTION (length)');
            assert.strictEqual(metaFieldVerdict('DESCRIPTION', 'a\nb', 512, false), 'invalid: DESCRIPTION (format)');
        });

        it('measures UTF-8 bytes rather than characters', function(){
            const atLimit = 'a'.repeat(60) + '\u{1F600}';
            assert.strictEqual(Array.from(atLimit).length, 61);
            assert.strictEqual(Buffer.byteLength(atLimit, 'utf8'), 64);
            assert.strictEqual(metaFieldVerdict('NAME', atLimit, 64, false), null);
            assert.strictEqual(metaFieldVerdict('NAME', atLimit + 'a', 64, false), 'invalid: NAME (length)');
        });

        it('refuses untrimmed, bidi, and ill-formed text', function(){
            assert.strictEqual(metaFieldVerdict('NAME', '\u00A0name', 64, false), 'invalid: NAME (format)');
            assert.strictEqual(metaFieldVerdict('NAME', 'na\u202Eme', 64, false), 'invalid: NAME (format)');
            assert.strictEqual(metaFieldVerdict('NAME', 'name\uD800', 64, false), 'invalid: NAME (format)');
        });

        it('refuses the clear sentinel only for create fields', function(){
            assert.strictEqual(metaFieldVerdict('NAME', '-', 64, true), 'invalid: NAME (format)');
            assert.strictEqual(metaFieldVerdict('DESCRIPTION', '-', 512, true), 'invalid: DESCRIPTION (format)');
            assert.strictEqual(metaFieldVerdict('NAME', '-', 64, false), null);
            assert.strictEqual(metaFieldVerdict('DESCRIPTION', '-', 512, false), null);
        });
    });

    describe('resolveMeta', function(){
        it('keeps empty fields unchanged', function(){
            assert.deepStrictEqual(resolveMeta({
                name: 'Old name', description: 'Old description'
            }, '', ''), {
                name: 'Old name', description: 'Old description'
            });
            assert.deepStrictEqual(resolveMeta(null, '', ''), {
                name: null, description: null
            });
        });

        it('clears dashes and applies supplied values', function(){
            assert.deepStrictEqual(resolveMeta({
                name: 'Old name', description: 'Old description'
            }, '-', 'New description'), {
                name: null, description: 'New description'
            });
            assert.deepStrictEqual(resolveMeta({
                name: null, description: null
            }, 'New name', '-'), {
                name: 'New name', description: null
            });
        });

        it('normalizes absent current fields to null', function(){
            assert.deepStrictEqual(resolveMeta({}, '', ''), {
                name: null, description: null
            });
        });
    });

    describe('isNoChange', function(){
        it('is true only when both wire fields are empty', function(){
            assert.strictEqual(isNoChange('', ''), true);
            assert.strictEqual(isNoChange('Name', ''), false);
            assert.strictEqual(isNoChange('', 'Description'), false);
            assert.strictEqual(isNoChange('-', ''), false);
        });
    });
});
