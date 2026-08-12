/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/price-barrier-btc-time-coverage.test.js
 *
 * On BTC the height-keyed price_snapshots barrier does NOT imply the
 * time coverage that FIAT dispenser settlement needs, so BTC must run the
 * time-keyed barrier as well. gave that barrier to LTC/DOGE; BTC kept
 * taking the height branch as its ALTERNATIVE and was left uncovered.
 *
 * The two quantities are independent. A round's `reference_block` is the BTC
 * height it anchors to; its `block_timestamp` is the wall-clock instant the
 * validators stamped it. Both arrive together in the hub round push
 * (xchain-hub PriceAggregator) and neither is derived from the other.
 *
 * The failure this closes, concretely:
 *
 *   Bitcoin lets a miner timestamp a block up to 2 hours ahead of
 *   network-adjusted time. Block H is mined forward-dated, so the indexer
 *   processes it with a `blockTime` real wall-clock has not reached. ONE local
 *   round anchored at >= H satisfies `priceSyncHeight >= H` immediately, and
 *   the barrier opens. For the next two hours the hub keeps finalizing rounds
 *   whose `block_timestamp` is still <= blockTime, so each is still inside the
 *   `[blockTime - FIAT_DISPENSER_PRICE_WINDOW, blockTime]` range
 *   getPricesInTimeRange scans, and each is NEWER than the last under its
 *   `block_timestamp DESC, round_number DESC` ordering. Two operators whose
 *   mirrors stopped at different rounds in that window read a different newest
 *   price; reversePriceMatch floors a different unit count; the dispense
 *   credits a different amount. That is a fork, and a fresh resync is the worst
 *   case because its mirror holds every one of those rounds while the live node
 *   that first processed H held none.
 *
 * The height barrier is retained, not replaced: below NATIVE_FEE_PRICE_TIME_GATE
 * native-fee validation still selects the latest round by HEIGHT, so removing it
 * would un-barrier the fee path and diverge a from-genesis replay. The two gate
 * different readers of the same table.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const HubDbSync = require('../../src/hub_db_sync.js');

const INDEXER_SRC = fs.readFileSync(
    path.resolve(__dirname, '../../src/XChainIndexer.js'), 'utf8');

// The price-barrier block only: from the BTC height call to the oracle barrier
// that follows it. Narrow enough that an edit elsewhere in the block loop
// cannot satisfy these assertions by accident.
function priceBarrierBlock() {
    // Anchored on the BTC guard rather than on the call inside it, so the
    // chain condition itself is inside the slice. added the mayReadPrice
    // conjunct (skip the wait on a block that provably reads no price); the
    // chain guard it sits next to is still asserted below.
    const start = INDEXER_SRC.search(
        /if\(this\.hubDbSync && mayReadPrice && this\.config\['COIN'\] === 'BTC'\)\{/);
    const end   = INDEXER_SRC.indexOf('waitForOracleSyncTimestamp(');
    assert.ok(start > 0, 'the BTC-guarded height barrier must still exist');
    assert.ok(end > start, 'the oracle barrier must still follow the price barriers');
    return INDEXER_SRC.slice(start, end);
}

describe('BTC price barrier covers time as well as height @regression @tier1', function () {

    it('the time barrier is reachable on BTC, not an else-branch of the height barrier', function () {
        const block = priceBarrierBlock();
        assert.ok(!/else if\(this\.hubDbSync\)\{/.test(block),
            'an else-branch leaves BTC with height coverage only, which does not bound ' +
            'the time-keyed read FIAT settlement performs');
        assert.ok(/waitForPriceSyncTime\(blockTime/.test(block),
            'the time barrier must be called on the BTC path too');
    });

    it('the height barrier is retained for the fee path', function () {
        const block = priceBarrierBlock();
        assert.ok(/waitForPriceSyncHeight\(blockToParse/.test(block),
            'below NATIVE_FEE_PRICE_TIME_GATE the fee query selects by height, so ' +
            'deleting the height barrier would un-barrier that reader');
        assert.ok(/this\.config\['COIN'\] === 'BTC'/.test(block),
            'the height barrier stays BTC-only: other chains\' heights are not ' +
            'comparable to a round\'s BTC reference_block anchor');
    });

    // narrowed WHEN the barriers run. That is only safe while the skip
    // condition is the price-read predicate and nothing else: a chain term or a
    // flag-day term here would silently un-barrier a real reader.
    it('the only thing that may skip a barrier is the price-read predicate', function () {
        const block = priceBarrierBlock();
        // Height, time, and the oracle barrier that closes the slice.
        const guards = block.match(/if\(this\.hubDbSync[^)]*\)\{/g) || [];
        assert.strictEqual(guards.length, 3,
            'all three mirror barriers in this slice must still be guarded on hub-db sync');
        for (const guard of guards)
            assert.ok(/mayReadPrice/.test(guard),
                'a barrier that skips on anything other than mayReadPrice would drop the ' +
                'wait for a block that does read the mirror: ' + guard);
        assert.ok(!/isNativeFeePriceTimeGateActive|isEnabled\(/.test(block),
            'the skip decision must never be flag-day gated: it is a node-local wait, ' +
            'so it needs no activation height, and gating it would make coverage differ ' +
            'across the fleet at exactly the heights that matter');
    });

    it('both barriers defer the block rather than processing it', function () {
        const block = priceBarrierBlock();
        const stalls = block.match(/this\.stallReason = 'price_sync_barrier'/g) || [];
        assert.strictEqual(stalls.length, 2,
            'each barrier must break out of the loop without advancing lastIndexerBlock, ' +
            'so the block is retried rather than settled against a stale mirror');
    });

    // The behavioural core: a mirror that satisfies the height barrier can still
    // be missing rounds inside the settlement window.
    it('height satisfaction does not imply time satisfaction', function () {
        const sync = new HubDbSync({ doQuery: async () => [] }, { hubUrl: 'http://hub.invalid' });
        sync.priceBootstrapped = true;

        // Block H forward-dated 2h ahead of the instant the newest local round
        // was stamped: the legal maximum a miner may claim.
        const roundStampedAt = 1700000000;
        const blockHeight    = 900000;
        const blockTime      = roundStampedAt + 2 * 3600;

        // One local round anchored at this height, stamped 2h before the block
        // claims to exist.
        sync.priceSyncHeight       = blockHeight;
        sync.priceSyncMaxTimestamp = roundStampedAt;
        sync.streamWatermark       = 0;

        assert.strictEqual(sync._priceSyncSatisfied(blockHeight, blockTime), true,
            'the height barrier opens on a single round anchored at this height');
        assert.strictEqual(sync._priceTimeSyncSatisfied(blockTime), false,
            'yet the mirror does NOT hold every round with block_timestamp <= blockTime: ' +
            'this gap is the fork window, and it is why BTC needs both barriers');
    });

    it('the time barrier closes once the mirror covers the block time', function () {
        const sync = new HubDbSync({ doQuery: async () => [] }, { hubUrl: 'http://hub.invalid' });
        sync.priceBootstrapped = true;
        const blockTime = 1700007200;

        sync.priceSyncMaxTimestamp = blockTime - 1;
        assert.strictEqual(sync._priceTimeSyncSatisfied(blockTime), false);

        sync.priceSyncMaxTimestamp = blockTime;
        assert.strictEqual(sync._priceTimeSyncSatisfied(blockTime), true);
    });

    // Widening must not wedge a BTC chain that has no rounds yet, which is the
    // case a fresh regtest or a pre-federation mainnet is in.
    it('the widened BTC barrier still opens on the watermark with no local rounds', function () {
        const sync = new HubDbSync({ doQuery: async () => [] }, { hubUrl: 'http://hub.invalid' });
        sync.priceBootstrapped     = true;
        sync.priceSyncMaxTimestamp = 0;
        const blockTime = 1700000000;

        assert.strictEqual(sync._priceTimeSyncSatisfied(blockTime), false);
        sync.streamWatermark = blockTime + sync.priceWatermarkGraceS;
        assert.strictEqual(sync._priceTimeSyncSatisfied(blockTime), true,
            'the watermark escape must open the barrier with zero local rounds, or a ' +
            'BTC chain with no price federation would never advance');
    });

    it('the widened BTC barrier is a no-op when sync is disabled', async function () {
        // Single-host stacks read the hub DB directly; nothing to wait for.
        const sync = new HubDbSync(null, {});
        assert.strictEqual(await sync.waitForPriceSyncTime(1700000000, 10), 0);
    });
});
