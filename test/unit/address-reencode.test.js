// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Cross-chain address re-encoding primitives (Utility.base58CheckEncode,
// bech32Encode, crossChainReencodeAddress, canReencodeAddress) used by
// cross-chain royalty legs. Vectors are MAINNET on purpose: BTC/LTC/DOGE
// regtest share p2pkh 0x6f / p2sh 0xc4, so re-encoding is a no-op there and
// regtest-based tests would false-green a broken version-byte swap.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');

// Known-valid mainnet addresses per coin (same decoder-verified vectors as
// address-validation.test.js)
const MAINNET = {
    BTC: {
        p2pkh:  '17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt',
        p2sh:   '32QqkdokPN3kB6LVsnaBCv5DLw53JiwbTs',
        p2wpkh: 'bc1q8uuuk4vlqc0lhkskf8lhh9r2q89n2l566uhekf',
        p2wsh:  'bc1qv3r58j528rx6x626j5nk8rdnfu9upgufs2sukw30yjn3glpcsydskdlznd',
        p2tr:   'bc1p9jt5qw8ydse6vfvwym8ngu9lfwxz0dufq2dz3qfzv7k44g255jasfxu9al'
    },
    LTC: {
        p2pkh:  'LYoDQ9vcZBq4hWBeiKMqVvhqs7FSQSk6ck',
        p2sh:   'MDqL9mwgqxpNQodvRQpJBpuEWzv6wVfbWc',
        p2wpkh: 'ltc1qerp5jqmc2nja6lrxw0w4e02uvk83aj89qwltym',
        p2wsh:  'ltc1qqkfrfkgsxhs9d94vl62k5xd63jfalha2egler8mayqkjkxzse2hqguh6mq',
        p2tr:   'ltc1p7qy6q7cqmqp4uux3j6dj9u0eken8rrhmuyt2pzck9486wk84kmuqn6mgtz'
    },
    DOGE: {
        p2pkh: 'DKueiiiESH37vowsy4nQgri8u4GDtmQfqt',
        p2sh:  '9yqVXgk67Mqpnbp92iDSSVqX17yeVM7qsi'
    }
};

// Mainnet version bytes (mirror of utility.js ADDRESS_PARAMS)
const VERSION = {
    BTC:  { p2pkh: 0x00, p2sh: 0x05 },
    LTC:  { p2pkh: 0x30, p2sh: 0x32 },
    DOGE: { p2pkh: 0x1e, p2sh: 0x16 }
};

describe('cross-chain address re-encoding @regression @tier1', function () {
    let util;

    before(function () {
        util = new Utility();
    });

    describe('base58CheckEncode', function () {
        it('encodes the genesis-address payload to the published address', function () {
            // 0x00 + hash160 of the Bitcoin genesis coinbase output
            const payload = Buffer.from('0062e907b15cbf27d5425399ebf6f0fb50ebb88f18', 'hex');
            assert.strictEqual(util.base58CheckEncode(payload), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
        });
        it('round-trips every known base58 address through decode → encode', function () {
            for (const coin of Object.keys(MAINNET)) {
                for (const kind of ['p2pkh', 'p2sh']) {
                    const addr = MAINNET[coin][kind];
                    const payload = util.base58CheckDecode(addr);
                    assert.ok(payload, `${coin} ${kind} must decode`);
                    assert.strictEqual(util.base58CheckEncode(payload), addr, `${coin} ${kind}`);
                }
            }
        });
        it('restores leading zero bytes as leading 1 characters', function () {
            const payload = Buffer.from('000000b15cbf27d5425399ebf6f0fb50ebb88f18000000', 'hex');
            const encoded = util.base58CheckEncode(payload);
            assert.ok(encoded.startsWith('111'));
            assert.deepStrictEqual(util.base58CheckDecode(encoded), payload);
        });
        it('rejects empty and non-Buffer input', function () {
            assert.strictEqual(util.base58CheckEncode(Buffer.alloc(0)), false);
            assert.strictEqual(util.base58CheckEncode(null), false);
            assert.strictEqual(util.base58CheckEncode('0062e907'), false);
            assert.strictEqual(util.base58CheckEncode([0, 1, 2]), false);
        });
    });

    describe('bech32Encode', function () {
        it('encodes the BIP-173 P2WPKH vector (mainnet and testnet HRP)', function () {
            const program = Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex');
            assert.strictEqual(util.bech32Encode('bc', 0, program), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
            assert.strictEqual(util.bech32Encode('tb', 0, program), 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
        });
        it('encodes the BIP-350 P2TR vector with the bech32m constant', function () {
            const program = Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
            assert.strictEqual(util.bech32Encode('bc', 1, program), 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0');
        });
        it('round-trips every known segwit address through decode → encode', function () {
            for (const coin of ['BTC', 'LTC']) {
                for (const kind of ['p2wpkh', 'p2wsh', 'p2tr']) {
                    const addr = MAINNET[coin][kind];
                    const decoded = util.bech32Decode(addr);
                    assert.ok(decoded, `${coin} ${kind} must decode`);
                    assert.strictEqual(util.bech32Encode(decoded.hrp, decoded.version, decoded.program), addr, `${coin} ${kind}`);
                }
            }
        });
        it('output always re-decodes to the same version + program', function () {
            const program = Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817', 'hex'); // 31 bytes, v2
            const encoded = util.bech32Encode('bc', 2, program);
            const decoded = util.bech32Decode(encoded);
            assert.strictEqual(decoded.version, 2);
            assert.strictEqual(Buffer.from(decoded.program).toString('hex'), program.toString('hex'));
        });
        it('rejects invalid version and program lengths', function () {
            const p20 = Buffer.alloc(20, 7);
            assert.strictEqual(util.bech32Encode('bc', -1, p20), false);
            assert.strictEqual(util.bech32Encode('bc', 17, p20), false);
            assert.strictEqual(util.bech32Encode('bc', 1.5, p20), false);
            assert.strictEqual(util.bech32Encode('bc', 0, Buffer.alloc(1)), false);
            assert.strictEqual(util.bech32Encode('bc', 1, Buffer.alloc(41)), false);
            // v0 witness programs must be exactly 20 or 32 bytes (BIP-141)
            assert.strictEqual(util.bech32Encode('bc', 0, Buffer.alloc(25)), false);
            assert.strictEqual(util.bech32Encode('', 0, p20), false);
            assert.strictEqual(util.bech32Encode(null, 0, p20), false);
        });
    });

    describe('crossChainReencodeAddress: base58 (p2pkh / p2sh)', function () {
        // Every ordered coin pair, both address kinds: version byte swaps to the
        // target coin's and the hash160 payload is byte-identical
        const coins = ['BTC', 'LTC', 'DOGE'];
        for (const from of coins) {
            for (const to of coins) {
                if (from === to) continue;
                for (const kind of ['p2pkh', 'p2sh']) {
                    it(`${from} ${kind} → ${to}: version swaps, hash160 preserved`, function () {
                        const src = MAINNET[from][kind];
                        const out = util.crossChainReencodeAddress(src, from, to, 'mainnet');
                        assert.ok(out, 'must re-encode');
                        assert.notStrictEqual(out, src, 'mainnet re-encode must actually change the string');
                        assert.strictEqual(util.isCryptoAddress(out, to, 'mainnet'), true);
                        const srcPayload = util.base58CheckDecode(src);
                        const outPayload = util.base58CheckDecode(out);
                        assert.strictEqual(outPayload[0], VERSION[to][kind]);
                        assert.strictEqual(outPayload.subarray(1).toString('hex'), srcPayload.subarray(1).toString('hex'));
                        // And back: re-encoding to the source coin restores the original
                        assert.strictEqual(util.crossChainReencodeAddress(out, to, from, 'mainnet'), src);
                    });
                }
            }
        }
        it('same-coin re-encode is the identity', function () {
            assert.strictEqual(util.crossChainReencodeAddress(MAINNET.BTC.p2pkh, 'BTC', 'BTC', 'mainnet'), MAINNET.BTC.p2pkh);
        });
    });

    describe('crossChainReencodeAddress: segwit', function () {
        for (const kind of ['p2wpkh', 'p2wsh', 'p2tr']) {
            it(`BTC ${kind} ↔ LTC: HRP swaps, witness program preserved`, function () {
                const src = MAINNET.BTC[kind];
                const out = util.crossChainReencodeAddress(src, 'BTC', 'LTC', 'mainnet');
                assert.ok(out, 'must re-encode');
                assert.strictEqual(util.isCryptoAddress(out, 'LTC', 'mainnet'), true);
                const s = util.bech32Decode(src);
                const o = util.bech32Decode(out);
                assert.strictEqual(o.hrp, 'ltc');
                assert.strictEqual(o.version, s.version);
                assert.strictEqual(Buffer.from(o.program).toString('hex'), Buffer.from(s.program).toString('hex'));
                assert.strictEqual(util.crossChainReencodeAddress(out, 'LTC', 'BTC', 'mainnet'), src);
            });
        }
        it('accepts all-uppercase bech32 input (canonical lowercase output)', function () {
            const out = util.crossChainReencodeAddress(MAINNET.BTC.p2wpkh.toUpperCase(), 'BTC', 'LTC', 'mainnet');
            assert.strictEqual(util.isCryptoAddress(out, 'LTC', 'mainnet'), true);
        });
        it('segwit → DOGE is null (DOGE has no bech32 HRP)', function () {
            for (const kind of ['p2wpkh', 'p2wsh', 'p2tr']) {
                assert.strictEqual(util.crossChainReencodeAddress(MAINNET.BTC[kind], 'BTC', 'DOGE', 'mainnet'), null);
                assert.strictEqual(util.crossChainReencodeAddress(MAINNET.LTC[kind], 'LTC', 'DOGE', 'mainnet'), null);
            }
        });
    });

    describe('crossChainReencodeAddress: fail-closed', function () {
        it('contract ledger addresses are null (chain-tagged, cannot cross)', function () {
            assert.strictEqual(util.crossChainReencodeAddress('C:BTC:500', 'BTC', 'DOGE', 'mainnet'), null);
            assert.strictEqual(util.crossChainReencodeAddress('C:DOGE:1', 'DOGE', 'BTC', 'mainnet'), null);
        });
        it('the BURN sentinel is null', function () {
            assert.strictEqual(util.crossChainReencodeAddress('BURN', 'BTC', 'DOGE', 'mainnet'), null);
        });
        it('a version byte matching neither of fromCoin prefixes is null', function () {
            // Real LTC mainnet address (0x30) claimed to be a BTC address
            assert.strictEqual(util.crossChainReencodeAddress(MAINNET.LTC.p2pkh, 'BTC', 'DOGE', 'mainnet'), null);
            // Real BTC address claimed to be DOGE
            assert.strictEqual(util.crossChainReencodeAddress(MAINNET.BTC.p2pkh, 'DOGE', 'LTC', 'mainnet'), null);
        });
        it('a valid base58check string with a non-21-byte payload is null', function () {
            // Correct checksum, plausible length, matching version byte, but a
            // 25-byte payload (not version + hash160)
            const odd = util.base58CheckEncode(Buffer.concat([Buffer.from([0x00]), Buffer.alloc(24, 9)]));
            assert.ok(util.base58CheckDecode(odd), 'construction must be valid base58check');
            assert.strictEqual(util.crossChainReencodeAddress(odd, 'BTC', 'DOGE', 'mainnet'), null);
        });
        it('checksum-corrupted input is null', function () {
            const addr = MAINNET.BTC.p2pkh;
            const flip = addr.slice(0, -1) + (addr.endsWith('t') ? 'u' : 't');
            assert.strictEqual(util.crossChainReencodeAddress(flip, 'BTC', 'DOGE', 'mainnet'), null);
        });
        it('unknown coin, unknown network, null and garbage input are null', function () {
            assert.strictEqual(util.crossChainReencodeAddress(MAINNET.BTC.p2pkh, 'BTC', 'ETH', 'mainnet'), null);
            assert.strictEqual(util.crossChainReencodeAddress(MAINNET.BTC.p2pkh, 'ETH', 'BTC', 'mainnet'), null);
            assert.strictEqual(util.crossChainReencodeAddress(MAINNET.BTC.p2pkh, 'BTC', 'DOGE', 'signet'), null);
            assert.strictEqual(util.crossChainReencodeAddress(null, 'BTC', 'DOGE', 'mainnet'), null);
            assert.strictEqual(util.crossChainReencodeAddress('', 'BTC', 'DOGE', 'mainnet'), null);
            assert.strictEqual(util.crossChainReencodeAddress('notanaddress', 'BTC', 'DOGE', 'mainnet'), null);
        });
    });

    describe('regtest prefix collision (why these tests use mainnet)', function () {
        it('regtest p2pkh re-encode is a no-op across all three coins', function () {
            // BTC/LTC/DOGE regtest all use p2pkh 0x6f, so a broken version-byte
            // swap would be invisible here; this documents the trap
            const regtest = 'n4bqdmGjXUXLoRFsjFbtWoEMjNanAJEu6L';
            assert.strictEqual(util.crossChainReencodeAddress(regtest, 'BTC', 'DOGE', 'regtest'), regtest);
            assert.strictEqual(util.crossChainReencodeAddress(regtest, 'BTC', 'LTC', 'regtest'), regtest);
        });
    });

    describe('canReencodeAddress', function () {
        it('mirrors crossChainReencodeAddress non-null', function () {
            assert.strictEqual(util.canReencodeAddress(MAINNET.BTC.p2pkh, 'BTC', 'DOGE', 'mainnet'), true);
            assert.strictEqual(util.canReencodeAddress(MAINNET.BTC.p2wpkh, 'BTC', 'LTC', 'mainnet'), true);
            assert.strictEqual(util.canReencodeAddress(MAINNET.BTC.p2wpkh, 'BTC', 'DOGE', 'mainnet'), false);
            assert.strictEqual(util.canReencodeAddress('C:BTC:500', 'BTC', 'DOGE', 'mainnet'), false);
            assert.strictEqual(util.canReencodeAddress('BURN', 'BTC', 'DOGE', 'mainnet'), false);
        });
    });
});
