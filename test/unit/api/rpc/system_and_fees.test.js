/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The system and fee JSON-RPC families (src/api/rpc/system.js, fees.js), driven
 * against the indexer double: the committed-only height reads, the liveness
 * the health handler reports at call time, the block-hash triple's version
 * derivation, the fee quotes' delegation, and the regtest-only dry-run gate.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const merkle = require('../../../../src/consensus/merkle.js');
const { buildSystemRpc } = require('../../../../src/api/rpc/system.js');
const { buildFeesRpc } = require('../../../../src/api/rpc/fees.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

describe('JSON-RPC system family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('ping answers success with no database', async function () {
        const rpc = buildSystemRpc({ indexer: fakeIndexer(), liveness: { indexerRunning: true, indexerError: null } });
        assert.deepStrictEqual(await rpc.ping(), { status: 'success' });
    });

    it('health reads the committed height off apiView() and reports liveness as it is NOW', async function () {
        const view = recordingView({ getLatestBlockIndex: 190, getReorgHealthStats: { reorg_count: 0 } });
        const indexer = fakeIndexer({ view, lastDecoderBlock: 200, isSynced: () => false, stallReason: null,
                                      lastHubConfigFetchAt: null });
        const liveness = { indexerRunning: true, indexerError: null };
        const rpc = buildSystemRpc({ indexer, liveness });
        const before = await rpc.health();
        assert.strictEqual(before.running, true);
        assert.strictEqual(before.lastIndexedBlock, 190);
        assert.strictEqual(before.lag, 10);
        assert.deepStrictEqual(view.calls.map(c => c[0]), ['getLatestBlockIndex', 'getReorgHealthStats']);
        // The drain flips the shared object after boot; the handler must see the flip.
        liveness.indexerRunning = false;
        liveness.indexerError   = new Error('boom');
        const after = await rpc.health();
        assert.strictEqual(after.running, false);
    });

    it('health survives an unreachable database with a null height', async function () {
        const view = recordingView({ getLatestBlockIndex: () => { throw new Error('ECONNREFUSED'); },
                                     getReorgHealthStats: () => { throw new Error('ECONNREFUSED'); } });
        const indexer = fakeIndexer({ view, isSynced: () => false, stallReason: null, lastHubConfigFetchAt: null });
        const rpc = buildSystemRpc({ indexer, liveness: { indexerRunning: true, indexerError: null } });
        const res = await rpc.health();
        assert.strictEqual(res.lastIndexedBlock, null);
        assert.strictEqual(res.running, true);
    });

});

describe('JSON-RPC system family: getlatestblock @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getlatestblock reports the committed height, the in-flight block and the decoder lag', async function () {
        const view = recordingView({ getLatestBlockIndex: 100 });
        const indexer = fakeIndexer({ view, lastDecoderBlock: 104 });
        // An open block transaction with blockIndex stamped is the in-flight signal.
        indexer.indexerDb.transactionConnection = {};
        indexer.indexerDb.blockIndex = 101;
        const rpc = buildSystemRpc({ indexer, liveness: {} });
        assert.deepStrictEqual(await rpc.getlatestblock(),
            { block_index: 100, in_flight_block: 101, decoder_block: 104, lag: 4 });
        // A block that committed while reading is no longer in flight.
        indexer.indexerDb.blockIndex = 100;
        assert.strictEqual((await rpc.getlatestblock()).in_flight_block, null);
    });

    it('getlatestblock and health refuse before the database exists', async function () {
        const rpc = buildSystemRpc({ indexer: fakeIndexer({ indexerDb: null, decoderDb: null, isSynced: () => false,
                                                            stallReason: null, lastHubConfigFetchAt: null }),
                                     liveness: { indexerRunning: true, indexerError: null } });
        assert.deepStrictEqual(await rpc.getlatestblock(), { error: 'indexer database not ready' });
        assert.strictEqual((await rpc.health()).lastIndexedBlock, null);
    });

    it('getlatestblock logs and answers a generic error when the read throws', async function () {
        const error = sinon.stub(observability.getLogger(), 'error');
        const view = recordingView({ getLatestBlockIndex: () => { throw new Error('gone'); } });
        const rpc = buildSystemRpc({ indexer: fakeIndexer({ view }), liveness: {} });
        assert.deepStrictEqual(await rpc.getlatestblock(), { error: 'failed to look up latest block' });
        assert.ok(error.calledOnce);
    });

});

describe('JSON-RPC system family: getblockhashes @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    describe('getblockhashes', function () {
        function rpcFor(stored, opts = {}) {
            const view = recordingView({ getLatestBlockIndex: 500, getStoredBlockHashes: (h) => stored(h) });
            const decoderView = recordingView({ getDecoderBlockHashRow: (h) => [{ block_hash: 'bb'.repeat(32) }] });
            const indexer = fakeIndexer(Object.assign({ view, decoderView }, opts));
            return { rpc: buildSystemRpc({ indexer, liveness: {} }), view, decoderView };
        }

        it('defaults to the latest committed height and signs the triple with its versions', async function () {
            const stored = (h) => ({ block_index: h, block_time: 1700000000, ledger_hash: 'a1'.repeat(32),
                                     actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
                                     state_root: 'f6'.repeat(32), block_merkle_root: '07'.repeat(32) });
            const { rpc, view, decoderView } = rpcFor(stored);
            const res = await rpc.getblockhashes({});
            assert.strictEqual(res.block_index, 500);
            assert.strictEqual(res.coin, 'BTC');
            assert.strictEqual(res.block_hash, 'bb'.repeat(32));
            assert.strictEqual(res.block_merkle_version, merkle.BLOCK_MERKLE_VERSION);
            assert.ok(res.state_root_version === 1 || res.state_root_version === 2);
            assert.strictEqual(res.balances_root, null);
            assert.deepStrictEqual(view.calls[0], ['getLatestBlockIndex']);
            assert.deepStrictEqual(view.calls[1], ['getStoredBlockHashes', 500]);
            assert.deepStrictEqual(decoderView.calls, [['getDecoderBlockHashRow', 500]]);
        });

        it('answers null versions for a row without roots, and refuses bad or unindexed heights', async function () {
            const { rpc } = rpcFor((h) => (h === 7 ? { block_index: 7, block_time: null } : null));
            const res = await rpc.getblockhashes({ block_index: 7 });
            assert.strictEqual(res.state_root_version, null);
            assert.strictEqual(res.block_merkle_version, null);
            assert.strictEqual(res.block_time, null);
            assert.deepStrictEqual(await rpc.getblockhashes({ block_index: -1 }), { error: 'invalid block_index' });
            assert.deepStrictEqual(await rpc.getblockhashes({ block_index: 9 }), { error: 'block not indexed: 9' });
        });

        it('refuses before either database is ready and reports a throw generically', async function () {
            sinon.stub(observability.getLogger(), 'error');
            const rpc = buildSystemRpc({ indexer: fakeIndexer({ decoderDb: null }), liveness: {} });
            assert.deepStrictEqual(await rpc.getblockhashes({}), { error: 'indexer database not ready' });
            const { rpc: throwing } = rpcFor(() => { throw new Error('gone'); });
            assert.deepStrictEqual(await throwing.getblockhashes({ block_index: 1 }),
                { error: 'failed to look up block hashes' });
        });
    });
});

// A fee-family indexer double. oraclefeequote is a public read off the raw
// handle, so the tip reads sit on indexerDb itself rather than on its apiView().
function indexerWithActions(actions, util, tip = { getLatestBlockIndex: async () => 9, getBlockTime: async () => 1700000000 }) {
    const indexer = fakeIndexer({ actions, util });
    Object.assign(indexer.indexerDb, tip);
    return indexer;
}

describe('JSON-RPC fee family @regression @tier1', function () {
    // Building the family with the dry-run on logs its warning; keep that off the
    // test output and assert on it where it is the subject.
    let warn;
    beforeEach(function () { warn = sinon.stub(observability.getLogger(), 'warn'); });
    afterEach(function () { sinon.restore(); });

    it('feequote, preflight, feeschedule and feequotedryrun delegate to the actions engine', async function () {
        const actions = {
            computeFeeQuote:       sinon.stub().resolves({ valid: true, fee: '1' }),
            computePreflight:      sinon.stub().resolves({ valid: true, supported: true }),
            getFeeSchedule:        sinon.stub().resolves({ schedule: [] }),
            computeFeeQuoteDryRun: sinon.stub().resolves({ valid: false })
        };
        const rpc = buildFeesRpc({ indexer: indexerWithActions(actions), ENABLE_DRYRUN: true });
        assert.deepStrictEqual(await rpc.feequote({ action: 'SEND', params: {}, source: 'a', feeOutputSats: 1 }), { valid: true, fee: '1' });
        assert.deepStrictEqual(actions.computeFeeQuote.firstCall.args[0], { action: 'SEND', params: {}, source: 'a', feeOutputSats: 1 });
        assert.deepStrictEqual(await rpc.preflight({ action: 'SEND', params: {}, source: 'a', feeMode: 'native' }), { valid: true, supported: true });
        assert.deepStrictEqual(await rpc.feeschedule(), { schedule: [] });
        assert.deepStrictEqual(await rpc.feequotedryrun({ action: 'SEND', params: {}, source: 'a', feeOutputs: [] }), { valid: false });
    });

    it('validates the action name and readiness before touching the engine', async function () {
        const actions = { computeFeeQuote: sinon.stub(), computePreflight: sinon.stub(), computeFeeQuoteDryRun: sinon.stub() };
        const rpc = buildFeesRpc({ indexer: indexerWithActions(actions), ENABLE_DRYRUN: true });
        for (const name of ['feequote', 'preflight', 'feequotedryrun'])
            assert.deepStrictEqual(await rpc[name]({ action: 42 }), { error: 'action is required' });
        const notReady = buildFeesRpc({ indexer: fakeIndexer({ actions: null }), ENABLE_DRYRUN: true });
        for (const name of ['feequote', 'preflight', 'feequotedryrun'])
            assert.deepStrictEqual(await notReady[name]({ action: 'SEND' }), { error: 'indexer not ready' });
        assert.deepStrictEqual(await notReady.feeschedule(), { error: 'indexer not ready' });
        assert.ok(actions.computeFeeQuote.notCalled && actions.computePreflight.notCalled);
    });

    it('reports engine throws generically, except the dry-run which surfaces the message', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const boom = new Error('vm cap');
        const actions = { computeFeeQuote: sinon.stub().rejects(boom), computePreflight: sinon.stub().rejects(boom),
                          getFeeSchedule: sinon.stub().rejects(boom), computeFeeQuoteDryRun: sinon.stub().rejects(boom) };
        const rpc = buildFeesRpc({ indexer: indexerWithActions(actions), ENABLE_DRYRUN: true });
        assert.deepStrictEqual(await rpc.feequote({ action: 'SEND' }), { error: 'failed to compute fee quote' });
        assert.deepStrictEqual(await rpc.preflight({ action: 'SEND' }), { error: 'failed to compute pre-flight' });
        assert.deepStrictEqual(await rpc.feeschedule(), { error: 'failed to fetch fee schedule' });
        assert.deepStrictEqual(await rpc.feequotedryrun({ action: 'SEND' }), { error: 'dry-run failed: vm cap' });
    });

    it('unregisters feequotedryrun unless ENABLE_DRYRUN, and warns loudly when it is on', function () {
        const off = buildFeesRpc({ indexer: fakeIndexer(), ENABLE_DRYRUN: false });
        assert.ok(!('feequotedryrun' in off), 'the raw dry-run must not be reachable off regtest');
        assert.ok(warn.notCalled);
        const on = buildFeesRpc({ indexer: fakeIndexer(), ENABLE_DRYRUN: true });
        assert.strictEqual(typeof on.feequotedryrun, 'function');
        assert.ok(warn.calledOnce && /feequotedryrun is ENABLED/.test(warn.firstCall.args[0]));
    });

});

describe('JSON-RPC fee family: oraclefeequote @regression @tier1', function () {
    beforeEach(function () { sinon.stub(observability.getLogger(), 'warn'); });
    afterEach(function () { sinon.restore(); });

    describe('oraclefeequote', function () {
        const util = {
            quoteOracleFee: sinon.stub(),
            bcformat: (v, d) => Number(v).toFixed(d),
            bcmul:    (a, b) => String(Number(a) * Number(b))
        };
        beforeEach(function () { util.quoteOracleFee.reset(); });

        it('quotes at the tip time by default, in native and sats, from utility.quoteOracleFee', async function () {
            util.quoteOracleFee.resolves({ valid: true, expectedFee: '0.5', belowDust: false });
            const rpc = buildFeesRpc({ indexer: indexerWithActions({}, util), ENABLE_DRYRUN: false });
            const res = await rpc.oraclefeequote({ oracleAddress: 'D1', giveTick: 'XCHAIN', fiatCode: 'USD', giveEscrow: '10' });
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.blockTime, 1700000000);
            assert.strictEqual(res.requiredFeeNative, '0.50000000');
            assert.strictEqual(res.requiredFeeSats, 50000000);
            assert.match(res.note, /^add a native-coin output/);
            const [ts, fields] = util.quoteOracleFee.firstCall.args;
            assert.strictEqual(ts, 1700000000);
            assert.deepStrictEqual(fields, { ORACLE_ADDRESS: 'D1', GIVE_COIN: 'BTC', GIVE_TICK: 'XCHAIN',
                                              FIAT_CODE: 'USD', GET_COIN: 'BTC', GIVE_ESCROW: '10' });
        });

        it('honours a caller-supplied blockTime, relays an invalid quote and the dust note', async function () {
            util.quoteOracleFee.onFirstCall().resolves({ valid: false, error: 'no price' })
                .onSecondCall().resolves({ valid: true, expectedFee: '0.00000001', belowDust: true });
            const rpc = buildFeesRpc({ indexer: indexerWithActions({}, util), ENABLE_DRYRUN: false });
            const body = { oracleAddress: 'D1', giveTick: 'T', fiatCode: 'USD', blockTime: 42 };
            assert.deepStrictEqual(await rpc.oraclefeequote(body), { valid: false, error: 'no price' });
            assert.strictEqual(util.quoteOracleFee.firstCall.args[0], 42);
            const dust = await rpc.oraclefeequote(body);
            assert.strictEqual(dust.belowDust, true);
            assert.match(dust.note, /below the dust threshold/);
        });

        it('refuses missing fields, an unready indexer, a chain with no block, and a throw', async function () {
            sinon.stub(observability.getLogger(), 'error');
            const rpc = buildFeesRpc({ indexer: indexerWithActions({}, util), ENABLE_DRYRUN: false });
            assert.deepStrictEqual(await rpc.oraclefeequote({ giveTick: 'T', fiatCode: 'USD' }),
                { error: 'oracleAddress, giveTick and fiatCode are required' });
            const noUtil = buildFeesRpc({ indexer: fakeIndexer({ util: null }), ENABLE_DRYRUN: false });
            assert.deepStrictEqual(await noUtil.oraclefeequote({ oracleAddress: 'D1', giveTick: 'T', fiatCode: 'USD' }),
                { error: 'indexer not ready' });
            const empty = buildFeesRpc({ indexer: indexerWithActions({}, util, { getLatestBlockIndex: async () => 0, getBlockTime: async () => false }),
                                         ENABLE_DRYRUN: false });
            assert.deepStrictEqual(await empty.oraclefeequote({ oracleAddress: 'D1', giveTick: 'T', fiatCode: 'USD' }),
                { error: 'no indexed block to quote against' });
            util.quoteOracleFee.rejects(new Error('gone'));
            assert.deepStrictEqual(await rpc.oraclefeequote({ oracleAddress: 'D1', giveTick: 'T', fiatCode: 'USD' }),
                { error: 'failed to compute oracle fee quote' });
        });
    });
});
