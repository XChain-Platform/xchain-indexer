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
// XBRIDGE handler (lane L3): v0/v3 lock, v1/v4 burn, the shared activation and chain
// gates, and the refusal of a broadcast v2/v5.
//
// Every expected verdict below is written as a LITERAL, never as XBridge.VERDICTS.X. A
// verdict is persisted in index_statuses and enters actions_hash, so asserting the
// handler's own constant against itself would pass however the string was renamed; the
// literals are what pin the consensus strings.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockDb, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const Utility  = require('../../../src/utility.js');
const configjs = require('../../../src/config.js');
const XBridge  = require('../../../src/actions/xbridge.js');
const { XCHAIN_BRIDGE_ACTIVATION } = require('../../../src/xchain_bridge_activation.js');

// Regtest p2pkh version byte is 0x6f on BTC, LTC and DOGE alike, so one regtest address
// validates on every chain the rail runs; the tests that care about a WRONG network use
// a mainnet config instead.
const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST   = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

// Placeholder keyless escrow / bridged-row-owner addresses. Lane L2 mints the real ones
// in the coin bundles; the handler only ever reads them out of config, so the literal
// value is irrelevant to what is under test here.
const BRIDGE_DOGE = 'mxchainbridgedogeXXXXXXXXXXXXXXXXX';
const BRIDGE_LTC  = 'mxchainbridgeltcXXXXXXXXXXXXXXXXXX';
const BRIDGE_BTC  = 'mxchainbridgebtcXXXXXXXXXXXXXXXXXX';

const XCHAIN_TICK_ID = 1;   // the mock db's getTickerId default, so the fee and a v0 lock
const TOKEN_TICK_ID  = 7;   // share one balance exactly as they do on chain

// Build a handler over a real Utility and a stubbed database. The config is a FRESH
// object per call (config.getConfig builds one every time) and the same object is handed
// to Utility, so patching it here cannot leak into another test.
function makeHandler(opts){
    opts = opts || {};
    let coin    = opts.coin    || 'BTC';
    let network = opts.network || 'regtest';

    let config = configjs.getConfig(coin, network);

    // Lane L2's coin-bundle entries, supplied here so this suite does not wait on it.
    config['ADDRESS']['BRIDGE_DOGE'] = BRIDGE_DOGE;
    config['ADDRESS']['BRIDGE_LTC']  = BRIDGE_LTC;
    config['ADDRESS']['BRIDGE_BTC']  = BRIDGE_BTC;
    config['GAS_SCHEDULE']['XBRIDGE_BASE'] = 5000;
    if(opts.noFeeDestination)
        config['ADDRESS']['FEE_DESTINATION'] = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    let util      = new Utility(config);
    let indexerDb = createMockDb();
    let mapper    = { createMappings: sinon.stub().resolves() };

    // The two writers lane L3 raised as seam gaps (see the handler's file header): the
    // xbridges action row and the tokens.bridged setter. Stubbed here so the payload
    // each one must receive is pinned by test before either is built.
    indexerDb.createXbridge    = sinon.stub().resolves();
    indexerDb.setTokenBridged  = sinon.stub().resolves();

    let actionsCtx = {
        config:    config,
        util:      util,
        mapper:    mapper,
        decoderDb: createMockDb(),
        indexerDb: indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true)
        }
    };

    util.resetLists();

    return { handler: new XBridge(actionsCtx), indexerDb, config, util, mapper };
}

// One data object shaped the way actions.js hands it to a handler.
function makeData(format, coin, overrides){
    return createBaseData(Object.assign({
        ACTION:       'XBRIDGE',
        FORMAT:       format,
        COIN:         coin || 'BTC',
        SOURCE:       SOURCE,
        BLOCK_INDEX:  100,
        ACTION_INDEX: 42,
        TX_OUTPUTS:   []
    }, overrides || {}));
}

// Collect the [tick, amount, address] triples the handler actually wrote.
function ledger(indexerDb, kind){
    let stub = (kind === 'credit') ? indexerDb.createCredit : indexerDb.createDebit;
    return stub.getCalls().map(c => [c.args[1], String(c.args[2]), c.args[3]]);
}

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

        // Row 28: XCHAIN_BRIDGE_ACTIVATION is keyed '<COIN>:<network>' because the three
        // chains reach the flag day at three heights, so the handler has to hand the map its
        // OWN coin. The shipped map answers the same for every coin on every network (0 on
        // regtest, the sentinel elsewhere), which is exactly the shape a coin-blind call
        // would also produce, so this case writes a chain-specific regtest slot for its own
        // duration and drives the real handler against it: DOGE must refuse at a height BTC
        // is admitted at, on one network, through nothing but ctx.coin.
        it('keys the activation on the chain being parsed, not on the network alone', async function(){
            XCHAIN_BRIDGE_ACTIVATION['DOGE:regtest'] = 500;
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
                delete XCHAIN_BRIDGE_ACTIVATION['DOGE:regtest'];
            }
            assert.strictEqual(XCHAIN_BRIDGE_ACTIVATION['DOGE:regtest'], undefined,
                'the shipped map must be left exactly as it ships');
        });

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

    describe('v0 lock (XCHAIN, BTC only)', function(){

        function setup(opts){
            opts = opts || {};
            let h = makeHandler({ coin: 'BTC' });
            h.indexerDb.getTokenInfo.resolves(createTokenInfo({
                TICK: 'XCHAIN', TICK_ID: XCHAIN_TICK_ID, DECIMALS: 8
            }));
            h.indexerDb.getAddressBalances.resolves(
                opts.balances || { [XCHAIN_TICK_ID]: '100' });
            return h;
        }

        it('debits the source, credits the destination chain escrow and charges XBRIDGE_BASE', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', 'note'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(ledger(indexerDb, 'debit'), [
                ['XCHAIN', '5.05', SOURCE]          // 5 locked + 0.05 protocol fee, consolidated
            ]);
            // 5 into the keyless DOGE escrow, 0.05 to the donation address the fee routes to.
            let credits = ledger(indexerDb, 'credit');
            assert.ok(credits.some(c => c[0] === 'XCHAIN' && c[1] === '5' && c[2] === BRIDGE_DOGE),
                'escrow credit missing: ' + JSON.stringify(credits));

            // The row the hub polls carries the destination chain and the signed precision.
            let row = indexerDb.createXbridge.firstCall.args[0];
            assert.strictEqual(row['STATUS'], 'valid');
            assert.strictEqual(row['DEST_CHAIN'], 'DOGE');
            assert.strictEqual(row['DECIMALS'], 8);
            assert.strictEqual(row['AMOUNT'], '5');
        });

        it('never writes an escrow row (the escrow is an ordinary balance)', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexerDb.createEscrow.callCount, 0);
        });

        it('refuses this chain as the destination', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'BTC', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DEST_COIN');
            assert.strictEqual(indexerDb.createDebit.callCount, 0);
        });

        it('refuses an unsupported destination coin', async function(){
            let { handler } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'XYZ', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DEST_COIN');
        });

        it('refuses a destination coin with no escrow address configured', async function(){
            let h = setup();
            delete h.config['ADDRESS']['BRIDGE_LTC'];
            let data = makeData(0, 'BTC');
            await h.handler.parse(['0', 'LTC', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DEST_COIN');
        });

        it('validates DEST_ADDRESS against the DESTINATION coin and network', async function(){
            let { handler } = setup();
            let data = makeData(0, 'BTC');
            // A mainnet DOGE address on a regtest rail: right coin, wrong network.
            await handler.parse(['0', 'DOGE', 'DFundmtrigqPCjWQiMFHy1kBzJJQBm9m5Y', '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DEST_ADDRESS');
        });

        it('refuses a zero amount and one past the token DECIMALS', async function(){
            let a = setup();
            let d1 = makeData(0, 'BTC');
            await a.handler.parse(['0', 'DOGE', DEST, '0', ''], d1, null);
            assert.strictEqual(d1['STATUS'], 'invalid: AMOUNT');

            let b = setup();
            let d2 = makeData(0, 'BTC');
            await b.handler.parse(['0', 'DOGE', DEST, '0.000000001', ''], d2, null);
            assert.strictEqual(d2['STATUS'], 'invalid: AMOUNT');
        });

        it('refuses an amount above the balance', async function(){
            let { handler } = setup({ balances: { [XCHAIN_TICK_ID]: '4' } });
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds');
        });

        it('refuses when the amount fits but the amount plus the fee does not', async function(){
            // The double-spend the in-memory debit closes: on BTC the fee is paid out of the
            // same XCHAIN balance a v0 lock moves, so a 5.00 balance cannot fund a 5 lock
            // AND its 0.05 fee.
            let { handler, indexerDb } = setup({ balances: { [XCHAIN_TICK_ID]: '5' } });
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (FEE)');
            assert.strictEqual(indexerDb.createDebit.callCount, 0);
        });

        it('refuses a sleeping source', async function(){
            let { handler } = setup();
            let data = makeData(0, 'BTC');
            let h = makeHandler({ coin: 'BTC' });
            h.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'XCHAIN', TICK_ID: XCHAIN_TICK_ID, DECIMALS: 8 }));
            h.indexerDb.getAddressBalances.resolves({ [XCHAIN_TICK_ID]: '100' });
            h.indexerDb.isActionAllowed.resolves(false);
            await h.handler.parse(['0', 'DOGE', DEST, '5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (sleeping)');
            assert.ok(handler);
        });

        it('refuses a memo past MAX_MEMO_LENGTH', async function(){
            let { handler, config } = setup();
            let data = makeData(0, 'BTC');
            await handler.parse(['0', 'DOGE', DEST, '5', 'x'.repeat(config['MAX_MEMO_LENGTH'] + 1)], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: MEMO (length)');
        });
    });

    describe('v1 burn (XCHAIN, never on BTC)', function(){

        function setup(opts){
            opts = opts || {};
            let h = makeHandler(Object.assign({ coin: 'DOGE' }, opts));
            h.indexerDb.getTokenInfo.resolves(opts.tokenInfo === undefined
                ? createTokenInfo({ TICK: 'XCHAIN', TICK_ID: XCHAIN_TICK_ID, DECIMALS: 8 })
                : opts.tokenInfo);
            h.indexerDb.getAddressBalances.resolves(opts.balances || { [XCHAIN_TICK_ID]: '100' });
            return h;
        }

        it('debits the source with no offsetting credit, so supply falls', async function(){
            let { handler, indexerDb } = setup({ noFeeDestination: true });
            let data = makeData(1, 'DOGE');
            await handler.parse(['1', DEST, '2', ''], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            // 2 burned + 0.05 fee, both debits; the only credit is the fee donation.
            assert.deepStrictEqual(ledger(indexerDb, 'debit'), [['XCHAIN', '2.05', SOURCE]]);
            let credits = ledger(indexerDb, 'credit');
            assert.ok(!credits.some(c => c[1] === '2'), 'a burn must credit nobody the burned amount');
            // Supply is recomputed from the ledger at the end of the action.
            assert.strictEqual(indexerDb.updateTokens.callCount, 1);
            assert.strictEqual(indexerDb.createXbridge.firstCall.args[0]['DEST_CHAIN'], 'BTC');
        });

        it('refuses a BTC_ADDRESS that is not a BTC address on this network', async function(){
            let { handler } = setup({ noFeeDestination: true });
            let data = makeData(1, 'DOGE');
            await handler.parse(['1', 'not-an-address', '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: BTC_ADDRESS');
        });

        it('refuses when this chain holds no XCHAIN row yet', async function(){
            let { handler } = setup({ noFeeDestination: true, tokenInfo: false });
            let data = makeData(1, 'DOGE');
            await handler.parse(['1', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (unknown)');
        });

        it('refuses off BTC when the protocol fee has no native coin output', async function(){
            // detectFeePaymentMode rejects a missing fee output off BTC rather than falling
            // back to an XCHAIN debit, which is what the XBRIDGE_BASE floor is sized for.
            let { handler } = setup();
            let data = makeData(1, 'DOGE');
            await handler.parse(['1', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient fee (native coin output required)');
        });
    });

    describe('v3 lock (a native token on its origin chain)', function(){

        function setup(opts){
            opts = opts || {};
            let h = makeHandler({ coin: opts.coin || 'BTC' });
            let info = (opts.tokenInfo === undefined)
                ? createTokenInfo({
                    TICK: 'FUFU', TICK_ID: TOKEN_TICK_ID, DECIMALS: 2,
                    BRIDGE_CHAINS: opts.bridgeChains === undefined ? 'DOGE' : opts.bridgeChains,
                    MIN_DEPTH: opts.minDepth
                })
                : opts.tokenInfo;
            h.indexerDb.getTokenInfo.resolves(info);
            h.indexerDb.getAddressBalances.resolves(opts.balances || {
                [TOKEN_TICK_ID]: '100', [XCHAIN_TICK_ID]: '10'
            });
            return h;
        }

        it('locks into the destination escrow and stamps the row DECIMALS and MIN_DEPTH', async function(){
            let { handler, indexerDb } = setup({ minDepth: 3 });
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'FUFU', 'DOGE', DEST, '5.25', ''], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(ledger(indexerDb, 'credit').some(c => c[0] === 'FUFU' && c[1] === '5.25' && c[2] === BRIDGE_DOGE));
            assert.ok(ledger(indexerDb, 'debit').some(d => d[0] === 'FUFU' && d[1] === '5.25' && d[2] === SOURCE));

            let row = indexerDb.createXbridge.firstCall.args[0];
            assert.strictEqual(row['DECIMALS'], 2, 'decimals are stamped from the origin row');
            assert.strictEqual(row['MIN_DEPTH'], 3, 'min_depth is stamped, not re-read at poll time');
            assert.strictEqual(row['DEST_CHAIN'], 'DOGE');

            // The first applied lock sets the origin row's bridged bit.
            assert.strictEqual(indexerDb.setTokenBridged.callCount, 1);
            assert.strictEqual(indexerDb.setTokenBridged.firstCall.args[0], 'FUFU');
        });

        it('stamps MIN_DEPTH 0 when the issuer set none', async function(){
            let { handler, indexerDb } = setup({ minDepth: null });
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexerDb.createXbridge.firstCall.args[0]['MIN_DEPTH'], 0);
        });

        it('refuses a bridged copy: a rooted name is burned with v4, never locked', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'DOGE.FUFU', 'LTC', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (not native here)');
            // The shape guard runs before any read, so no junk ticker id is interned.
            assert.strictEqual(indexerDb.getTokenInfo.callCount, 0);
        });

        it('refuses the GAS tick in any case: XCHAIN keeps v0', async function(){
            for(let tick of ['XCHAIN', 'xchain']){
                let { handler } = setup();
                let data = makeData(3, 'BTC');
                await handler.parse(['3', tick, 'DOGE', DEST, '1', ''], data, null);
                assert.strictEqual(data['STATUS'], 'invalid: TICK (use XBRIDGE v0)', tick);
            }
        });

        it('refuses a dotted native name, including a subasset of this chain own root', async function(){
            for(let tick of ['PEPE.CASH', 'BTC.PEPE.CASH', 'BTC.SUB']){
                let { handler } = setup();
                let data = makeData(3, 'BTC');
                await handler.parse(['3', tick, 'DOGE', DEST, '1', ''], data, null);
                assert.strictEqual(data['STATUS'], 'invalid: TICK (subassets are not bridgeable yet)', tick);
            }
        });

        it('refuses a native tick too long to root, and admits the longest one that fits', async function(){
            // MAX_TICK_LENGTH is 250 and the BTC root costs 4 characters ("BTC" plus the dot).
            let tooLong = 'A'.repeat(247);
            let a = setup();
            let d1 = makeData(3, 'BTC');
            await a.handler.parse(['3', tooLong, 'DOGE', DEST, '1', ''], d1, null);
            assert.strictEqual(d1['STATUS'], 'invalid: TICK (too long to bridge)');

            let longest = 'A'.repeat(246);
            let b = setup();
            let d2 = makeData(3, 'BTC');
            await b.handler.parse(['3', longest, 'DOGE', DEST, '1', ''], d2, null);
            assert.strictEqual(d2['STATUS'], 'valid');
        });

        it('refuses a destination the issuer never opted into', async function(){
            for(let chains of [null, '', '-', 'LTC']){
                let { handler } = setup({ bridgeChains: chains });
                let data = makeData(3, 'BTC');
                await handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], data, null);
                assert.strictEqual(data['STATUS'], 'invalid: TICK (not bridgeable to DEST_COIN)',
                    'BRIDGE_CHAINS=' + chains);
            }
        });

        it('admits a destination listed beside others', async function(){
            let { handler } = setup({ bridgeChains: 'LTC,DOGE' });
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('refuses an amount past the token own DECIMALS', async function(){
            let { handler } = setup();
            let data = makeData(3, 'BTC');
            await handler.parse(['3', 'FUFU', 'DOGE', DEST, '1.234', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: AMOUNT');
        });

        it('refuses a list-blocked source', async function(){
            let h = setup();
            // Sleep checks pass, the source/tick authorization check does not.
            h.indexerDb.isActionAllowed.callsFake(async (address, tick) => !(address && tick));
            let data = makeData(3, 'BTC');
            await h.handler.parse(['3', 'FUFU', 'DOGE', DEST, '1', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not authorized)');
        });
    });

    describe('v4 burn (a bridged copy on the chain holding it)', function(){

        function setup(opts){
            opts = opts || {};
            let h = makeHandler({ coin: 'DOGE', noFeeDestination: true });
            h.indexerDb.getTokenInfo.resolves(opts.tokenInfo === undefined
                ? createTokenInfo({
                    TICK: 'BTC.FUFU', TICK_ID: TOKEN_TICK_ID, DECIMALS: 2,
                    OWNER: (opts.owner === undefined) ? BRIDGE_BTC : opts.owner
                })
                : opts.tokenInfo);
            h.indexerDb.getAddressBalances.resolves(opts.balances || {
                [TOKEN_TICK_ID]: '100', [XCHAIN_TICK_ID]: '10'
            });
            return h;
        }

        it('debits the copy and names the origin chain, with no bridged bit to set', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'BTC.FUFU', DEST, '2', ''], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(ledger(indexerDb, 'debit').some(d => d[0] === 'BTC.FUFU' && d[1] === '2' && d[2] === SOURCE));
            assert.ok(!ledger(indexerDb, 'credit').some(c => c[0] === 'BTC.FUFU'),
                'a burn must credit nobody the burned tick');
            assert.strictEqual(indexerDb.createXbridge.firstCall.args[0]['DEST_CHAIN'], 'BTC');
            assert.strictEqual(indexerDb.setTokenBridged.callCount, 0);
        });

        it('refuses a native row: a burn needs a bridged copy', async function(){
            let { handler, indexerDb } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'FUFU', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (not bridged)');
            assert.strictEqual(indexerDb.getTokenInfo.callCount, 0);
        });

        it('refuses a row rooted at this chain own coin', async function(){
            let { handler } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'DOGE.FUFU', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (not bridged)');
        });

        it('refuses a rooted row the bridge role does not own', async function(){
            let { handler } = setup({ owner: SOURCE });
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'BTC.FUFU', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (not bridged)');
        });

        it('validates ORIGIN_ADDRESS against the ORIGIN chain', async function(){
            let { handler } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'BTC.FUFU', 'not-an-address', '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: ORIGIN_ADDRESS');
        });

        it('reaches the same row and the same verdict for a lower-case root', async function(){
            let { handler } = setup();
            let data = makeData(4, 'DOGE');
            await handler.parse(['4', 'btc.FUFU', DEST, '2', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});
