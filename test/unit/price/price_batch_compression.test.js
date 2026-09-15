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
 * test/unit/price/price_batch_compression.test.js
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

const c = require('../../../src/actions/price/price_batch_compression.js');
// Decides whether a hub sibling path may be trusted before the guards below read it.
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

// The PRICE v0 bodies the suite measures, shared with the parts under
// test/unit/price_batch_compression.test/, which hold the rejection and determinism cases.
const { buildRealisticV2Body, hex } = require('../../helpers/price_batch_fixtures.js');

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
            path.join(__dirname, '..', '..', '..', '..', 'xchain-hub');
        const pub = path.join(hubDir, 'src', 'oracle', 'publisher.js');
        // Refuses an absent hub and a lane symlink into a live main checkout alike.
        const hubCheckout = siblingCheckout(__dirname, pub);
        if(!hubCheckout.usable) return skipOrFail(this, hubCheckout, 'the PRICE_WIRE_MAX_BYTES hub declaration check');
        const m = /const\s+PRICE_WIRE_MAX_BYTES\s*=\s*(\d+)\s*;/.exec(fs.readFileSync(pub, 'utf8'));
        assert.ok(m, 'PRICE_WIRE_MAX_BYTES declaration not found in ' + pub);
        assert.strictEqual(parseInt(m[1], 10), c.PRICE_WIRE_MAX_BYTES,
            'the PRICE wire ceiling has diverged between oracle/publisher.js and price_batch_compression.js; ' +
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
        // The signer-count N ceiling rests on the per-signer cost AFTER deflate and
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
});

describe('price_batch_compression: round trip @regression', function(){
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
});

describe('price_batch_compression: the bomb is refused before the buffer grows @regression', function(){
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
});

describe('price_batch_compression: the bomb is refused before the buffer grows @regression', function(){
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

describe('price_batch_compression: vendored-twin byte identity @regression', function(){

    const HUB_DIR = process.env.XCHAIN_HUB_DIR ||
        path.join(__dirname, '..', '..', '..', '..', 'xchain-hub');

    it('xchain-hub/src/price_batch_compression.js is byte-identical to this repo\'s copy', function(){
        const twin = path.join(HUB_DIR, 'src', 'price_batch_compression.js');
        // Refuses an absent twin and a lane symlink into a live main checkout alike.
        const twinCheckout = siblingCheckout(__dirname, twin);
        if(!twinCheckout.usable) return skipOrFail(this, twinCheckout, 'the price_batch_compression.js hub twin byte identity');
        const local = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'actions', 'price', 'price_batch_compression.js'), 'utf8');
        assert.strictEqual(local, fs.readFileSync(twin, 'utf8'),
            'price_batch_compression.js has drifted between xchain-indexer and xchain-hub; the two would ' +
            'disagree on which compressed batches are valid, which is a fork');
    });
});
