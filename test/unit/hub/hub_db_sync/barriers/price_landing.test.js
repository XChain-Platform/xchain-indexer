// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/*
 * The price landing barrier: a price-reading block waits for every other landing chain to
 * publish a landed time past its own, and a live read then equals the replay read.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync        = require('../../../../../src/hub/hub_db_sync.js');
const priceBarriers    = require('../../../../../src/XChainIndexer/price_barriers.js');
const Database         = require('../../../../../src/db');
const Utility          = require('../../../../../src/utility');
const { getTestConfig } = require('../../../../fixtures/config');
const { stubActiveAt } = require('../../../../helpers/gate_modules.js');

const LANDED_ROW = 'price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION';
const BLOCK_HEIGHT = 4906100;
const T = 1791144199;

function makeSync(coin) {
    const sync = new HubDbSync({ doQuery: async () => [] }, { enabled: true, network: 'testnet', coin: coin });
    sync.enabled = true;
    return sync;
}

function frame(dogeTime) {
    return { heights: {}, ts: 0, landed: { DOGE: { block: 67970000, protocol_time: dogeTime } } };
}

function indexerFor(sync) {
    const ix = Object.assign({ hubDbSync: sync, priceSyncTimeoutMs: 50, config: { COIN: 'LTC' } }, priceBarriers);
    return ix;
}

// Rounds 5442 to 5447, finalized 600 s apart ending just under T. Unstamped on the live
// node until the batch ingest stamps them.
function rounds(stamp) {
    const out = [];
    for (let n = 5442; n <= 5447; n++) {
        out.push({ coin_pair: 'LTC/USD', price: String(100 + n - 5442), round_number: n,
                   block_timestamp: T - 3000 + (n - 5442) * 600 - 1, reference_block: 4906000 + n,
                   batch_block_time: stamp ? T - 100 : 0, status: 'finalized' });
    }
    return out;
}

function makeDb(rows) {
    const config = getTestConfig();
    config['NETWORK'] = 'testnet';
    config['COIN'] = 'LTC';
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_ltc_testnet', 'u', 'p', { config, util });
    sinon.stub(db, 'doQueryStrict').callsFake(async (query, args) => {
        const bound = /batch_block_time > 0 AND batch_block_time <= \?/.test(query);
        const bt = bound ? Number(args[args.length - 1]) : null;
        return rows.filter(r => r.status === 'finalized' &&
                                (!bound || (r.batch_block_time > 0 && r.batch_block_time <= bt)))
                   .sort((a, b) => b.round_number - a.round_number).slice(0, 1);
    });
    return db;
}

describe('price landing barrier @regression @tier1', function () {

    beforeEach(function () {
        stubActiveAt(sinon, LANDED_ROW, true);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('defers while landed.DOGE is behind T(B), and names the chain and shortfall', async function () {
        const sync = makeSync('LTC');
        sync.noteLanded(frame(1791143700).landed);
        await assert.rejects(sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20),
            /landing chain DOGE landed time 1791143700, needs 1791144200 \(short by 500s\)/);
    });

    it('releases once landed.DOGE passes T(B), including a waiter already parked', async function () {
        const sync = makeSync('LTC');
        sync.noteLanded(frame(1791143700).landed);
        const parked = sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 2000);
        sync.noteLanded(frame(1791144200).landed);
        await parked;
        await sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20);
    });

    it('does not release through priceSyncHeight or the stream watermark', async function () {
        const sync = makeSync('LTC');
        sync.priceSyncHeight = BLOCK_HEIGHT + 10;
        sync.priceBootstrapped = true;
        sync.advanceWatermark(T + 100000);
        await assert.rejects(sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20), /landing chain DOGE landed time none/);
    });

    it('requires a strictly greater landed time', async function () {
        const sync = makeSync('LTC');
        sync.noteLanded(frame(T).landed);
        await assert.rejects(sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20), /short by 1s/);
    });

    it('is a no-op below the gate', async function () {
        stubActiveAt(sinon, LANDED_ROW, false);
        await makeSync('LTC').waitForPriceLandingSync(BLOCK_HEIGHT, T, 20);
    });

    it('is a no-op for a landing chain itself and when sync is disabled', async function () {
        await makeSync('DOGE').waitForPriceLandingSync(BLOCK_HEIGHT, T, 20);
        const off = makeSync('LTC');
        off.enabled = false;
        await off.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20);
    });

    it('a frame with no landed map clears it and never regresses an entry', function () {
        const sync = makeSync('LTC');
        sync.noteLanded(frame(1791144200).landed);
        assert.strictEqual(sync.noteLanded(frame(1791143700).landed), false);
        assert.strictEqual(sync.landedWatermarks.DOGE.protocol_time, 1791144200);
        sync.handleWatermarkFrame({ ts: 1 });
        sync._bootstrapDrained = true;
        sync.handleWatermarkFrame({ ts: 2 });
        assert.deepStrictEqual(sync.landedWatermarks, {});
    });

    it('the member defers a price-reading block, passes a non-reading one, and sets the stall reason', async function () {
        const sync = makeSync('LTC');
        const ix = indexerFor(sync);
        assert.strictEqual(await ix.deferOnPriceLandingSync(BLOCK_HEIGHT, T, true), true);
        assert.strictEqual(ix.stallReason, 'price_landing_barrier');
        assert.strictEqual(await ix.deferOnPriceLandingSync(BLOCK_HEIGHT, T, false), false);
        sync.noteLanded(frame(1791144200).landed);
        assert.strictEqual(await ix.deferOnPriceLandingSync(BLOCK_HEIGHT, T, true), false);
    });

    it('end to end: the live read equals the replay read (round 5447)', async function () {
        const opts = { blockTime: T, maxAgeSeconds: 3600, selectByTime: true };
        const sync = makeSync('LTC');
        sync.noteLanded(frame(1791143700).landed);

        // Live node, rounds unstamped: the barrier holds the block, so no read happens.
        await assert.rejects(sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20), /DOGE/);

        // The stamp lands and landed.DOGE passes T(B): the barrier opens and the read is taken.
        sync.noteLanded(frame(1791144200).landed);
        await sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20);
        const live = await makeDb(rounds(true)).getLatestPrice('LTC/USD', BLOCK_HEIGHT, opts);

        // Replay on a chain-only node: every stamp is already present.
        const replay = await makeDb(rounds(true)).getLatestPrice('LTC/USD', BLOCK_HEIGHT, opts);

        assert.strictEqual(live.roundNumber, 5447);
        assert.deepStrictEqual(live, replay);

        // Without the barrier the unstamped live read answers differently (no round), the split it closes.
        const early = await makeDb(rounds(false)).getLatestPrice('LTC/USD', BLOCK_HEIGHT, opts);
        assert.strictEqual(early, null);
    });
});
