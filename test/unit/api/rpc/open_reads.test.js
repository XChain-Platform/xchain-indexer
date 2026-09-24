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
 * The open-read JSON-RPC families (src/api/rpc/orders.js, bets.js, bridge.js,
 * token_policy.js, cross_chain_calls.js), driven against the indexer double.
 * The reads that stamp a push generation must read it BEFORE the rows they
 * fence (HUB-RETRACT-1); the double records the call order so that ordering
 * is asserted by execution, not by grepping the source.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const { buildOrdersRpc } = require('../../../../src/api/rpc/orders.js');
const { buildBetsRpc } = require('../../../../src/api/rpc/bets.js');
const { buildBridgeRpc } = require('../../../../src/api/rpc/bridge.js');
const { buildTokenPolicyRpc, bridgePolicyHash } = require('../../../../src/api/rpc/token_policy.js');
const { buildCrossChainCallsRpc } = require('../../../../src/api/rpc/cross_chain_calls.js');
const { recordingView, fakeIndexer, callOrder } = require('./helpers/fake_indexer.js');

const ID = 'c'.repeat(64);
const NOT_READY = { error: 'indexer database not ready' };

describe('JSON-RPC order family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    function bookView(offers, overrides = {}) {
        return recordingView(Object.assign({
            getLatestBlockIndex: 80, getPushGeneration: 3, getBlockTime: 1700000000,
            getOpenCrossChainOffers: offers, getTickerId: 1, getTokenInfo: { DECIMALS: 4 }
        }, overrides));
    }
    const util = { isNull: (v) => v === null || v === undefined };

    it('getopencrosschainorders stamps the generation read BEFORE the rows and the give-side decimals', async function () {
        const offers = [{ action_index: 5, give_tick: 'FUFU', kind: 'ORDER' }];
        offers.next_cursor = 5;
        const view = bookView(offers);
        const rpc = buildOrdersRpc({ indexer: fakeIndexer({ view, util }) });
        const res = await rpc.getopencrosschainorders({ to_coin: 'DOGE', limit: 50, after_action_index: 1 });
        assert.ok(callOrder(view, 'getPushGeneration', 'getOpenCrossChainOffers').ordered, 'HUB-RETRACT-1: generation before rows');
        assert.deepStrictEqual(view.calls.find(c => c[0] === 'getOpenCrossChainOffers'), ['getOpenCrossChainOffers', 50, 1, 'DOGE', 1700000000]);
        // The orders array is the query's own (it carries next_cursor out of band), stamped in place.
        assert.strictEqual(res.orders, offers);
        assert.deepStrictEqual({ ...res, orders: undefined }, { latest_block_index: 80, network: 'regtest', count: 1, truncated: false, next_cursor: 5, orders: undefined });
        assert.deepStrictEqual({ ...offers[0] }, { action_index: 5, give_tick: 'FUFU', kind: 'ORDER', push_generation: 3, give_decimals: 4 });
    });

    it('getopencrosschainorders clamps the limit, warns on a truncated book and skips the expiry clock without a block time', async function () {
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const offers = [];
        offers.truncated = true;
        const view = bookView(offers, { getBlockTime: false });
        const rpc = buildOrdersRpc({ indexer: fakeIndexer({ view, util }) });
        const res = await rpc.getopencrosschainorders({ limit: 9999 });
        assert.strictEqual(res.truncated, true);
        assert.strictEqual(res.next_cursor, null);
        assert.ok(warn.calledOnce && /truncated/.test(warn.firstCall.args[0]));
        assert.deepStrictEqual(view.calls.find(c => c[0] === 'getOpenCrossChainOffers'), ['getOpenCrossChainOffers', 500, undefined, undefined, null]);
    });

    it('getopencrosschainorders refuses without a database and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        assert.deepStrictEqual(await buildOrdersRpc({ indexer: fakeIndexer({ indexerDb: null }) }).getopencrosschainorders({}), NOT_READY);
        const rpc = buildOrdersRpc({ indexer: fakeIndexer({ view: bookView(() => { throw new Error('x'); }), util }) });
        assert.deepStrictEqual(await rpc.getopencrosschainorders({}), { error: 'failed to look up cross-chain orders' });
    });
});

describe('JSON-RPC betting family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getbetfeeds and getbets page by the last row only when the page filled', async function () {
        const rows = [{ action_index: 11 }, { action_index: 12 }];
        const view = recordingView({ getLatestBlockIndex: 30, getBetFeedRows: rows, getBetRows: rows });
        const rpc = buildBetsRpc({ indexer: fakeIndexer({ view }) });
        const feeds = await rpc.getbetfeeds({ status: 'open', source: 's', tick: 'T', limit: 2, after_action_index: 9 });
        assert.deepStrictEqual(feeds, { latest_block_index: 30, network: 'regtest', count: 2, next_cursor: 12, feeds: rows });
        assert.deepStrictEqual(view.calls[1], ['getBetFeedRows', { status: 'open', source: 's', tick: 'T', limit: 2, after_action_index: 9 }]);
        const bets = await rpc.getbets({ feed: 4, limit: 9999 });
        assert.strictEqual(bets.next_cursor, null, 'a page under the cap has no next cursor');
        assert.deepStrictEqual(view.calls[3], ['getBetRows', { feed: 4, source: undefined, status: undefined, limit: 500, after_action_index: undefined }]);
    });

    it('getbetfeed answers the feed with its pools, or unknown feed', async function () {
        const view = recordingView({ getBetFeedInfo: (i) => (i === 3 ? { id: 3 } : null), getBetFeedPools: [{ outcome: 'A' }] });
        const rpc = buildBetsRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getbetfeed({ action_index: '3' }), { network: 'regtest', feed: { id: 3 }, pools: [{ outcome: 'A' }] });
        assert.deepStrictEqual(await rpc.getbetfeed({ action_index: 4 }), { error: 'unknown feed' });
        assert.deepStrictEqual(await rpc.getbetfeed({ action_index: 'x' }), { error: 'action_index must be numeric' });
    });

    it('every betting read refuses without a database and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const notReady = buildBetsRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        const throwing = buildBetsRpc({ indexer: fakeIndexer({ view: recordingView({
            getLatestBlockIndex: () => { throw new Error('x'); }, getBetFeedInfo: () => { throw new Error('x'); } }) }) });
        for (const [name, body, message] of [
            ['getbetfeeds', {}, 'failed to look up bet feeds'],
            ['getbetfeed', { action_index: 1 }, 'failed to look up bet feed'],
            ['getbets', {}, 'failed to look up bets']
        ]) {
            assert.deepStrictEqual(await notReady[name](body), NOT_READY, name);
            assert.deepStrictEqual(await throwing[name](body), { error: message }, name);
        }
    });
});

describe('JSON-RPC bridge family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getpendingbridgetransfers derives the kind from the version, retains a rooted v4 tick and stamps the generation read first', async function () {
        const rows = [
            { action_index: 1, version: 0, block_index: 90, amount: '1.5', decimals: 8, min_depth: null, dest_chain: 'DOGE', tick: 'XCHAIN', dest_address: 'D', src_address: 'B', tx_hash: 'a'.repeat(64) },
            { action_index: 2, version: 4, block_index: 95, amount: '7', decimals: null, min_depth: 3, dest_chain: 'DOGE', tick: 'BTC.FUFU', dest_address: 'D', src_address: 'B', tx_hash: 'b'.repeat(64) }
        ];
        const view = recordingView({ getLatestBlockIndex: 100, getPushGeneration: 9, getPendingBridgeTransfers: rows });
        const util = { parseBridgedTick: (t) => ({ origin: t.split('.')[0], name: t.split('.')[1] }) };
        const rpc = buildBridgeRpc({ indexer: fakeIndexer({ view, util }) });
        const res = await rpc.getpendingbridgetransfers({ limit: 0 });
        assert.ok(callOrder(view, 'getPushGeneration', 'getPendingBridgeTransfers').ordered, 'HUB-RETRACT-1: generation before rows');
        assert.deepStrictEqual(view.calls[2], ['getPendingBridgeTransfers', 100]);
        assert.strictEqual(res.count, 2);
        assert.deepStrictEqual(res.transfers[0], { transfer_kind: 'lock', src_chain: 'BTC', src_action_index: 1, src_address: 'B', dest_chain: 'DOGE',
            dest_address: 'D', tick: 'XCHAIN', decimals: 8, amount: '1.5', min_depth: 0, block_index: 90, confirmations: 11, tx_hash: 'a'.repeat(64), push_generation: 9 });
        assert.strictEqual(res.transfers[1].transfer_kind, 'burn');
        assert.strictEqual(res.transfers[1].tick, 'BTC.FUFU');
        assert.strictEqual(res.transfers[1].decimals, 0);
        assert.strictEqual(res.transfers[1].min_depth, 3);
    });

    it('getbridgetransfer, getbridgebalances and getbridgeescrowproof answer their rows or their misses', async function () {
        const view = recordingView({
            getLatestBlockIndex: 100,
            getBridgeTransferById: (id) => (id === ID ? { transfer_id: ID, status: 'pending' } : null),
            getBridgeBalances: { supply: '10', escrow: { BTC: '10' } },
            getBridgeEscrowProof: (addr) => (addr === 'esc' ? { proof: true } : null)
        });
        const rpc = buildBridgeRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getbridgetransfer({ transfer_id: ID.toUpperCase() }), { exists: true, latest_block_index: 100, transfer_id: ID, status: 'pending' });
        assert.deepStrictEqual(await rpc.getbridgetransfer({ transfer_id: 'd'.repeat(64) }), { exists: false, network: 'regtest', latest_block_index: 100 });
        assert.deepStrictEqual(await rpc.getbridgetransfer({ transfer_id: 'zz' }), { error: 'transfer_id must be a 64-hex id' });
        assert.deepStrictEqual(await rpc.getbridgebalances({ tick: 'T' }), { supply: '10', escrow: { BTC: '10' } });
        assert.deepStrictEqual(await rpc.getbridgebalances({}), { error: 'tick required' });
        assert.deepStrictEqual(await rpc.getbridgeescrowproof({ address: 'esc', tick: 'T', block_index: 5 }), { proof: true });
        assert.deepStrictEqual(view.calls.find(c => c[0] === 'getBridgeEscrowProof'), ['getBridgeEscrowProof', 'esc', 'T', 5]);
        assert.deepStrictEqual(await rpc.getbridgeescrowproof({ address: 'other', tick: 'T', block_index: 5 }), { error: 'no provable escrow state at that block_index' });
        assert.deepStrictEqual(await rpc.getbridgeescrowproof({ address: 'esc', tick: 'T', block_index: -1 }), { error: 'block_index must be a non-negative integer' });
        assert.deepStrictEqual(await rpc.getbridgeescrowproof({ tick: 'T' }), { error: 'address and tick required' });
    });

    it('every bridge read refuses without a database and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const notReady = buildBridgeRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        const boom = () => { throw new Error('x'); };
        const throwing = buildBridgeRpc({ indexer: fakeIndexer({ view: recordingView({ getLatestBlockIndex: boom, getBridgeBalances: boom, getBridgeEscrowProof: boom }) }) });
        for (const [name, body, message] of [
            ['getpendingbridgetransfers', {}, 'failed to look up pending bridge transfers'],
            ['getbridgetransfer', { transfer_id: ID }, 'failed to look up bridge transfer'],
            ['getbridgebalances', { tick: 'T' }, 'failed to look up bridge balances'],
            ['getbridgeescrowproof', { address: 'a', tick: 'T', block_index: 1 }, 'failed to build escrow proof']
        ]) {
            assert.deepStrictEqual(await notReady[name](body), NOT_READY, name);
            assert.deepStrictEqual(await throwing[name](body), { error: message }, name);
        }
    });
});

describe('JSON-RPC token policy family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('gettokenpolicy resolves both lists at the origin block and hashes them', async function () {
        const view = recordingView({
            getTokenInfo: (t, b) => (t === 'FUFU' ? { ALLOW_LIST: 7, BLOCK_LIST: null, BRIDGED: 1 } : null),
            getListAtBlock: ['addrA', 'addrB'], isTickSleepingAtBlock: 0
        });
        const rpc = buildTokenPolicyRpc({ indexer: fakeIndexer({ view }) });
        const res = await rpc.gettokenpolicy({ tick: 'FUFU', origin_block: 40 });
        assert.deepStrictEqual(res, { allow_list: ['addrA', 'addrB'], block_list: null, sleeping: false,
            policy_hash: crypto.createHash('sha256').update('ALLOW|2|addrA|addrB|BLOCK|-|SLEEP|0').digest('hex'), bridged: true, origin_block: 40 });
        assert.deepStrictEqual(view.calls[1], ['getListAtBlock', 7, 40]);
        assert.deepStrictEqual(await rpc.gettokenpolicy({ tick: 'NOPE', origin_block: 40 }), { error: 'tick has no native row on this chain' });
        assert.deepStrictEqual(await rpc.gettokenpolicy({ tick: 'FUFU', origin_block: 'x' }), { error: 'origin_block must be a non-negative integer' });
        assert.deepStrictEqual(await rpc.gettokenpolicy({}), { error: 'tick required' });
    });

    it('getappliedpolicy reports the local row with the applied snapshot identity when one landed', async function () {
        const view = recordingView({
            getTokenInfo: (t) => (t === 'DOGE.FUFU' ? { ALLOW_LIST: '7', BLOCK_LIST: null, BRIDGED: 1 } : null),
            getLatestBlockIndex: 66, isTickSleeping: 1,
            getAppliedPolicySnapshot: (origin, name) => {
                assert.deepStrictEqual([origin, name], ['DOGE', 'FUFU']);
                return { policy_seq: '2', origin_block: '40', policy_hash: 'h' };
            }
        });
        const util = { parseBridgedTick: (tick) => tick === 'DOGE.FUFU' ? { origin: 'DOGE', name: 'FUFU' } : null };
        const rpc = buildTokenPolicyRpc({ indexer: fakeIndexer({ view, util }) });
        assert.deepStrictEqual(await rpc.getappliedpolicy({ tick: 'DOGE.FUFU' }),
            { tick: 'DOGE.FUFU', bridged: true, allow_list: 7, block_list: null, sleeping: true, policy_seq: 2, origin_block: 40, policy_hash: 'h' });
        assert.deepStrictEqual(view.calls[2], ['isTickSleeping', 'DOGE.FUFU', 66]);
        assert.deepStrictEqual(view.calls[3], ['getAppliedPolicySnapshot', 'DOGE', 'FUFU']);
        view.getAppliedPolicySnapshot = async () => null;
        assert.strictEqual((await rpc.getappliedpolicy({ tick: 'DOGE.FUFU' })).policy_seq, null);
        assert.deepStrictEqual(await rpc.getappliedpolicy({ tick: 'NOPE' }), { error: 'tick has no local row on this chain' });
        assert.deepStrictEqual(await rpc.getappliedpolicy({}), { error: 'tick required' });
    });

    it('bridgePolicyHash tells an absent list from an empty one and never re-sorts', function () {
        const absent = bridgePolicyHash(null, null, false);
        assert.strictEqual(absent, crypto.createHash('sha256').update('ALLOW|-|BLOCK|-|SLEEP|0').digest('hex'));
        assert.notStrictEqual(bridgePolicyHash([], null, false), absent);
        assert.notStrictEqual(bridgePolicyHash(null, ['a', 'b'], true), bridgePolicyHash(null, ['b', 'a'], true));
    });

    it('both policy reads refuse without a database and report a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const notReady = buildTokenPolicyRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        const throwing = buildTokenPolicyRpc({ indexer: fakeIndexer({ view: recordingView({ getTokenInfo: () => { throw new Error('x'); } }) }) });
        assert.deepStrictEqual(await notReady.gettokenpolicy({ tick: 'T', origin_block: 1 }), NOT_READY);
        assert.deepStrictEqual(await notReady.getappliedpolicy({ tick: 'T' }), NOT_READY);
        assert.deepStrictEqual(await throwing.gettokenpolicy({ tick: 'T', origin_block: 1 }), { error: 'failed to look up token policy' });
        assert.deepStrictEqual(await throwing.getappliedpolicy({ tick: 'T' }), { error: 'failed to look up applied policy' });
    });
});

describe('JSON-RPC cross-chain call family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getpendingcrosschaincalls stamps every call with the generation read BEFORE the rows', async function () {
        const rows = [{ call_id: ID }];
        const view = recordingView({ getLatestBlockIndex: 100, getPushGeneration: 4, getPendingCrossChainCallRequests: rows });
        const rpc = buildCrossChainCallsRpc({ indexer: fakeIndexer({ view }) });
        const res = await rpc.getpendingcrosschaincalls({ limit: 7 });
        assert.ok(callOrder(view, 'getPushGeneration', 'getPendingCrossChainCallRequests').ordered, 'HUB-RETRACT-1: generation before rows');
        assert.deepStrictEqual(view.calls[2], ['getPendingCrossChainCallRequests', 7]);
        assert.deepStrictEqual(res, { latest_block_index: 100, network: 'regtest', count: 1, calls: [{ call_id: ID, push_generation: 4 }] });
    });

    it('getcrosschaincallresult answers the execution row, or the refusal diagnostics when there is none', async function () {
        const view = recordingView({
            getLatestBlockIndex: 100,
            getCrossChainCallExecutionById: (id) => (id === ID ? { block_index: '90', result_status: 'ok', return_payload_b64: null, gas_used: '12' } : null),
            getCrossChainCallRejectionById: (id) => (id === 'd'.repeat(64) ? { reason: 'quorum', detail: null, attempts: '2', first_block: '80', last_block: '99' } : null)
        });
        const rpc = buildCrossChainCallsRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getcrosschaincallresult({ call_id: ID }),
            { exists: true, network: 'regtest', latest_block_index: 100, executed_block_index: 90, status: 'ok', return_payload_b64: '', gas_used: 12 });
        assert.deepStrictEqual(await rpc.getcrosschaincallresult({ call_id: 'd'.repeat(64) }),
            { exists: false, network: 'regtest', latest_block_index: 100, rejection: { reason: 'quorum', detail: '', attempts: 2, first_block: 80, last_block: 99 } });
        assert.deepStrictEqual(await rpc.getcrosschaincallresult({ call_id: 'e'.repeat(64) }), { exists: false, network: 'regtest', latest_block_index: 100 });
        assert.deepStrictEqual(await rpc.getcrosschaincallresult({ call_id: 'nope' }), { error: 'call_id must be a 64-hex id' });
    });

    it('both reads refuse without a database and report a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const notReady = buildCrossChainCallsRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        const throwing = buildCrossChainCallsRpc({ indexer: fakeIndexer({ view: recordingView({ getLatestBlockIndex: () => { throw new Error('x'); } }) }) });
        assert.deepStrictEqual(await notReady.getpendingcrosschaincalls({}), NOT_READY);
        assert.deepStrictEqual(await notReady.getcrosschaincallresult({ call_id: ID }), NOT_READY);
        assert.deepStrictEqual(await throwing.getpendingcrosschaincalls({}), { error: 'failed to look up pending cross-chain calls' });
        assert.deepStrictEqual(await throwing.getcrosschaincallresult({ call_id: ID }), { error: 'failed to look up cross-chain call result' });
    });
});
