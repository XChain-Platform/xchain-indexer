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
 * fast-check arbitraries for blockchain addresses and transaction hashes.
 *
 * Generates real base58check/bech32 addresses that satisfy the indexer's
 * isCryptoAddress() validation (and strings that violate it), plus
 * isValidTransactionHash() inputs.
 */

const fc = require('fast-check');
const crypto = require('crypto');

const HEX_CHARS = '0123456789abcdef'.split('');
const ALNUM_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Helper: generate a string of exact length from a character set
function charString(chars, minLen, maxLen) {
    return fc.array(fc.constantFrom(...chars), { minLength: minLen, maxLength: maxLen })
        .map(a => a.join(''));
}

// Test-side base58check encoder (independent of src/utility.js) — builds a
// real address from a version byte + 20-byte hash so generated addresses
// carry a valid checksum.
function base58CheckEncode(version, hash20) {
    const payload  = Buffer.concat([Buffer.from([version]), hash20]);
    const checksum = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(payload).digest())
        .digest().subarray(0, 4);
    const data = Buffer.concat([payload, checksum]);
    let num = BigInt('0x' + data.toString('hex'));
    let out = '';
    while (num > 0n) {
        out = BASE58_ALPHABET[Number(num % 58n)] + out;
        num = num / 58n;
    }
    for (const byte of data) {
        if (byte !== 0) break;
        out = '1' + out;
    }
    return out;
}

// Valid regtest segwit addresses (fuzz suites run as BTC/regtest). bech32
// strings can't be derived from random bytes without a full encoder, so a
// fixed pool covers the segwit/taproot shapes.
const REGTEST_SEGWIT_POOL = [
    'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul',
    'bcrt1qg2zrk70aelwvua5v5e06lca4mqdmnta7gt3pymurghg8wsw8z69q3p3pcw',
    'bcrt1pxqgcx65hqkd9c7y6wulyfv2wlwawqx62n3ufwxkjhjpas2jtqxmsglytaf',
];

/**
 * Generate an address that passes isCryptoAddress on BTC regtest: a real
 * base58check P2PKH/P2SH (version 0x6f/0xc4) or a valid segwit address.
 */
function cryptoAddress() {
    return fc.oneof(
        { weight: 3, arbitrary: fc.tuple(
            fc.constantFrom(0x6f, 0xc4),
            fc.uint8Array({ minLength: 20, maxLength: 20 })
        ).map(([version, hash]) => base58CheckEncode(version, Buffer.from(hash))) },
        { weight: 1, arbitrary: fc.constantFrom(...REGTEST_SEGWIT_POOL) },
    );
}

/**
 * Generate addresses that should fail isCryptoAddress.
 */
function invalidAddress() {
    return fc.oneof(
        // Too short
        charString(ALNUM_CHARS, 0, 25),
        // Address-length alphanumeric garbage (fails checksum / charset)
        fc.integer({ min: 26, max: 42 }).chain(len => charString(ALNUM_CHARS, len, len)),
        // Too long
        charString(ALNUM_CHARS, 43, 60),
        // Valid encoding, wrong network (mainnet version byte on regtest)
        fc.uint8Array({ minLength: 20, maxLength: 20 })
            .map(hash => base58CheckEncode(0x00, Buffer.from(hash))),
        // Checksum-flipped: valid regtest address with the last char rotated
        fc.uint8Array({ minLength: 20, maxLength: 20 }).map(hash => {
            const addr = base58CheckEncode(0x6f, Buffer.from(hash));
            const last = addr[addr.length - 1];
            const next = BASE58_ALPHABET[(BASE58_ALPHABET.indexOf(last) + 1) % 58];
            return addr.slice(0, -1) + next;
        }),
        // SQL injection patterns
        fc.constantFrom("'; DROP TABLE--", "1 OR 1=1", "admin'--"),
        // Empty / null-like
        fc.constantFrom('', 'null', 'undefined'),
    );
}

/**
 * Union of valid and invalid addresses.
 */
function anyAddress() {
    return fc.oneof(cryptoAddress(), invalidAddress());
}

/**
 * Generate a valid 64-char hex transaction hash.
 */
function txHash() {
    return charString(HEX_CHARS, 64, 64);
}

/**
 * Generate hashes that should fail isValidTransactionHash.
 */
function invalidHash() {
    return fc.oneof(
        // Wrong length
        charString(HEX_CHARS, 0, 63),
        charString(HEX_CHARS, 65, 80),
        // Non-hex 64-char string
        charString(ALNUM_CHARS, 64, 64).filter(s => /[g-zG-Z]/.test(s)),
        // Empty
        fc.constant(''),
    );
}

module.exports = {
    cryptoAddress,
    invalidAddress,
    anyAddress,
    txHash,
    invalidHash,
};
