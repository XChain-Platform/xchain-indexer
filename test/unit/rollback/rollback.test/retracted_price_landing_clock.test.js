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
// The price retraction carries the clock each rolled-back PRICE batch push sent, so the
// hub clears only the stamps that landing wrote. The forward pass sent the decoder's
// protocol time for the landing block; by rollback time the decoder holds the replacement
// chain, so the clock is rebuilt from this indexer's own blocks rows, which still hold the
// rolled-back chain until the purge.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');
const Rollback = require('../../../../src/rollback/index.js');
const blockReadsMixin = require('../../../../src/db/database/block_reads.js');
const readPhase = require('../../../../src/rollback/read_phase.js');
const { retractedLandingClocks } = require('../../../../src/rollback/landing_clock.js');

// A testnet-style chain whose raw stamps run 1201 s ahead of the parent, so the raw stamp
// and the median-time protocol clock differ at every height.
function chain(base, from, to) {
    const t = new Map();
    for (let h = from; h <= to; h++) t.set(h, base + (h - from) * 1201);
    return t;
}

// The forward pass's resolver over a blocks table, as the decoder ran it while parsing.
function decoderOver(times, network) {
    return Object.assign(Object.create(blockReadsMixin), {
        config: { NETWORK: network },
        async getRawBlockTime(h) { return times.has(h) ? times.get(h) : false; },
        async getPreviousBlockTimes(h, span) {
            return [...times.keys()].filter(k => k < h).sort((a, b) => b - a).slice(0, span).map(k => times.get(k));
        }
    });
}

// The indexer view's bulk window read over its own blocks table, in the SQL's shape.
function indexerViewOver(times, network, calls = []) {
    return {
        config: { NETWORK: network },
        async getStoredBlockTimeWindows(keys, span) {
            calls.push([keys, span]);
            return keys.flatMap(key => [...times.keys()].filter(k => k <= key).sort((a, b) => b - a)
                .slice(0, span + 1).map(k => ({ requested_block_index: key, block_index: k, block_time: times.get(k) })));
        }
    };
}

async function rebuildsTheForwardClock() {
    const times = chain(1700000000, 100, 140);
    const sent = await decoderOver(times, 'testnet').protocolTimeForStoredBlock(130);
    assert.notStrictEqual(sent, times.get(130), 'fixture must separate raw and protocol time');
    const calls = [];
    const clocks = await retractedLandingClocks(indexerViewOver(times, 'testnet', calls), [130, 130, 125]);
    assert.strictEqual(clocks.get(130), sent);
    assert.strictEqual(clocks.get(125), await decoderOver(times, 'testnet').protocolTimeForStoredBlock(125));
    assert.deepStrictEqual(calls, [[[130, 125], 11]], 'one bulk read for every landing block');
}

// Through a whole rollback: the clock read off the landing block reaches the durable
// price_retraction row and the live pushpricereorg call.
async function stagesTheClockOnTheRetraction() {
    const times = chain(1700000000, 100, 140);
    const sent = await decoderOver(times, 'testnet').protocolTimeForStoredBlock(130);
    const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(),
        retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(),
        retractBridgeRange: sinon.stub().resolves() };
    const idx = createMockIndexer({ hubClient });
    idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
    Object.assign(idx.indexerDb, indexerViewOver(times, 'testnet'));
    const rb = new Rollback(idx);
    idx.util.resetLists();
    idx.indexerDb.doQuery.callsFake(async (sql) => {
        sql = String(sql);
        if (/last_action_index/.test(sql)) return [{ last_action_index: 75 }];
        if (/^SELECT\s+a\.action_index\s+FROM\s+actions a/.test(sql)) return [{ action_index: 50 }];
        if (/FROM prices p/.test(sql) && /batch_first_round/.test(sql))
            return [{ action_index: 52, batch_first_round: 200, batch_last_round: 201, block_index: 130 }];
        return [];
    });
    await rb.rollback(100);
    const want = [{ first_round: 200, last_round: 201, block_time: sent }];
    const staged = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'price_retraction').args[1];
    assert.deepStrictEqual(staged.batches, want);
    assert.deepStrictEqual(hubClient.retractPriceRange.firstCall.args[4], want);
}

describe('Rollback retracted PRICE batch landing clock @regression', function () {
    afterEach(function () { sinon.restore(); });
    it('rebuilds the exact clock the forward pass sent, which is not the raw stamp on a median-time network', rebuildsTheForwardClock);
    it('stages the rebuilt clock on the durable price retraction and the live delivery', stagesTheClockOnTheRetraction);

    it('does not read the decoder, whose rows at the rolled-back heights already belong to the replacement chain', async function () {
        const old = chain(1700000000, 100, 140);
        const sent = await decoderOver(old, 'testnet').protocolTimeForStoredBlock(130);
        const replaced = new Map(old);
        for (let h = 120; h <= 140; h++) replaced.set(h, old.get(h) - 900);
        assert.notStrictEqual(await decoderOver(replaced, 'testnet').protocolTimeForStoredBlock(130), sent,
            'the decoder answers with the replacement chain after the reorg');
        const self = { indexerView: indexerViewOver(old, 'testnet'),
            decoderDb: new Proxy({}, { get() { throw new Error('decoder read during rollback'); } }) };
        self.indexerView.doQueryStrict = async () => [
            { action_index: 52, batch_first_round: '200', batch_last_round: '201', block_index: 130 },
            { action_index: 60, batch_first_round: 202, batch_last_round: 205, block_index: null }
        ];
        const windows = await readPhase.collectRetractedPriceBatches.call(self, 50);
        assert.deepStrictEqual(windows, [
            { first_round: 200, last_round: 201, block_time: sent },
            { first_round: 202, last_round: 205 }
        ]);
    });

    it('sends the raw stamp on a raw-time network, reading only the landing rows', async function () {
        const times = chain(1700000000, 100, 140);
        const calls = [];
        const clocks = await retractedLandingClocks(indexerViewOver(times, 'regtest', calls), [130]);
        assert.strictEqual(clocks.get(130), times.get(130));
        assert.deepStrictEqual(calls, [[[130], 0]]);
    });

    it('omits the clock when any row of the median window is missing', async function () {
        const gap = chain(1700000000, 100, 140);
        gap.delete(125);
        const short = chain(1700000000, 125, 140);
        for (const times of [gap, short]) {
            const clocks = await retractedLandingClocks(indexerViewOver(times, 'testnet'), [130]);
            assert.strictEqual(clocks.has(130), false);
        }
        const noLanding = chain(1700000000, 100, 129);
        assert.strictEqual((await retractedLandingClocks(indexerViewOver(noLanding, 'regtest'), [130])).size, 0);
    });

    it('omits every clock when the read fails or nothing names a landing block', async function () {
        const failing = { config: { NETWORK: 'testnet' }, async getStoredBlockTimeWindows() { throw new Error('down'); } };
        assert.strictEqual((await retractedLandingClocks(failing, [130])).size, 0);
        const calls = [];
        assert.strictEqual((await retractedLandingClocks(indexerViewOver(new Map(), 'testnet', calls), [null, undefined, -1, 'x'])).size, 0);
        assert.deepStrictEqual(calls, []);
        assert.strictEqual((await retractedLandingClocks({}, [130])).size, 0);
    });
});
