// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Per-chain cryptographic address validation (Utility.isCryptoAddress).
// Covers base58check (version byte + double-SHA256 checksum) and
// bech32/bech32m (BIP-173/BIP-350) across BTC/LTC/DOGE on every network.

const assert = require('assert');

// Set env before requiring Utility (it loads config in constructor)
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');

// Known-valid addresses per coin/network (hash payloads are arbitrary but the
// encodings are real: correct version byte / HRP and a valid checksum)
const VALID = {
    BTC: {
        mainnet: {
            p2pkh:  '17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt',
            p2sh:   '32QqkdokPN3kB6LVsnaBCv5DLw53JiwbTs',
            p2wpkh: 'bc1q8uuuk4vlqc0lhkskf8lhh9r2q89n2l566uhekf',
            p2wsh:  'bc1qv3r58j528rx6x626j5nk8rdnfu9upgufs2sukw30yjn3glpcsydskdlznd',
            p2tr:   'bc1p9jt5qw8ydse6vfvwym8ngu9lfwxz0dufq2dz3qfzv7k44g255jasfxu9al'
        },
        testnet: {
            p2pkh:  'n2HDnL5nvS9h1QbK15a54LBCPDUGciqkDo',
            p2sh:   '2NCPvGt2PyeKQV2EzeEdzhp52n6nbgHeb73',
            p2wpkh: 'tb1q8fhc7yh0d9mr78hy4z8hlgndtwyemdnuwl6np6',
            p2wsh:  'tb1qhvqfyf0lrtu2g88ksg77lse2yl6f9ptxvrrspj4kn8ns5y3uutnqy7na0d',
            p2tr:   'tb1pzsq2a2vqknj4nvg44pz0q79h5rwq4n0sel52hqfuj3q4xx20pdts4usrzt'
        },
        regtest: {
            p2pkh:  'n4bqdmGjXUXLoRFsjFbtWoEMjNanAJEu6L',
            p2sh:   '2NETsvK6gpTRsvxt3z4oJJLVof6BkA9AHmQ',
            p2wpkh: 'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul',
            p2wsh:  'bcrt1qg2zrk70aelwvua5v5e06lca4mqdmnta7gt3pymurghg8wsw8z69q3p3pcw',
            p2tr:   'bcrt1pxqgcx65hqkd9c7y6wulyfv2wlwawqx62n3ufwxkjhjpas2jtqxmsglytaf'
        }
    },
    LTC: {
        mainnet: {
            p2pkh:  'LYoDQ9vcZBq4hWBeiKMqVvhqs7FSQSk6ck',
            p2sh:   'MDqL9mwgqxpNQodvRQpJBpuEWzv6wVfbWc',
            p2wpkh: 'ltc1qerp5jqmc2nja6lrxw0w4e02uvk83aj89qwltym',
            p2wsh:  'ltc1qqkfrfkgsxhs9d94vl62k5xd63jfalha2egler8mayqkjkxzse2hqguh6mq',
            p2tr:   'ltc1p7qy6q7cqmqp4uux3j6dj9u0eken8rrhmuyt2pzck9486wk84kmuqn6mgtz'
        },
        testnet: {
            p2pkh:  'mwVXJRPbD4ytcPLPHuL59E862DgUkSbNEU',
            p2sh:   '2N4ryKnL2YgVLA6vX7363grkrx6xGmycxMx',
            p2wpkh: 'tltc1qa5808nf0lalz0vm3vmcdrw293umy2g0l85vqdn',
            p2wsh:  'tltc1q5uk622sxj0tl5evgs5kt5838nd0vz8gx7uaxqhrrec26jttu6whqx47ylg',
            p2tr:   'tltc1pa6fmnza50ehchdd0tx732j8v78yqqcat29ru3xt5xwqr6k82n7lqqwzqjw'
        },
        regtest: {
            p2pkh:  'mubWmH2ysDnctamjzUenQ8p4N17dJqHLjy',
            p2sh:   '2NA88fRroxKFxiwMuJzwWjMabYXrWFCr3T6',
            p2wpkh: 'rltc1qjvuwa4wxg2cvxxkt9hacuujeweamzpu8gs3cvg',
            p2wsh:  'rltc1q6ea8y9xz4r6rnrllz5eycy8mwlph5ggkqrgqfjqjer7gseza73wqpe2c5z',
            p2tr:   'rltc1p42kg89p4y6yeu0y7m44f7kp7u34dmq34znqscvfm58zqleftwrksy58jmd'
        }
    },
    DOGE: {
        mainnet: { p2pkh: 'DKueiiiESH37vowsy4nQgri8u4GDtmQfqt', p2sh: '9yqVXgk67Mqpnbp92iDSSVqX17yeVM7qsi' },
        testnet: { p2pkh: 'nXnJqZPve6z4wjvUeuP8eML4RUFuHfBHr9', p2sh: '2N38QavoGi89zqnnJkQvRVLXkN73kMoRvvN' },
        regtest: { p2pkh: 'mqHTNWhvuGbkZuiDDRS46i1aipKBW5PL5k', p2sh: '2Msw5DCXfdGteG6iSjc4KMmbwZyj6XnBsEF' }
    }
};

describe('isCryptoAddress per-chain validation @regression @tier1', function () {
    let util;

    before(function () {
        util = new Utility();
    });

    describe('valid addresses per coin/network', function () {
        for (const coin of Object.keys(VALID)) {
            for (const network of Object.keys(VALID[coin])) {
                for (const [kind, address] of Object.entries(VALID[coin][network])) {
                    it(`${coin}/${network} ${kind} → valid`, function () {
                        assert.strictEqual(util.isCryptoAddress(address, coin, network), true);
                    });
                }
            }
        }
    });

    describe('wrong-network / wrong-coin rejection', function () {
        it('DOGE mainnet address on BTC mainnet → invalid', function () {
            assert.strictEqual(util.isCryptoAddress(VALID.DOGE.mainnet.p2pkh, 'BTC', 'mainnet'), false);
        });
        it('LTC mainnet address on BTC mainnet → invalid', function () {
            assert.strictEqual(util.isCryptoAddress(VALID.LTC.mainnet.p2pkh, 'BTC', 'mainnet'), false);
        });
        it('BTC mainnet address on DOGE mainnet → invalid', function () {
            assert.strictEqual(util.isCryptoAddress(VALID.BTC.mainnet.p2pkh, 'DOGE', 'mainnet'), false);
        });
        it('BTC testnet address on BTC mainnet → invalid', function () {
            assert.strictEqual(util.isCryptoAddress(VALID.BTC.testnet.p2pkh, 'BTC', 'mainnet'), false);
        });
        it('BTC mainnet segwit (bc1) on BTC regtest → invalid (HRP mismatch)', function () {
            assert.strictEqual(util.isCryptoAddress(VALID.BTC.mainnet.p2wpkh, 'BTC', 'regtest'), false);
        });
        it('BTC segwit address on LTC → invalid (HRP mismatch)', function () {
            assert.strictEqual(util.isCryptoAddress(VALID.BTC.mainnet.p2wpkh, 'LTC', 'mainnet'), false);
        });
        it('any segwit address on DOGE → invalid (DOGE has no segwit)', function () {
            assert.strictEqual(util.isCryptoAddress(VALID.BTC.mainnet.p2wpkh, 'DOGE', 'mainnet'), false);
            assert.strictEqual(util.isCryptoAddress(VALID.LTC.mainnet.p2tr,  'DOGE', 'mainnet'), false);
        });
    });

    describe('checksum integrity', function () {
        it('base58 P2PKH with one flipped character → invalid', function () {
            const addr = VALID.BTC.mainnet.p2pkh;
            const flip = addr.slice(0, -1) + (addr.endsWith('t') ? 'u' : 't');
            assert.strictEqual(util.isCryptoAddress(flip, 'BTC', 'mainnet'), false);
        });
        it('bech32 P2WPKH with one flipped character → invalid', function () {
            const addr = VALID.BTC.mainnet.p2wpkh;
            const flip = addr.slice(0, -1) + (addr.endsWith('f') ? 'd' : 'f');
            assert.strictEqual(util.isCryptoAddress(flip, 'BTC', 'mainnet'), false);
        });
        it('taproot (bech32m) with one flipped character → invalid', function () {
            const addr = VALID.BTC.mainnet.p2tr;
            const flip = addr.slice(0, -1) + (addr.endsWith('l') ? 'm' : 'l');
            assert.strictEqual(util.isCryptoAddress(flip, 'BTC', 'mainnet'), false);
        });
        it('segwit v0 encoded with bech32m constant → invalid', function () {
            // BIP-350: v0 must use bech32, not bech32m
            assert.strictEqual(util.isCryptoAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', 'BTC', 'mainnet'), false);
        });
    });

    describe('BIP-173 / BIP-350 reference vectors', function () {
        it('accepts the BIP-173 P2WPKH vector (upper and lower case)', function () {
            assert.strictEqual(util.isCryptoAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BTC', 'mainnet'), true);
            assert.strictEqual(util.isCryptoAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'BTC', 'mainnet'), true);
        });
        it('accepts the BIP-173 P2WSH testnet vector', function () {
            assert.strictEqual(util.isCryptoAddress('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'BTC', 'testnet'), true);
        });
        it('accepts the BIP-350 P2TR vector', function () {
            assert.strictEqual(util.isCryptoAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'BTC', 'mainnet'), true);
        });
        it('rejects mixed-case bech32', function () {
            assert.strictEqual(util.isCryptoAddress('BC1QW508d6QEJxTDG4y5R3ZArVARY0C5XW7KV8F3t4', 'BTC', 'mainnet'), false);
        });
    });

    describe('malformed input', function () {
        it('rejects null / empty / non-string input', function () {
            assert.strictEqual(util.isCryptoAddress(null), false);
            assert.strictEqual(util.isCryptoAddress(undefined), false);
            assert.strictEqual(util.isCryptoAddress(''), false);
            assert.strictEqual(util.isCryptoAddress(12345), false);
            assert.strictEqual(util.isCryptoAddress({}), false);
        });
        it('rejects garbage strings at previously accepted lengths (26-35, 42)', function () {
            assert.strictEqual(util.isCryptoAddress('x'.repeat(26), 'BTC', 'mainnet'), false);
            assert.strictEqual(util.isCryptoAddress('x'.repeat(35), 'BTC', 'mainnet'), false);
            assert.strictEqual(util.isCryptoAddress('x'.repeat(42), 'BTC', 'mainnet'), false);
        });
        it('rejects an address with surrounding whitespace', function () {
            assert.strictEqual(util.isCryptoAddress(' ' + VALID.BTC.mainnet.p2pkh, 'BTC', 'mainnet'), false);
            assert.strictEqual(util.isCryptoAddress(VALID.BTC.mainnet.p2pkh + '\n', 'BTC', 'mainnet'), false);
        });
        it('rejects an unknown coin or network', function () {
            assert.strictEqual(util.isCryptoAddress(VALID.BTC.mainnet.p2pkh, 'ETH', 'mainnet'), false);
            assert.strictEqual(util.isCryptoAddress(VALID.BTC.mainnet.p2pkh, 'BTC', 'signet'), false);
        });
    });
});
