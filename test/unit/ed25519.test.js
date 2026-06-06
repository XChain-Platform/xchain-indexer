// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const crypto = require('crypto');
const ed = require('../../src/ed25519.js');

// Mint a REAL Ed25519 keypair and expose the 32-byte raw pubkey as hex,
// exactly as xchain-hub/src/ValidatorIdentity.js does. These tests exercise
// the genuine primitive — unlike the action tests, which stub verify().
function realKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }); // 12-byte prefix + 32-byte key
    return { privateKey, pubHex: spki.subarray(12).toString('hex') };
}
function sign(payload, privateKey) {
    return crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex');
}

describe('ed25519 @crypto @regression', function () {

    describe('pubkeyFromHex()', function () {
        it('reconstructs a verifiable KeyObject from a 64-hex raw pubkey', function () {
            const { pubHex } = realKey();
            const key = ed.pubkeyFromHex(pubHex);
            assert.strictEqual(key.asymmetricKeyType, 'ed25519');
        });
        it('throws on wrong-length hex', function () {
            assert.throws(() => ed.pubkeyFromHex('abcd'), /Invalid pubkey hex length/);
            assert.throws(() => ed.pubkeyFromHex(''), /Invalid pubkey hex length/);
        });
    });

    describe('verify()', function () {
        it('accepts a genuine signature over the payload', function () {
            const { privateKey, pubHex } = realKey();
            const payload = 'round=1|price=100';
            assert.strictEqual(ed.verify(payload, sign(payload, privateKey), pubHex), true);
        });

        it('rejects a tampered payload', function () {
            const { privateKey, pubHex } = realKey();
            const sig = sign('original', privateKey);
            assert.strictEqual(ed.verify('original', sig, pubHex), true);
            assert.strictEqual(ed.verify('tampered', sig, pubHex), false);
        });

        it('rejects a flipped signature byte', function () {
            const { privateKey, pubHex } = realKey();
            const sigBuf = Buffer.from(sign('msg', privateKey), 'hex');
            sigBuf[0] ^= 0xff;
            assert.strictEqual(ed.verify('msg', sigBuf.toString('hex'), pubHex), false);
        });

        it('rejects a signature from a different key', function () {
            const a = realKey(), b = realKey();
            const sig = sign('msg', a.privateKey);
            assert.strictEqual(ed.verify('msg', sig, b.pubHex), false);
        });

        it('returns false (never throws) on malformed inputs', function () {
            const { privateKey, pubHex } = realKey();
            const sig = sign('msg', privateKey);
            assert.strictEqual(ed.verify('', sig, pubHex), false);
            assert.strictEqual(ed.verify('msg', null, pubHex), false);
            assert.strictEqual(ed.verify('msg', sig, null), false);
            assert.strictEqual(ed.verify('msg', 'zz', pubHex), false);          // sig not 128 hex
            assert.strictEqual(ed.verify('msg', sig, 'nothex'), false);          // pubkey not 64 hex
            assert.strictEqual(ed.verify('msg', sig, 'g'.repeat(64)), false);    // 64 chars but non-hex
        });
    });

    describe('buildPriceV0Payload()', function () {
        it('is deterministic and sorts pairs by pair id regardless of input order', function () {
            const a = ed.buildPriceV0Payload(5, 1000, [{ pair: 'BTC_USD', p: '1' }, { pair: 'AAA_USD', p: '2' }]);
            const b = ed.buildPriceV0Payload(5, 1000, [{ pair: 'AAA_USD', p: '2' }, { pair: 'BTC_USD', p: '1' }]);
            assert.strictEqual(a, b);
            assert.ok(a.indexOf('AAA_USD') < a.indexOf('BTC_USD'));
        });

        it('coerces round and timestamp to integers', function () {
            const payload = ed.buildPriceV0Payload('42', '1700000000', []);
            const obj = JSON.parse(payload);
            assert.strictEqual(obj.round, 42);
            assert.strictEqual(obj.timestamp, 1700000000);
        });

        it('round-trips through sign/verify (the real consensus path)', function () {
            const { privateKey, pubHex } = realKey();
            const payload = ed.buildPriceV0Payload(7, 1700000001, [{ pair: 'BTC_USD', price: '64000.00' }]);
            assert.strictEqual(ed.verify(payload, sign(payload, privateKey), pubHex), true);
        });
    });
});
