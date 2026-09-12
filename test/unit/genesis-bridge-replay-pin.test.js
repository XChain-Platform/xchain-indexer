// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Genesis replay pin for the bridge's shared token-row helper (xchain-bridge.md row 4, D66).
//
// _injectGasToken routes through Genesis.injectProtocolToken so the BTC genesis row and
// the row the bridge creates off BTC come out of ONE code path, rather than building the
// gas token's wire string and synthetic tx hash inline. Genesis is block-keyed and replays from
// height 0 on every node, so the transaction it synthesizes is a consensus artifact: if its
// data string or its tx hash moves by one byte, every block hash from the genesis block
// forward moves with it and the fleet forks.
//
// The expected values below are FROZEN LITERALS captured from the code BEFORE the refactor
// (BTC) and at the refactor (LTC/DOGE, where the bridge is the only creator). They are
// deliberately not recomputed from crypto here: a test that re-derives the hash the same way
// the code does proves only that sha256 is deterministic.

const assert = require('assert');

const Genesis = require('../../src/genesis.js');

// The gas token transaction, byte for byte, as genesis wrote it before the refactor.
const GAS_DATA = 'ISSUE|0|XCHAIN|100000000||8|XChain gas token|||||||||||||||999999999';
const GAS_HASH = {
    BTC:  'GENESIS-BTC-GAS-fc54d681de36c8ea1a5092544021b4238dcb13abcbd46ca3',
    LTC:  'GENESIS-LTC-GAS-453744644c98f6c1e116584a28ed3d012f86a208945e5b17',
    DOGE: 'GENESIS-DOGE-GAS-6b2f484c20e5d80e613ec955fed9fcf00d62f174575cd417'
};

function harness(coin){
    const sent = [];
    const util = {
        isNull: (v) => (v === null || v === undefined || v === ''),
        bcgt:   (a, b) => Number(a) > Number(b)
    };
    const actions   = { processTransaction: async (tx, isGenesis) => { sent.push({ tx, isGenesis }); } };
    // No ticker id means no row: the creation path runs.
    const indexerDb = { getTickerId: async () => null, getTokenInfo: async () => false };
    const config    = { COIN: coin, NETWORK: 'mainnet', GAS: 'XCHAIN', ADDRESS: { GAS: coin + '-gas-address' } };
    return { sent, genesis: new Genesis(actions, indexerDb, config, util) };
}

describe('genesis gas-token replay pin (bridge row-4 helper) @regression', function () {

    it('_injectGasToken synthesizes the pre-refactor transaction byte for byte on BTC', async function () {
        const h = harness('BTC');
        await h.genesis._injectGasToken('BTC-gas-address', 800000, 1700000000);
        assert.strictEqual(h.sent.length, 1, 'exactly one injected transaction');
        assert.strictEqual(h.sent[0].isGenesis, true, 'routed with the genesis flag (stamps IS_GENESIS)');
        assert.deepStrictEqual(h.sent[0].tx, {
            data:          GAS_DATA,
            source:        'BTC-gas-address',
            destination:   null,
            amount:        null,
            tx_hash:       GAS_HASH.BTC,
            vout:          0,
            block_index:   800000,
            block_time:    1700000000,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    []
        });
    });

    for(const coin of ['BTC', 'LTC', 'DOGE']){
        it('the gas parameter set through injectProtocolToken is identical on ' + coin, async function () {
            const h = harness(coin);
            const res = await h.genesis.injectProtocolToken(h.genesis.gasTokenParams(), {
                blockIndex:   123,
                blockTime:    456,
                txHashPrefix: 'GENESIS-'
            });
            assert.deepStrictEqual(res, { created: true, tick: 'XCHAIN' });
            assert.strictEqual(h.sent[0].tx.data,    GAS_DATA);
            assert.strictEqual(h.sent[0].tx.tx_hash, GAS_HASH[coin]);
            assert.strictEqual(h.sent[0].tx.source,  coin + '-gas-address');
            assert.strictEqual(h.sent[0].tx.vout,    0);
        });
    }

    it('the genesis call site and the bridge call site agree byte for byte on DOGE', async function () {
        // The obligation D66 states: the XCHAIN row the bridge creates off BTC is the row
        // genesis writes on BTC, with only the coin differing in the hash prefix.
        const viaGenesis = harness('DOGE');
        await viaGenesis.genesis._injectGasToken('DOGE-gas-address', 10, 20);
        const viaBridge = harness('DOGE');
        await viaBridge.genesis.injectProtocolToken(viaBridge.genesis.gasTokenParams('DOGE-gas-address'), {
            blockIndex: 10, blockTime: 20, txHashPrefix: 'GENESIS-'
        });
        assert.deepStrictEqual(viaBridge.sent[0].tx, viaGenesis.sent[0].tx);
    });

    it('an existing XCHAIN row makes the injection a no-op, so a reindex never doubles it', async function () {
        const h = harness('DOGE');
        h.genesis.indexerDb.getTickerId  = async () => 7;
        h.genesis.indexerDb.getTokenInfo = async () => ({ TICK: 'XCHAIN', DECIMALS: 8, OWNER: 'DOGE-gas-address', SUPPLY: '0' });
        const res = await h.genesis.injectProtocolToken(h.genesis.gasTokenParams(), { blockIndex: 1, blockTime: 2 });
        assert.deepStrictEqual(res, { created: false, tick: 'XCHAIN' });
        assert.strictEqual(h.sent.length, 0, 'nothing injected when the row is already there');
    });

    it('the genesis pass reads no database at all, exactly as before the refactor', async function () {
        // The gas token is the FIRST action of the genesis block, so the row cannot be there
        // and the idempotency probe the bridge needs would only add a read to the one block
        // every node replays. _injectGasToken must keep the read count it had: zero.
        const h = harness('BTC');
        let reads = 0;
        h.genesis.indexerDb.getTickerId  = async () => { reads++; return null; };
        h.genesis.indexerDb.getTokenInfo = async () => { reads++; return false; };
        await h.genesis._injectGasToken('BTC-gas-address', 800000, 1700000000);
        assert.strictEqual(reads, 0);
        assert.strictEqual(h.sent.length, 1, 'and the row is still injected');
    });

    it('the existence probe never interns a ticker id for a row it does not create', async function () {
        // getTokenInfo() calls createTicker(); interning a tick that is never created moves
        // the dense index_tickers id order and therefore the replay. The probe must stop at
        // getTickerId when there is no id yet.
        const h = harness('DOGE');
        let tokenInfoCalls = 0;
        h.genesis.indexerDb.getTickerId  = async () => null;
        h.genesis.indexerDb.getTokenInfo = async () => { tokenInfoCalls++; return false; };
        await h.genesis.injectProtocolToken(h.genesis.gasTokenParams(), { blockIndex: 1, blockTime: 2 });
        assert.strictEqual(tokenInfoCalls, 0, 'getTokenInfo (and its createTicker) is never reached');
    });

});
