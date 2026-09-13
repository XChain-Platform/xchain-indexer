// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// CONSENSUS guard for what the XBRIDGE escrow addresses actually ARE, base spec
// section 5. A comment that says "the readable text IS the hash160, so spending
// would need a preimage break" is false: the readable text lives in the base58
// STRING, and the decoded 20 bytes are
// whatever that string happens to encode. Measured 2026-09-12,
// '17BridgeLtcXChainXXXXXXXXXXa5uRRy' decodes to version 0x00 plus hash160
// 012b8f14947cc310298e6b49b68ea24e2bbdcbc0, which is not ASCII. This file pins
// the true properties so a future edit cannot restore the false one silently:
//
//   1. every BRIDGE_<COIN> literal is a well-formed base58check P2PKH address on
//      ITS OWN chain and network (valid checksum, 20-byte hash160, version byte
//      equal to that network's net.pubKeyHash),
//   2. the decoded hash160 is NOT the ASCII of any readable label, so the escrow
//      is keyless because nobody ever derived the hash from a public key: paying
//      out needs a K with RIPEMD160(SHA256(K)) equal to those exact 20 bytes,
//      a 160-bit preimage search on HASH160,
//   3. the same holds for BURN, which is the house convention these follow, so
//      the "exactly like BURN" comment stays true by measurement rather than by
//      assertion,
//   4. each literal's hash160 is pinned, so a changed address literal fails here
//      as well as in the consensus pin.
//
// The decoder below is written out in full on purpose: reusing the repo's own
// address code would let a bug in that code make this guard vacuous.

const assert = require('assert');
const crypto = require('crypto');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const coins = require('../../src/coins');

const COINS    = ['BTC', 'LTC', 'DOGE'];
const NETWORKS = ['mainnet', 'testnet', 'regtest'];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Independent base58check decode. Returns the version byte, the payload after it
// and whether the trailing 4-byte double-SHA256 checksum matches.
function base58checkDecode(addr) {
    let num = 0n;
    for (const ch of addr) {
        const i = B58.indexOf(ch);
        assert.ok(i >= 0, `${addr} carries a non-base58 character ${JSON.stringify(ch)}`);
        num = num * 58n + BigInt(i);
    }
    let hex = num.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    // Leading '1' characters are leading zero bytes, which the bigint lost.
    let leadingZeros = 0;
    for (const ch of addr) { if (ch === '1') leadingZeros++; else break; }
    const raw = Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(hex, 'hex')]);
    const body = raw.subarray(0, raw.length - 4);
    const checksum = raw.subarray(raw.length - 4);
    const want = sha256(sha256(body)).subarray(0, 4);
    return {
        version:     body[0],
        hash160:     body.subarray(1),
        checksumOk:  checksum.equals(want),
    };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }

// The hash160 the false comment implied: the readable label, ASCII, padded to 20
// bytes. If a literal ever really did decode to this, the escrow would be a
// spendable-on-preimage address rather than a keyless one, so the test asserts
// the opposite for every shipped literal.
function looksLikeAsciiLabel(hash160) {
    // Printable ASCII only, plus at least one run of letters, is what "the readable
    // text IS the hash160" would produce. Real HASH160 output is high-entropy bytes.
    for (const b of hash160) {
        if (b < 0x20 || b > 0x7e) return false;
    }
    return true;
}

// Pinned hash160 for every shipped escrow literal, measured 2026-09-12 with the
// decoder above. A changed address literal fails here as well as in the pin.
const PINNED_HASH160 = {
    '17BridgeLtcXChainXXXXXXXXXXa5uRRy':  '012b8f14947cc310298e6b49b68ea24e2bbdcbc0',
    '17BridgeDogeXChainXXXXXXXXXVuqXcv':  '012b8f14947c183f02d009269bbc1d7300012d05',
    'mfbtcbridgeLtcXXXXXXXXXXXXXXVPqpoV': '00ef01fa2fd862225f4239f201142a30ebc30454',
    'mfbtcbridgedogeXXXXXXXXXXXXXUXTr4m': '00ef01fa2fd86241682a8a70aa58c855cd9c41d9',
    'LKLtcbridgebtcXXXXXXXXXXXXXXXA61Gk': '014fddbb9aa121804caa5051e5929188552f222e',
    'LKLtcbridgedogeXXXXXXXXXXXXXX8Aknx': '014fddbb9aa12183d023fe763dd989b3630bb6ce',
    'mgLtcbridgebtcXXXXXXXXXXXXXXYpo2Bo': '0910e4e279a82a6739a128fcb1c06cf675ca356d',
    'mgLtcbridgedogeXXXXXXXXXXXXXZBQunc': '0910e4e279a82a6abd1ad7210a07652183a6ca0d',
    'D5dogebridgebtcXXXXXXXXXXXXXVAFQt9': '056dfe260f289428d017e4fa344bf02027cb9a33',
    'D5dogebridgeLtcXXXXXXXXXXXXXUVFLyn': '056dfe260f289428569ed085e373b3e27800a01d',
    'nUdogebridgebtcXXXXXXXXXXXXXWUG2kx': '04d9a2cd52c5c4c6b51ce564c48d31f6162adc44',
    'nUdogebridgeLtcXXXXXXXXXXXXXTsEz6W': '04d9a2cd52c5c4c63ba3d0f073b4f5b8665fe22e',
    'mfdogebridgebtcXXXXXXXXXXXXXZ3agHN': '014bb95f234574f5a07d40f8faf051eee9cab695',
    'mfdogebridgeLtcXXXXXXXXXXXXXXb2E4n': '014bb95f234574f527042c84aa1815b139ffbc7f',
};

// Every (coin, network, role, address) the shipped bundle carries for the escrow,
// flattened once so each assertion loop reads the same set.
function escrowEntries() {
    const out = [];
    for (const coin of COINS) {
        for (const network of NETWORKS) {
            const cfg  = coins.getCoinConfig(coin, network);
            const addr = cfg.addresses || {};
            for (const role of Object.keys(addr)) {
                if (!role.startsWith('BRIDGE_')) continue;
                out.push({ coin, network, role, address: addr[role], version: cfg.net.pubKeyHash });
            }
        }
    }
    return out;
}

describe('XBRIDGE escrow keylessness (consensus)', function () {

    it('ships an escrow literal for every ordered coin pair on every network', function () {
        // 3 coins x 2 destinations x 3 networks; a missing one would silently make
        // the loops below vacuous.
        assert.strictEqual(escrowEntries().length, 18);
    });

    it('decodes every escrow literal as a valid P2PKH address on its own network', function () {
        for (const e of escrowEntries()) {
            const d = base58checkDecode(e.address);
            assert.ok(d.checksumOk,
                `${e.coin}/${e.network} ${e.role} ${e.address} has a bad base58check checksum`);
            assert.strictEqual(d.hash160.length, 20,
                `${e.coin}/${e.network} ${e.role} ${e.address} is not a 20-byte hash160`);
            assert.strictEqual(d.version, e.version,
                `${e.coin}/${e.network} ${e.role} ${e.address} carries version 0x${d.version.toString(16)}, `
                + `not this network's pubKeyHash 0x${e.version.toString(16)}`);
        }
    });

    it('decodes to high-entropy bytes, NOT to the readable label as ASCII', function () {
        for (const e of escrowEntries()) {
            const d = base58checkDecode(e.address);
            assert.ok(!looksLikeAsciiLabel(d.hash160),
                `${e.coin}/${e.network} ${e.role} ${e.address} decodes to printable ASCII `
                + `(${d.hash160.toString('hex')}); the escrow's keylessness argument is that the `
                + `hash160 was never derived from a key, not that it spells the label`);
        }
    });

    it('follows the same construction as BURN, which also decodes to non-ASCII', function () {
        // The escrow comments say "exactly like BURN". Measure BURN rather than
        // trusting the sentence: on every chain and network it is a valid P2PKH
        // address whose hash160 is likewise not the readable text.
        let checked = 0;
        for (const coin of COINS) {
            for (const network of NETWORKS) {
                const cfg  = coins.getCoinConfig(coin, network);
                const burn = (cfg.addresses || {}).BURN;
                assert.ok(burn, `${coin}/${network} has no BURN address to compare against`);
                const d = base58checkDecode(burn);
                assert.ok(d.checksumOk, `${coin}/${network} BURN ${burn} has a bad checksum`);
                assert.strictEqual(d.version, cfg.net.pubKeyHash,
                    `${coin}/${network} BURN ${burn} carries the wrong version byte`);
                assert.ok(!looksLikeAsciiLabel(d.hash160),
                    `${coin}/${network} BURN ${burn} decodes to printable ASCII ${d.hash160.toString('hex')}`);
                checked++;
            }
        }
        assert.strictEqual(checked, 9);
    });

    it('pins the hash160 of every shipped escrow literal', function () {
        const seen = new Set();
        for (const e of escrowEntries()) {
            const d = base58checkDecode(e.address);
            const want = PINNED_HASH160[e.address];
            assert.ok(want, `${e.address} is not pinned; a new escrow literal must be measured and pinned here`);
            assert.strictEqual(d.hash160.toString('hex'), want,
                `${e.coin}/${e.network} ${e.role} ${e.address} decodes to a different hash160 than the pin`);
            seen.add(e.address);
        }
        // Nothing pinned may be dropped from the bundle without updating this file.
        for (const addr of Object.keys(PINNED_HASH160)) {
            assert.ok(seen.has(addr), `${addr} is pinned here but no longer shipped by any coin bundle`);
        }
    });

    it('proves the decoder itself rejects a corrupted address', function () {
        // Without this the checksum assertion above could be passing vacuously on a
        // decoder that returns checksumOk unconditionally.
        const good = '17BridgeLtcXChainXXXXXXXXXXa5uRRy';
        assert.ok(base58checkDecode(good).checksumOk);
        const bad = good.slice(0, -1) + (good.slice(-1) === 'y' ? 'z' : 'y');
        assert.ok(!base58checkDecode(bad).checksumOk,
            'the base58check decoder accepted a corrupted address, so the checksum assertions are vacuous');
    });

    it('proves looksLikeAsciiLabel would fire on an address that really did spell its label', function () {
        // The false comment described a 20-byte hash160 that IS the readable text.
        // Build exactly that and confirm the predicate catches it, so the
        // non-ASCII assertion above is a real check and not always-false.
        const spelled = Buffer.from('BridgeLtcXXXXXXXXXXX', 'ascii');
        assert.strictEqual(spelled.length, 20);
        assert.ok(looksLikeAsciiLabel(spelled),
            'looksLikeAsciiLabel missed a hash160 that literally is the label, so the guard is vacuous');
    });
});
