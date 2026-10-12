// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const { buildRollcallCanonical } = require('../../../../src/actions/rollcall/rollcall_canonical.js');
const { parseSigPairs, verifyRollcallSigners } = require('../../../../src/actions/rollcall/signatures.js');

const FIELDS = {
    network: 'regtest',
    epochHeight: 30,
    ledgerHash: 'ab'.repeat(32),
    gates: 'ALPHA,BETA'
};

function identity(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
    return { privateKey, pubkey };
}

function signedPair(fields = FIELDS){
    const signer = identity();
    const canonical = buildRollcallCanonical(fields);
    const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex');
    return { pubkey: signer.pubkey, sig };
}

describe('rollcall signature parsing', function(){
    it('preserves an incoming error and returns no signatures', function(){
        const error = 'invalid: prior field';
        const result = parseSigPairs(['ignored', '1', 'a'.repeat(64), 'b'.repeat(128)], 1, error);
        assert.strictEqual(result.error, error);
        assert.deepStrictEqual(result.sigs, []);
    });

    it('rejects non-numeric and below-one signature counts', function(){
        assert.deepStrictEqual(parseSigPairs(['x', 'nope'], 1, null), {
            error: 'invalid: SIG_COUNT', sigs: []
        });
        assert.deepStrictEqual(parseSigPairs(['x', '0'], 1, null), {
            error: 'invalid: SIG_COUNT', sigs: []
        });
    });

    it('rejects any remainder that is not exactly twice the count', function(){
        const pubkey = 'a'.repeat(64);
        const sig = 'b'.repeat(128);
        assert.strictEqual(parseSigPairs(['x', '2', pubkey, sig], 1, null).error, 'invalid: SIG_COUNT');
        assert.strictEqual(parseSigPairs(['x', '1', pubkey, sig, pubkey, sig], 1, null).error,
                           'invalid: SIG_COUNT');
    });

    it('lowercases valid pairs and skips malformed pairs independently', function(){
        const first = { pubkey: 'A'.repeat(64), sig: 'B'.repeat(128) };
        const second = { pubkey: 'C'.repeat(63), sig: 'D'.repeat(128) };
        const third = { pubkey: 'E'.repeat(64), sig: 'F'.repeat(128) };
        const params = ['x', '3', first.pubkey, first.sig, second.pubkey, second.sig,
                        third.pubkey, third.sig];
        const result = parseSigPairs(params, 1, null);
        assert.strictEqual(result.error, null);
        assert.deepStrictEqual(result.sigs, [
            { pubkey: first.pubkey.toLowerCase(), sig: first.sig.toLowerCase() },
            { pubkey: third.pubkey.toLowerCase(), sig: third.sig.toLowerCase() }
        ]);
    });
});

describe('rollcall signer verification', function(){
    it('verifies a genuine signature over the shared canonical bytes', function(){
        const pair = signedPair();
        assert.deepStrictEqual(verifyRollcallSigners(FIELDS, [pair]), {
            error: null,
            verified: [pair]
        });
    });

    it('drops signatures that do not verify', function(){
        const valid = signedPair();
        const invalid = signedPair({ ...FIELDS, epochHeight: FIELDS.epochHeight + 1 });
        assert.deepStrictEqual(verifyRollcallSigners(FIELDS, [invalid, valid]), {
            error: null,
            verified: [valid]
        });
    });

    it('counts a repeated public key once', function(){
        const pair = signedPair();
        assert.deepStrictEqual(verifyRollcallSigners(FIELDS, [pair, { ...pair }]), {
            error: null,
            verified: [pair]
        });
    });

    it('rejects a signature set when none verify', function(){
        const invalid = signedPair({ ...FIELDS, ledgerHash: 'cd'.repeat(32) });
        assert.deepStrictEqual(verifyRollcallSigners(FIELDS, [invalid]), {
            error: 'invalid: SIG_COUNT',
            verified: []
        });
    });
});
