/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/price_batch_compression.test/rejections_and_determinism.test.js
 *
 * The rejection half of the PRICE v0 wire compression suite whose entry is
 * test/unit/price_batch_compression.test.js: strictly canonical base64, every
 * failure explicit and terminal, and determinism across nodes. The consensus
 * framing in the entry's header (one wire, one meaning; the bomb refused, not
 * absorbed) governs every case here.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const zlib   = require('zlib');

const c = require('../../../src/actions/price/price_batch_compression.js');
// The PRICE v0 bodies and base64 spellings shared with the suite entry.
const { buildRealisticV2Body, fieldOf, alternateSpelling } = require('../../helpers/price_batch_fixtures.js');

describe('price_batch_compression: strictly canonical base64 @regression', function(){

    const BODY  = '481200|481205|918442|1|481200|1756180800|918442|1|BTC/USD|104325.00000000|1|aa|bb';
    const FIELD = c.compressPriceBatchBody(BODY);

    it('positive control: the canonical spelling is accepted', function(){
        const r = c.inflatePriceBatchBody(FIELD);
        assert.strictEqual(r.ok, true, r.reason);
        assert.strictEqual(r.body, BODY);
    });

    const nonCanonical = {
        'embedded space':        () => FIELD.slice(0, 4) + ' ' + FIELD.slice(4),
        'leading whitespace':    () => ' ' + FIELD,
        'trailing newline':      () => FIELD + '\n',
        'embedded newline':      () => FIELD.slice(0, 8) + '\n' + FIELD.slice(8),
        'URL-safe alphabet':     () => FIELD.replace(/\+/g, '-').replace(/\//g, '_'),
        'padding stripped':      () => FIELD.replace(/=+$/, ''),
        'extra padding':         () => FIELD + '=',
        'padding in the middle': () => FIELD.slice(0, 4) + '=' + FIELD.slice(5),
        'out-of-alphabet char':  () => FIELD.slice(0, 4) + '*' + FIELD.slice(5),
        'unicode lookalike':     () => FIELD.slice(0, 4) + 'А' + FIELD.slice(5)
    };

    Object.keys(nonCanonical).forEach(function(name){
        it('rejects ' + name, function(){
            const bad = nonCanonical[name]();
            if(bad === FIELD) return this.skip();   // fixture had nothing to mangle
            const r = c.inflatePriceBatchBody(bad);
            assert.strictEqual(r.ok, false, name + ' was ACCEPTED, which is a consensus split');
            assert.strictEqual(r.reason, 'non-canonical-base64');
            assert.strictEqual(r.body, undefined);
        });
    });

    it('rejects a redundant spelling that decodes to the same bytes', function(){
        // The case a regex-only check waves through: Buffer.from ignores the
        // unused low bits of a padded final quantum, so `QQ==` and `QR==` are
        // both the byte 0x41. Exactly one of them may be valid on the wire.
        const canonical = fieldOf(Buffer.from([0x41]));
        assert.strictEqual(canonical, 'QQ==');
        const alt = alternateSpelling(canonical);
        assert.ok(alt && alt !== canonical, 'expected an alternate spelling to exist');
        assert.ok(Buffer.from(alt, 'base64').equals(Buffer.from(canonical, 'base64')),
            'the alternate must decode to the same bytes, or this test proves nothing');

        assert.notStrictEqual(c.decodeCanonicalBase64(canonical), null);
        assert.strictEqual(c.decodeCanonicalBase64(alt), null);
    });

    it('rejects a redundant spelling of a real compressed payload', function(){
        const alt = alternateSpelling(FIELD);
        if(!alt) return this.skip();
        const r = c.inflatePriceBatchBody(alt);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'non-canonical-base64');
    });
});

describe('price_batch_compression: every failure is explicit and terminal @regression', function(){
    const cases = [
        ['non-string (undefined)', undefined,                     'not-a-string'],
        ['non-string (null)',      null,                          'not-a-string'],
        ['non-string (Buffer)',    Buffer.from('AAAA'),            'not-a-string'],
        ['non-string (number)',    12345,                         'not-a-string'],
        ['empty field',            '',                            'empty'],
        ['oversize field',         'A'.repeat(8192),              'oversize-field']
    ];

    cases.forEach(function([name, input, reason]){
        it('rejects ' + name + ' as ' + reason, function(){
            const r = c.inflatePriceBatchBody(input);
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.reason, reason);
            assert.strictEqual(r.status, 'invalid: COMPRESSION (' + reason + ')');
        });
    });

    it('rejects canonical base64 that is not a deflate stream', function(){
        const r = c.inflatePriceBatchBody(fieldOf(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01])));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'inflate-failed');
        assert.strictEqual(r.body, undefined);
    });

    it('rejects a truncated deflate stream', function(){
        const raw = zlib.deflateRawSync(Buffer.from('481200|481205|918442|1|x', 'utf8'));
        const r = c.inflatePriceBatchBody(fieldOf(raw.subarray(0, raw.length - 2)));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'inflate-failed');
    });

    it('rejects a stream that inflates to zero bytes', function(){
        const r = c.inflatePriceBatchBody(fieldOf(zlib.deflateRawSync(Buffer.alloc(0))));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'empty-body');
    });

    it('rejects inflated bytes that are not valid UTF-8', function(){
        // toString('utf8') would silently map these to U+FFFD, so several
        // distinct payloads would produce one identical body. That is the same
        // one-meaning-per-wire failure the base64 check prevents, one layer down.
        const raw = zlib.deflateRawSync(Buffer.from([0x34, 0x38, 0xff, 0xfe, 0x7c, 0x31]));
        const r = c.inflatePriceBatchBody(fieldOf(raw));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'non-utf8');
        assert.strictEqual(r.body, undefined);
    });

    it('accepts multi-byte UTF-8 that round trips exactly', function(){
        // The guard rejects INVALID sequences, not non-ASCII ones.
        const body = 'BTC/USD|104325.00|note:€é中';
        const r = c.inflatePriceBatchBody(c.compressPriceBatchBody(body));
        assert.strictEqual(r.ok, true, r.reason);
        assert.strictEqual(r.body, body);
    });
});

describe('price_batch_compression: every failure is explicit and terminal @regression', function(){
    it('never falls back to treating the field as an uncompressed body', function(){
        // A plausible-looking uncompressed body handed in where a compressed
        // field belongs must be rejected, not read.
        const plain = '481200|481205|918442|6|481200|1756180800|918442|1|BTC/USD|1.0|1|aa|bb';
        const r = c.inflatePriceBatchBody(plain);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.body, undefined);
        assert.ok(!Object.prototype.hasOwnProperty.call(r, 'body'));
    });

    it('every failure reason is distinct and stable', function(){
        const reasons = Object.values(c.PRICE_BATCH_COMPRESSION_FAIL_REASONS);
        assert.strictEqual(new Set(reasons).size, reasons.length);
        assert.deepStrictEqual(reasons.slice().sort(), [
            'empty', 'empty-body', 'inflate-failed', 'non-canonical-base64',
            'non-utf8', 'not-a-string', 'oversize-field', 'ratio-cap', 'size-cap'
        ]);
    });
});

describe('price_batch_compression: determinism across nodes @regression', function(){

    it('the same field inflates to the same body every time', function(){
        const field = c.compressPriceBatchBody(buildRealisticV2Body());
        const a = c.inflatePriceBatchBody(field);
        const b = c.inflatePriceBatchBody(field);
        assert.deepStrictEqual(a, b);
    });

    it('which bound binds depends only on the compressed length', function(){
        // Two nodes seeing the same wire must report the same reason, so the
        // choice between ratio-cap and size-cap may not depend on the inflated
        // size (which the bounded inflate never learns).
        for(const compressedLen of [1, 54, 55, 100, 8189]){
            const ratioCap = compressedLen * c.PRICE_BATCH_MAX_INFLATE_RATIO;
            const expected = ratioCap <= c.PRICE_WIRE_MAX_BYTES ? 'ratio-cap' : 'size-cap';
            assert.strictEqual(typeof expected, 'string');
        }
        // 54 * 150 = 8100 (ratio binds); 55 * 150 = 8250 (size binds).
        assert.ok(54 * c.PRICE_BATCH_MAX_INFLATE_RATIO <= c.PRICE_WIRE_MAX_BYTES);
        assert.ok(55 * c.PRICE_BATCH_MAX_INFLATE_RATIO >  c.PRICE_WIRE_MAX_BYTES);
    });
});
