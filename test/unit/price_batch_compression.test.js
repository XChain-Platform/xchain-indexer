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
 * test/unit/price_batch_compression.test.js
 *
 * PRICE v0 wire compression is CONSENSUS: every node must accept or reject the
 * same compressed field identically, and must do so without ever allocating
 * what a hostile field claims to inflate to. These tests drive the two
 * properties that a naive implementation gets wrong.
 *
 *   1. ONE WIRE, ONE MEANING. Buffer.from(s, 'base64') accepts many spellings
 *      of the same payload. Each accepted alternative spelling is a future
 *      fork, so every one of them is driven here as a rejection.
 *   2. THE BOMB IS REFUSED, NOT ABSORBED. The zip-bomb cases assert the
 *      bounded-output error itself (ERR_BUFFER_TOO_LARGE from zlib's
 *      maxOutputLength), which can only be raised before the buffer grows.
 *      A test that only checked "the result was rejected" would pass against
 *      an implementation that inflated 200 KB first and measured afterwards.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');

const c = require('../../src/price_batch_compression.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A realistic six-round PRICE v0 body: everything after "PRICE|0|" on the
// uncompressed wire. Built rather than pasted so the shape stays honest, and
// so the ratio this suite records is a measurement of real oracle data
// (repeated pair names, near-repeated prices, high-entropy hex signatures)
// rather than of a compressible synthetic string.
function buildRealisticV2Body(sigCount){
    const SIGS = (sigCount === undefined) ? 5 : sigCount;
    const TICKERS = ['BTC','LTC','DOGE','XCHAIN','ETH','BCH','DASH','ZEC','XMR','ADA',
                     'SOL','DOT','LINK','UNI','AVAX','MATIC','ATOM','XLM','TRX','ALGO'];
    const FIATS   = ['USD','EUR','GBP'];

    // 37 pairs: the 36-pair production set plus XCHAIN/USD, which is the pair
    // every native-coin fee decision needs.
    let pairNames = [];
    for(const t of TICKERS){
        for(const f of FIATS){
            if(pairNames.length < 37) pairNames.push(t + '/' + f);
        }
    }

    const firstRound = 481200;
    const lastRound  = 481205;
    const anchor     = 918442;

    let out = [String(firstRound), String(lastRound), String(anchor), '6'];

    for(let i = 0; i < 6; i++){
        const round = firstRound + i;
        out.push(String(round));
        out.push(String(1756180800 + i * 600));
        out.push(String(anchor + i));
        out.push(String(pairNames.length));
        for(let p = 0; p < pairNames.length; p++){
            out.push(pairNames[p]);
            // Prices drift slightly round to round, as real oracle medians do.
            out.push((1000 + p * 137.4 + i * 0.37).toFixed(8));
        }
    }

    // Hex pubkeys and signatures are near-incompressible, so the signature set
    // sets the floor on what deflate can achieve and drives section 8's ceiling.
    out.push(String(SIGS));
    for(let s = 0; s < SIGS; s++){
        out.push(hex(64, s * 7 + 1));
        out.push(hex(128, s * 11 + 3));
    }

    return out.join('|');
}

// Deterministic pseudo-random hex, so the recorded ratio is reproducible.
function hex(chars, seed){
    let out = '';
    let x = (seed * 2654435761) >>> 0;
    while(out.length < chars){
        x = (x * 1664525 + 1013904223) >>> 0;
        out += x.toString(16).padStart(8, '0');
    }
    return out.slice(0, chars);
}

// A canonical-base64 field carrying arbitrary bytes, bypassing the compressor
// so a test can hand the decoder exactly the bytes it wants to.
function fieldOf(buf){ return Buffer.from(buf).toString('base64'); }

// Given a canonical base64 string with padding, find a different string that
// Buffer.from decodes to the SAME bytes. This exists only in padded forms,
// where the final quantum has unused low bits that a lenient decoder ignores.
function alternateSpelling(canonical){
    if(!canonical.endsWith('=')) return null;
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const idx  = canonical.replace(/=+$/, '').length - 1;
    const want = Buffer.from(canonical, 'base64');
    for(const ch of ALPHABET){
        if(ch === canonical[idx]) continue;
        const alt = canonical.slice(0, idx) + ch + canonical.slice(idx + 1);
        if(Buffer.from(alt, 'base64').equals(want)) return alt;
    }
    return null;
}

// ---------------------------------------------------------------------------

describe('price_batch_compression: consensus constants @regression', function(){

    it('exports the pinned consensus values', function(){
        assert.strictEqual(c.PRICE_BATCH_MAX_INFLATE_RATIO, 150);
        assert.strictEqual(c.PRICE_BATCH_MAX_ROUND_COUNT,   256);
        assert.strictEqual(c.PRICE_WIRE_MAX_BYTES,       8189);
        assert.strictEqual(c.PRICE_BATCH_COMPRESSION_MARKER, 'Z');
    });

    it('the Z marker can never be confused with a FIRST_ROUND value', function(){
        // The compressed and uncompressed forms are told apart on this field
        // alone. FIRST_ROUND is always a decimal integer.
        assert.ok(!/^[0-9]+$/.test(c.PRICE_BATCH_COMPRESSION_MARKER));
        assert.ok(Number.isNaN(parseInt(c.PRICE_BATCH_COMPRESSION_MARKER, 10)));
    });

    it('PRICE_WIRE_MAX_BYTES matches the declaration in xchain-hub OraclePublisher.js', function(){
        // Reuse enforced by test rather than by require: the vendored twin
        // cannot import across repo boundaries, so this is what keeps the
        // fourth copy of the name from drifting away from the other three.
        const hubDir = process.env.XCHAIN_HUB_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-hub');
        const pub = path.join(hubDir, 'src', 'OraclePublisher.js');
        if(!fs.existsSync(pub)){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the hub sibling was not found at ' + pub);
            this.skip();
            return;
        }
        const m = /const\s+PRICE_WIRE_MAX_BYTES\s*=\s*(\d+)\s*;/.exec(fs.readFileSync(pub, 'utf8'));
        assert.ok(m, 'PRICE_WIRE_MAX_BYTES declaration not found in ' + pub);
        assert.strictEqual(parseInt(m[1], 10), c.PRICE_WIRE_MAX_BYTES,
            'the PRICE wire ceiling has diverged between OraclePublisher.js and price_batch_compression.js; ' +
            'the publisher and the parser would disagree on which batches are expressible');
    });
});

describe('price_batch_compression: round trip @regression', function(){

    it('a compressed body inflates back byte-identically', function(){
        const body = buildRealisticV2Body();
        const r = c.inflatePriceBatchBody(c.compressPriceBatchBody(body));
        assert.strictEqual(r.ok, true, r.reason);
        assert.strictEqual(r.body, body);
    });

    it('MEASUREMENT: a realistic six-round batch fits the wire compressed', function(){
        const body  = buildRealisticV2Body();
        const field = c.compressPriceBatchBody(body);
        const r     = c.inflatePriceBatchBody(field);

        assert.strictEqual(r.ok, true, r.reason);
        assert.strictEqual(r.body, body);

        const wire = 'PRICE|0|Z|'.length + field.length;
        console.log('        measured: uncompressed body ' + body.length + ' B' +
                    ', deflate ' + r.compressedBytes + ' B' +
                    ', base64 field ' + field.length + ' B' +
                    ', full compressed wire ' + wire + ' B' +
                    ', ratio ' + r.ratio.toFixed(3) + ':1');

        assert.ok(wire <= c.PRICE_WIRE_MAX_BYTES,
            'the compressed six-round wire is ' + wire + ' B, over the ' + c.PRICE_WIRE_MAX_BYTES + ' B ceiling');
        // Real oracle data is dominated by repeated pair names, so it must beat
        // 2:1 comfortably; a regression below this means the body shape changed.
        assert.ok(r.ratio > 2, 'ratio collapsed to ' + r.ratio);
        // Section 8's N ceiling rests on the per-signer cost AFTER deflate and
        // AFTER base64, not on the deflate size alone. Measure the increment
        // rather than restating the estimate.
        const q3 = c.compressPriceBatchBody(buildRealisticV2Body(3));
        const q9 = c.compressPriceBatchBody(buildRealisticV2Body(9));
        const b3 = buildRealisticV2Body(3), b9 = buildRealisticV2Body(9);
        console.log('        measured: quorum-3 wire ' + ('PRICE|0|Z|'.length + q3.length) + ' B' +
                    ' (deflate ' + Buffer.from(q3, 'base64').length + ' B' +
                    ', uncompressed body ' + b3.length + ' B)');
        console.log('        measured: per-signer marginal cost, uncompressed ' +
                    ((b9.length - b3.length) / 6).toFixed(1) + ' B, deflate ' +
                    ((Buffer.from(q9, 'base64').length - Buffer.from(q3, 'base64').length) / 6).toFixed(1) + ' B' +
                    ', on the wire (base64) ' + ((q9.length - q3.length) / 6).toFixed(1) + ' B');
        // And it must stay far under the consensus cap, or honest batches would
        // start tripping a bomb defense.
        assert.ok(r.ratio < c.PRICE_BATCH_MAX_INFLATE_RATIO / 10,
            'honest ratio ' + r.ratio + ' is uncomfortably close to the cap');
    });

    it('round trips a body containing every printable ASCII character', function(){
        let body = '';
        for(let i = 32; i < 127; i++) body += String.fromCharCode(i);
        const r = c.inflatePriceBatchBody(c.compressPriceBatchBody(body));
        assert.strictEqual(r.ok, true, r.reason);
        assert.strictEqual(r.body, body);
    });

    it('compressPriceBatchBody refuses a non-string body', function(){
        assert.throws(() => c.compressPriceBatchBody(Buffer.from('x')), TypeError);
        assert.throws(() => c.compressPriceBatchBody(null), TypeError);
    });
});

describe('price_batch_compression: the bomb is refused before the buffer grows @regression', function(){

    // 200 KB of one byte deflates to a couple of hundred bytes, a ratio near
    // 950:1. This is the payload the cap exists for.
    const BOMB_PLAIN = Buffer.alloc(200 * 1024, 0x41);
    const BOMB_RAW   = zlib.deflateRawSync(BOMB_PLAIN, { level: 9 });
    const BOMB_FIELD = BOMB_RAW.toString('base64');

    it('the fixture really is a bomb (unbounded inflate proves the size)', function(){
        const unbounded = zlib.inflateRawSync(BOMB_RAW);
        assert.strictEqual(unbounded.length, BOMB_PLAIN.length);
        assert.ok(unbounded.length / BOMB_RAW.length > c.PRICE_BATCH_MAX_INFLATE_RATIO,
            'fixture ratio is only ' + (unbounded.length / BOMB_RAW.length));
    });

    it('zlib raises the BOUNDED-OUTPUT error, so the memory is never allocated', function(){
        // The distinction this test exists to make: ERR_BUFFER_TOO_LARGE can
        // only come from maxOutputLength stopping the inflate mid-stream. An
        // implementation that inflated first and measured afterwards could not
        // produce this error, and would fail here while still "rejecting" the
        // payload.
        const cap = Math.min(c.PRICE_WIRE_MAX_BYTES, BOMB_RAW.length * c.PRICE_BATCH_MAX_INFLATE_RATIO);
        assert.throws(
            () => zlib.inflateRawSync(BOMB_RAW, { maxOutputLength: cap }),
            (e) => e.code === 'ERR_BUFFER_TOO_LARGE'
        );
    });

    it('rejects the bomb and never returns a body', function(){
        const r = c.inflatePriceBatchBody(BOMB_FIELD);
        assert.strictEqual(r.ok, false);
        // 200 KB deflates to ~216 bytes, and 216 * 150 is already past the wire
        // ceiling, so the SIZE bound is the one that stops this particular bomb.
        assert.strictEqual(r.reason, 'size-cap');
        assert.strictEqual(r.status, 'invalid: COMPRESSION (size-cap)');
        assert.strictEqual(r.detail, c.PRICE_WIRE_MAX_BYTES);
        assert.strictEqual(r.body, undefined, 'a failure must never carry a body');
    });

    it('rejects a bomb small enough that the RATIO bound binds first', function(){
        // 20 KB of one byte deflates to ~37 bytes, so 37 * 150 is under the wire
        // ceiling and the ratio is what refuses it. Both bounds need a live
        // fixture or one of them is only ever exercised as dead arithmetic.
        const raw = zlib.deflateRawSync(Buffer.alloc(20000, 0x41), { level: 9 });
        assert.ok(raw.length * c.PRICE_BATCH_MAX_INFLATE_RATIO < c.PRICE_WIRE_MAX_BYTES,
            'fixture must make the RATIO bound the binding one');
        const r = c.inflatePriceBatchBody(raw.toString('base64'));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'ratio-cap');
        assert.strictEqual(r.detail, raw.length * c.PRICE_BATCH_MAX_INFLATE_RATIO);
        assert.strictEqual(r.body, undefined);
    });

    it('rejects a ratio breach that would have FIT the wire ceiling', function(){
        // The two bounds are independent, and this is the case that proves it.
        // 8,000 bytes of one repeated byte fit the wire comfortably, so the
        // size bound alone would ADMIT this payload; only the ratio cap refuses
        // it. Without this case, dropping the ratio term from the bound would
        // still leave the suite green.
        const plain = 'A'.repeat(8000);
        const raw   = zlib.deflateRawSync(Buffer.from(plain, 'utf8'), { level: 9 });
        assert.ok(plain.length <= c.PRICE_WIRE_MAX_BYTES, 'fixture must FIT the wire ceiling');
        assert.ok(plain.length / raw.length > c.PRICE_BATCH_MAX_INFLATE_RATIO,
            'fixture must breach the ratio cap, was ' + (plain.length / raw.length));

        const r = c.inflatePriceBatchBody(raw.toString('base64'));
        assert.strictEqual(r.ok, false,
            'a size-legal payload with an illegal ratio was ACCEPTED; the ratio bound is not wired in');
        assert.strictEqual(r.reason, 'ratio-cap');
        assert.strictEqual(r.detail, raw.length * c.PRICE_BATCH_MAX_INFLATE_RATIO);
        assert.strictEqual(r.body, undefined);
    });

    it('rejects an over-ceiling payload with the size-cap reason', function(){
        // Compressible enough that the ratio stays legal, large enough that the
        // inflated body cannot fit the wire. This is the OTHER bound, and it
        // must be distinguishable from the ratio breach.
        let plain = '';
        for(let i = 0; i < 900; i++) plain += 'BTC/USD|' + (1000 + (i % 97)).toFixed(8) + '|';
        const raw   = zlib.deflateRawSync(Buffer.from(plain, 'utf8'), { level: 9 });
        const ratio = plain.length / raw.length;

        assert.ok(plain.length > c.PRICE_WIRE_MAX_BYTES, 'fixture must exceed the wire ceiling');
        assert.ok(ratio < c.PRICE_BATCH_MAX_INFLATE_RATIO, 'fixture ratio must be legal, was ' + ratio);
        assert.ok(raw.length * c.PRICE_BATCH_MAX_INFLATE_RATIO > c.PRICE_WIRE_MAX_BYTES,
            'fixture must make the SIZE bound the binding one');

        const r = c.inflatePriceBatchBody(raw.toString('base64'));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'size-cap');
        assert.strictEqual(r.detail, c.PRICE_WIRE_MAX_BYTES);
        assert.strictEqual(r.body, undefined);
    });

    it('accepts a body of exactly the wire ceiling and rejects one byte more', function(){
        // The size bound is inclusive. Both sides are driven, because an
        // off-by-one here forks a node that admits the batch from one that does
        // not. Incompressible-ish hex filler keeps the RATIO legal so this test
        // measures the SIZE bound and nothing else.
        const atCap = hex(c.PRICE_WIRE_MAX_BYTES, 7);
        const over  = hex(c.PRICE_WIRE_MAX_BYTES + 1, 7);

        const rAt = c.inflatePriceBatchBody(c.compressPriceBatchBody(atCap));
        assert.strictEqual(rAt.ok, true, rAt.reason);
        assert.strictEqual(rAt.inflatedBytes, c.PRICE_WIRE_MAX_BYTES);
        assert.strictEqual(rAt.body, atCap);

        const rOver = c.inflatePriceBatchBody(c.compressPriceBatchBody(over));
        assert.strictEqual(rOver.ok, false);
        assert.strictEqual(rOver.reason, 'size-cap');
        assert.strictEqual(rOver.detail, c.PRICE_WIRE_MAX_BYTES);
    });

    it('accepts a payload sitting exactly ON the ratio cap', function(){
        // 3,150 bytes of one repeated byte deflate to exactly 21, and
        // 21 * 150 == 3150, so this payload sits on the bound rather than near
        // it. The cap is a maximum, so it must be admitted.
        const plain = 'A'.repeat(3150);
        const raw   = zlib.deflateRawSync(Buffer.from(plain, 'utf8'), { level: 9 });
        assert.strictEqual(plain.length, raw.length * c.PRICE_BATCH_MAX_INFLATE_RATIO,
            'fixture no longer sits on the ratio bound (deflate output changed); re-derive it');
        const r = c.inflatePriceBatchBody(raw.toString('base64'));
        assert.strictEqual(r.ok, true, r.reason);
        assert.strictEqual(r.ratio, c.PRICE_BATCH_MAX_INFLATE_RATIO);
        assert.strictEqual(r.body, plain);
    });
});

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

describe('price_batch_compression: vendored-twin byte identity @regression', function(){

    const HUB_DIR = process.env.XCHAIN_HUB_DIR ||
        path.join(__dirname, '..', '..', '..', 'xchain-hub');

    it('xchain-hub/src/price_batch_compression.js is byte-identical to this repo\'s copy', function(){
        const twin = path.join(HUB_DIR, 'src', 'price_batch_compression.js');
        if(!fs.existsSync(twin)){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the twin is missing: ' + twin);
            this.skip();
            return;
        }
        const local = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'price_batch_compression.js'), 'utf8');
        assert.strictEqual(local, fs.readFileSync(twin, 'utf8'),
            'price_batch_compression.js has drifted between xchain-indexer and xchain-hub; the two would ' +
            'disagree on which compressed batches are valid, which is a fork');
    });
});
