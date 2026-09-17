// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// XBRIDGE handler: v0/v3 lock, v1/v4 burn, the shared activation and chain
// gates, and the refusal of a broadcast v2/v5.
//
// Every expected verdict below is written as a LITERAL, never as XBridge.VERDICTS.X. A
// verdict is persisted in index_statuses and enters actions_hash, so asserting the
// handler's own constant against itself would pass however the string was renamed; the
// literals are what pin the consensus strings.
//
// The frozen verdicts, the formats and the shared gates live here; the four
// user legs live beside it in xbridge.test/, one file per version (v0_lock,
// v1_burn, v3_lock, v4_burn). Every file opens the same 'XBRIDGE action handler
// @regression @tier3' describe, so each full test title stays under one suite
// name. xbridge.test/helpers/xbridge_context.js holds the addresses, tick ids
// and builders every block starts from.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const XBridge  = require('../../../../src/actions/xbridge/index.js');
// The bridge map is a registry row (W5): a case that needs a chain-specific slot
// stubs activeAt() for the key instead of writing into the shipped map.
const { stubGate } = require('../../../helpers/gate_modules.js');
const XCHAIN_BRIDGE_KEY = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
const TOKEN_BRIDGE_KEY  = 'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION';
const { DEST, makeHandler, makeData } = require('./xbridge.test/helpers/xbridge_context.js');

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('frozen verdict strings', function(){
        // XBridge.VERDICTS is quoted by the SDK, the docs page and the manifest entry, and
        // every value is persisted into index_statuses and hashed. Pinning the literals
        // here is what makes a rename a red test rather than a silent fleet fork.
        it('pins every consensus verdict literal', function(){
            let V = XBridge.VERDICTS;
            assert.strictEqual(V.BEFORE_ACTIVATION,   'invalid: XBRIDGE before activation');
            assert.strictEqual(V.UNKNOWN_VERSION,     'invalid: VERSION (unknown)');
            assert.strictEqual(V.BTC_ONLY,            'invalid: XBRIDGE (BTC only)');
            assert.strictEqual(V.V1_NOT_ON_BTC,       'invalid: XBRIDGE v1 is not valid on BTC');
            assert.strictEqual(V.V2_SYSTEM_INJECTED,  'invalid: XBRIDGE v2 is system-injected');
            assert.strictEqual(V.V5_SYSTEM_INJECTED,  'invalid: XBRIDGE v5 is system-injected');
            assert.strictEqual(V.DEST_COIN,           'invalid: DEST_COIN');
            assert.strictEqual(V.DEST_ADDRESS,        'invalid: DEST_ADDRESS');
            assert.strictEqual(V.AMOUNT,              'invalid: AMOUNT');
            assert.strictEqual(V.INSUFFICIENT_FUNDS,  'invalid: insufficient funds');
            assert.strictEqual(V.TICK_NOT_NATIVE,     'invalid: TICK (not native here)');
            assert.strictEqual(V.TICK_USE_V0,         'invalid: TICK (use XBRIDGE v0)');
            assert.strictEqual(V.TICK_SUBASSET,       'invalid: TICK (subassets are not bridgeable yet)');
            assert.strictEqual(V.TICK_TOO_LONG,       'invalid: TICK (too long to bridge)');
            assert.strictEqual(V.TICK_NOT_BRIDGEABLE, 'invalid: TICK (not bridgeable to DEST_COIN)');
            assert.strictEqual(V.TICK_NOT_BRIDGED,    'invalid: TICK (not bridged)');
            assert.strictEqual(V.BTC_ADDRESS,         'invalid: BTC_ADDRESS');
            assert.strictEqual(V.ORIGIN_ADDRESS,      'invalid: ORIGIN_ADDRESS');
        });

        it('carries a user format for exactly v0, v1, v3 and v4', function(){
            let { handler } = makeHandler();
            assert.deepStrictEqual(Object.keys(handler.formats).sort(), ['0','1','3','4']);
            assert.strictEqual(handler.formats[0], 'VERSION|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO');
            assert.strictEqual(handler.formats[1], 'VERSION|BTC_ADDRESS|AMOUNT|MEMO');
            assert.strictEqual(handler.formats[3], 'VERSION|TICK|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO');
            assert.strictEqual(handler.formats[4], 'VERSION|TICK|ORIGIN_ADDRESS|AMOUNT|MEMO');
        });
    });
});

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('shared gates', function(){
        it('refuses a version byte outside 0-5 before reading anything', async function(){
            let { handler, indexerDb } = makeHandler();
            let data = makeData(9, 'BTC');
            await handler.parse(['9', 'DOGE', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: VERSION (unknown)');
            assert.strictEqual(indexerDb.getTokenInfo.callCount, 0);
            assert.strictEqual(indexerDb.getAddressBalances.callCount, 0);
        });

        it('refuses every version below its activation and reads nothing', async function(){
            // Mainnet parks both gates at the house sentinel 9999999999.
            for(let format of [0, 1, 2, 3, 4, 5]){
                let { handler, indexerDb } = makeHandler({ coin: 'BTC', network: 'mainnet' });
                let data = makeData(format, 'BTC');
                await handler.parse([String(format), 'DOGE', DEST, '1', ''], data, null);
                assert.strictEqual(data['STATUS'], 'invalid: XBRIDGE before activation',
                    'v' + format + ' below activation');
                assert.strictEqual(indexerDb.getTokenInfo.callCount, 0, 'v' + format + ' read a token');
                assert.strictEqual(indexerDb.createXbridge.callCount, 1);
            }
        });
    });
});

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('shared gates', function(){
        // Row 28: XCHAIN_BRIDGE_ACTIVATION is keyed '<COIN>:<network>' because the three
        // chains reach the flag day at three heights, so the handler has to hand the map its
        // OWN coin. The shipped map answers the same for every coin on every network (0 on
        // regtest, the sentinel elsewhere), which is exactly the shape a coin-blind call
        // would also produce, so this case writes a chain-specific regtest slot for its own
        // duration and drives the real handler against it: DOGE must refuse at a height BTC
        // is admitted at, on one network, through nothing but ctx.coin. The slot is a
        // stub on the registry read: the fake answers by the COIN the handler passes,
        // which is the only way a DOGE-specific height can reach it.
        it('keys the activation on the chain being parsed, not on the network alone', async function(){
            stubGate(sinon, XCHAIN_BRIDGE_KEY, false).callsFake((key, network, coin, height) =>
                (coin === 'DOGE' ? Number(height) >= 500 : Number(height) >= 0));
            try {
                let doge = makeHandler({ coin: 'DOGE', network: 'regtest' });
                let dogeData = makeData(1, 'DOGE', { BLOCK_INDEX: 100 });
                await doge.handler.parse(['1', DEST, '1', ''], dogeData, null);
                assert.strictEqual(dogeData['STATUS'], 'invalid: XBRIDGE before activation',
                    'a DOGE block below the DOGE slot must refuse');

                // Same network, same height, a chain the DOGE slot says nothing about.
                let btc = makeHandler({ coin: 'BTC', network: 'regtest' });
                let btcData = makeData(0, 'BTC', { BLOCK_INDEX: 100 });
                await btc.handler.parse(['0', 'DOGE', DEST, '1', ''], btcData, null);
                assert.notStrictEqual(btcData['STATUS'], 'invalid: XBRIDGE before activation',
                    'BTC inherits the bare regtest key (0) and must still be armed at the same height');

                // And the DOGE chain crosses at its own number, not at BTC's.
                let dogeAt = makeHandler({ coin: 'DOGE', network: 'regtest' });
                let dogeAtData = makeData(1, 'DOGE', { BLOCK_INDEX: 500 });
                await dogeAt.handler.parse(['1', DEST, '1', ''], dogeAtData, null);
                assert.notStrictEqual(dogeAtData['STATUS'], 'invalid: XBRIDGE before activation',
                    'a DOGE block at the DOGE slot must be admitted past the activation gate');
            } finally {
                sinon.restore();
            }
            assert.strictEqual(require('../../../../src/consensus/gate_registry').get(XCHAIN_BRIDGE_KEY)['DOGE:regtest'], undefined,
                'the shipped map must be left exactly as it ships');
        });
    });
});

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('shared gates', function(){
        // The v0.20.0 arming train re-keyed TOKEN_BRIDGE_ACTIVATION to '<COIN>:<network>' and
        // sized three testnet heights, one per chain, because the tips differ by orders of
        // magnitude. Those heights only mean anything if the handler hands the map the coin
        // it is parsing: a coin-blind read resolves the bare network key, which holds the
        // sentinel on testnet, so every testnet chain would stay dark past its sized height
        // with no test red and an announcement promising otherwise. The shipped map answers
        // the same for every coin on regtest, so this case stubs a DOGE-specific slot on the
        // registry read, the same way the XCHAIN case above does, and drives the real handler
        // with a v3: DOGE must refuse at a height BTC is admitted at, through ctx.coin alone.
        it('keys the token-bridge activation on the chain being parsed, not on the network alone', async function(){
            stubGate(sinon, TOKEN_BRIDGE_KEY, false).callsFake((key, network, coin, height) =>
                (coin === 'DOGE' ? Number(height) >= 500 : Number(height) >= 0));
            try {
                let doge = makeHandler({ coin: 'DOGE', network: 'regtest' });
                let dogeData = makeData(3, 'DOGE', { BLOCK_INDEX: 100 });
                await doge.handler.parse(['3', 'FUFU', 'BTC', DEST, '1', ''], dogeData, null);
                assert.strictEqual(dogeData['STATUS'], 'invalid: XBRIDGE before activation',
                    'a DOGE v3 below the DOGE token slot must refuse; if it did not, the handler read ' +
                    'TOKEN_BRIDGE_ACTIVATION without the coin and the per-chain testnet heights are dead');

                // Same network, same height, a chain the DOGE slot says nothing about.
                let btc = makeHandler({ coin: 'BTC', network: 'regtest' });
                let btcData = makeData(3, 'BTC', { BLOCK_INDEX: 100 });
                await btc.handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], btcData, null);
                assert.notStrictEqual(btcData['STATUS'], 'invalid: XBRIDGE before activation',
                    'BTC inherits the bare regtest key (0) and must still be past the token gate at the same height');

                // And the DOGE chain crosses at its own number, not at BTC's.
                let dogeAt = makeHandler({ coin: 'DOGE', network: 'regtest' });
                let dogeAtData = makeData(3, 'DOGE', { BLOCK_INDEX: 500 });
                await dogeAt.handler.parse(['3', 'FUFU', 'BTC', DEST, '1', ''], dogeAtData, null);
                assert.notStrictEqual(dogeAtData['STATUS'], 'invalid: XBRIDGE before activation',
                    'a DOGE v3 at the DOGE token slot must be admitted past the activation gate');
            } finally {
                sinon.restore();
            }
            assert.strictEqual(require('../../../../src/consensus/gate_registry').get(TOKEN_BRIDGE_KEY)['DOGE:regtest'], undefined,
                'the shipped map must be left exactly as it ships');
        });
    });
});

describe('XBRIDGE action handler @regression @tier3', function(){
    describe('shared gates', function(){
        it('refuses a v0 lock off BTC', async function(){
            let { handler } = makeHandler({ coin: 'DOGE' });
            let data = makeData(0, 'DOGE');
            await handler.parse(['0', 'BTC', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: XBRIDGE (BTC only)');
        });

        it('refuses a v1 burn on BTC', async function(){
            let { handler } = makeHandler({ coin: 'BTC' });
            let data = makeData(1, 'BTC');
            await handler.parse(['1', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: XBRIDGE v1 is not valid on BTC');
        });

        it('refuses a broadcast v2 and a broadcast v5 on every chain', async function(){
            for(let coin of ['BTC', 'DOGE']){
                let a = makeHandler({ coin });
                let d2 = makeData(2, coin);
                await a.handler.parse(['2'], d2, null);
                assert.strictEqual(d2['STATUS'], 'invalid: XBRIDGE v2 is system-injected', coin);

                let b = makeHandler({ coin });
                let d5 = makeData(5, coin);
                await b.handler.parse(['5'], d5, null);
                assert.strictEqual(d5['STATUS'], 'invalid: XBRIDGE v5 is system-injected', coin);
            }
        });

        it('leaves a system-injected v2 or v5 entirely to the settle pass', async function(){
            for(let format of [2, 5]){
                let { handler, indexerDb, mapper } = makeHandler({ coin: 'DOGE' });
                let data = makeData(format, 'DOGE', { IS_SYNTHETIC: true });
                await handler.parse([String(format)], data, null);
                // No verdict, no action row, no ledger record: bridge_settle.js owns the leg.
                assert.strictEqual(data['STATUS'], undefined, 'v' + format + ' wrote a verdict');
                assert.strictEqual(indexerDb.createXbridge.callCount, 0);
                assert.strictEqual(indexerDb.createDebit.callCount, 0);
                assert.strictEqual(mapper.createMappings.callCount, 0);
            }
        });
    });
});
