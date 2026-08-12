// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

//  / : the genesis airdrop set is bundle data, not node environment.
//
// config.js used to read GENESIS_AIRDROP_PATHS / _HASHES / _AMOUNTS from the environment
// on EVERY network, while its sibling GENESIS_DUMP_HASH was already regtest-only. Those
// three values decide how much XCHAIN each snapshot holder mints and which synthetic tx
// hash carries the credit, so two mainnet replay nodes holding byte-identical snapshot
// CSVs could derive different allocations and fork at the genesis block while every
// per-file sha256 pin verified clean.
//
// The registration lives in the canonical coin bundle (src/coins/<COIN>.js, resolved by
// coins/index.js, which honours the env vars for network === 'regtest' only) and reaches
// the indexer through configs/_adapter.js. These tests hold BOTH halves: the env is inert
// off regtest, and the bundle is what the indexer actually ends up configured with.

const assert = require('assert');

const AIRDROP_ENV = {
    GENESIS_AIRDROP_PATHS:          'data/genesis/xcp.csv,data/genesis/xdp.csv',
    GENESIS_AIRDROP_HASHES:         'aa,bb',
    GENESIS_AIRDROP_AMOUNTS:        '20000000.00000000,10000000.00000000',
    GENESIS_AIRDROP_SNAPSHOT_BLOCK: '950000',
    GENESIS_AIRDROP_SET_HASH:       'c'.repeat(64),
};

const COINS    = ['BTC', 'LTC', 'DOGE'];
const NETWORKS = ['mainnet', 'testnet', 'regtest'];

describe('genesis airdrop config pinning  @regression', function () {

    const saved = {};

    beforeEach(function () {
        for(const [k, v] of Object.entries(AIRDROP_ENV)){
            saved[k] = process.env[k];
            process.env[k] = v;
        }
        delete require.cache[require.resolve('../../src/config.js')];
    });

    afterEach(function () {
        for(const k of Object.keys(AIRDROP_ENV)){
            if(saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        delete require.cache[require.resolve('../../src/config.js')];
    });

    function load(coin, network){
        return require('../../src/config.js').getConfig(coin, network);
    }

    for(const network of ['mainnet', 'testnet']){
        it(`ignores the airdrop env on ${network}, for every coin`, function () {
            for(const coin of COINS){
                const c = load(coin, network);
                assert.deepStrictEqual(c.GENESIS_AIRDROP_PATHS,   [], `${coin}/${network} paths`);
                assert.deepStrictEqual(c.GENESIS_AIRDROP_HASHES,  [], `${coin}/${network} hashes`);
                assert.deepStrictEqual(c.GENESIS_AIRDROP_AMOUNTS, [], `${coin}/${network} amounts`);
                assert.strictEqual(c.GENESIS_AIRDROP_SNAPSHOT_BLOCK, null, `${coin}/${network} snapshot block`);
                assert.strictEqual(c.GENESIS_AIRDROP_SET_HASH,       null, `${coin}/${network} set hash`);
            }
        });
    }

    it('still binds the airdrop set from env on regtest (the dry-run seam stays open)', function () {
        for(const coin of COINS){
            const c = load(coin, 'regtest');
            assert.deepStrictEqual(c.GENESIS_AIRDROP_PATHS,   ['data/genesis/xcp.csv', 'data/genesis/xdp.csv'], coin);
            assert.deepStrictEqual(c.GENESIS_AIRDROP_HASHES,  ['aa', 'bb'], coin);
            assert.deepStrictEqual(c.GENESIS_AIRDROP_AMOUNTS, ['20000000.00000000', '10000000.00000000'], coin);
            assert.strictEqual(c.GENESIS_AIRDROP_SNAPSHOT_BLOCK, '950000', coin);
            assert.strictEqual(c.GENESIS_AIRDROP_SET_HASH, 'c'.repeat(64), coin);
        }
    });

    it('keeps hash/amount entries index-aligned with paths when an entry is empty', function () {
        // An empty HASHES entry legitimately means "this bucket is unpinned" (pre-pin
        // dev/regtest). Compacting it would slide the first bucket's pin onto the second
        // bucket's file, which is a silent mis-verification rather than a failure.
        process.env.GENESIS_AIRDROP_HASHES = ',bb';
        const c = load('BTC', 'regtest');
        assert.deepStrictEqual(c.GENESIS_AIRDROP_HASHES, ['', 'bb']);
        assert.strictEqual(c.GENESIS_AIRDROP_PATHS.length, c.GENESIS_AIRDROP_HASHES.length);
    });

    it('leaves the airdrop disabled everywhere when the env is unset', function () {
        for(const k of Object.keys(AIRDROP_ENV)) delete process.env[k];
        for(const coin of COINS){
            for(const network of NETWORKS){
                const c = load(coin, network);
                assert.deepStrictEqual(c.GENESIS_AIRDROP_PATHS, [], `${coin}/${network}`);
                assert.strictEqual(c.GENESIS_AIRDROP_SET_HASH, null, `${coin}/${network}`);
            }
        }
    });

    it('sources the values from the coin bundle, so arming is a vendored edit', function () {
        // The adapter is what carries genesis.airdrop* into the indexer's config keys; if it
        // ever stopped, the mainnet assertions above would still pass (config.js zeroes them
        // off regtest) while an ARMED bundle silently minted nothing. Pin the wiring itself.
        const { toIndexerConfig } = require('../../src/configs/_adapter.js');
        const coins = require('../../src/coins');
        const real  = coins.getCoinConfig;
        coins.getCoinConfig = function(tick, network){
            const c = real.call(coins, tick, network);
            c.genesis.airdropPaths         = ['data/genesis/xcp.csv'];
            c.genesis.airdropHashes        = ['aa'];
            c.genesis.airdropAmounts       = ['30000000.00000000'];
            c.genesis.airdropSnapshotBlock = '950000';
            c.genesis.airdropSetHash       = 'd'.repeat(64);
            return c;
        };
        try {
            const cfg = toIndexerConfig('BTC', 'mainnet');
            assert.deepStrictEqual(cfg.GENESIS_AIRDROP_PATHS,   ['data/genesis/xcp.csv']);
            assert.deepStrictEqual(cfg.GENESIS_AIRDROP_HASHES,  ['aa']);
            assert.deepStrictEqual(cfg.GENESIS_AIRDROP_AMOUNTS, ['30000000.00000000']);
            assert.strictEqual(cfg.GENESIS_AIRDROP_SNAPSHOT_BLOCK, '950000');
            assert.strictEqual(cfg.GENESIS_AIRDROP_SET_HASH,       'd'.repeat(64));
        } finally {
            coins.getCoinConfig = real;
        }
    });
});
