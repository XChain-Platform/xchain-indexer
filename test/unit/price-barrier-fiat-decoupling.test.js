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
 * test/unit/price-barrier-fiat-decoupling.test.js
 *
 * . The time-keyed price_snapshots sync barrier must run on every
 * non-BTC chain whenever hub-db sync is enabled, NOT only at/after the
 * NATIVE_FEE_PRICE_TIME_GATE flag-day.
 *
 * The barrier arrived as the twin of that gate's fee-validation change (H-3),
 * so it was wired behind the same predicate. But native fees are not the only
 * time-keyed reader of price_snapshots: FIAT dispenser settlement bounds its
 * read on `block_timestamp <= this block's time` on every chain from day one,
 * in both pricing modes (reversePriceMatch directly, and
 * reverseOraclePriceMatch for the validator coin price behind a user oracle
 * quote). While the barrier was gated on the fee flag-day, LTC and DOGE
 * mainnet settled FIAT dispenses against an unbarriered mirror below
 * 1790812800: two operators with different mirror states credit different
 * token amounts for the same payment, which forks the chain.
 *
 * These pin the two halves that keep that closed:
 *   1. the wiring no longer consults the flag-day predicate (source shape,
 *      the same pin style as votes-append-only and the dispenser residuals);
 *   2. the barrier a non-BTC chain now always reaches still cannot freeze a
 *      quiet chain, because the watermark escape opens it with no local rounds.
 *
 * The fee-side predicate is deliberately NOT removed: getLatestPrice still
 * selects by time only at/after the flag-day, and priceTimeGate.test.js pins
 * that. Only the barrier is decoupled, which is the safe direction (an extra
 * wait can delay a block, never change its verdict).
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const changes   = require('../../src/protocol_changes.js');
const HubDbSync = require('../../src/hub_db_sync.js');

const INDEXER_SRC = fs.readFileSync(
    path.resolve(__dirname, '../../src/XChainIndexer.js'), 'utf8');

// The barrier block: from the BTC height-barrier branch through the non-BTC
// time-barrier call. Narrow enough that an unrelated edit elsewhere in the
// block loop cannot satisfy or break these assertions.
function barrierBlock() {
    const start = INDEXER_SRC.indexOf('waitForPriceSyncHeight(blockToParse');
    const end   = INDEXER_SRC.indexOf('waitForPriceSyncTime(blockTime');
    assert.ok(start > 0, 'the BTC height barrier call must still exist');
    assert.ok(end > start, 'the non-BTC time barrier call must still follow it');
    return INDEXER_SRC.slice(start, end);
}

describe(' price barrier decoupled from the fee flag-day @regression @tier1', function () {

    it('the non-BTC time barrier is not guarded by isNativeFeePriceTimeGateActive', function () {
        const block = barrierBlock();
        assert.ok(!/isNativeFeePriceTimeGateActive/.test(block),
            'the time-keyed barrier must run on every non-BTC chain regardless of the ' +
            'NATIVE_FEE_PRICE_TIME_GATE flag-day: FIAT dispenser settlement reads ' +
            'price_snapshots time-keyed on every chain from day one ');
    });

    it('the time barrier gates only on hub-db sync being enabled', function () {
        const block = barrierBlock();
        // Was pinned as `} else if(this.hubDbSync){` when the time barrier was the
        // non-BTC ALTERNATIVE to the height barrier.  made the two additive
        // (BTC needs both; see the barrier comment in XChainIndexer.js), so the
        // condition is now a bare `if`. The property this test exists for is
        // unchanged and strictly stronger: the barrier runs whenever a mirror is in
        // play, and is a no-op only on single-host stacks.
        //  added the mayReadPrice conjunct: a block that reads no price is
        // byte-identical against a current mirror and a stale one, so the wait is
        // pure cost. The property this test exists for is unchanged: the guard
        // still carries NO chain term and NO flag-day term, so the barrier runs on
        // every chain whenever a mirror is in play and the block can read it.
        assert.ok(/\}\s*\n\s*if\(this\.hubDbSync && mayReadPrice\)\{/.test(block),
            'the time-barrier condition must be exactly `this.hubDbSync && mayReadPrice`, ' +
            'unguarded by chain or flag-day, so it runs whenever a mirror is in play');
        assert.ok(!/if\(this\.hubDbSync[^)]*COIN[^)]*\)/.test(block),
            'the time barrier must never regain a chain term: FIAT settlement reads ' +
            'price_snapshots time-keyed on every chain ');
        assert.ok(!/else if\(this\.hubDbSync\)/.test(block),
            'the time barrier must NOT be an else-branch of the BTC height barrier: on ' +
            'BTC the height check does not imply time coverage ');
    });

    it('the flag-day predicate itself is retained for the fee-side query', function () {
        // Guards against "fixing"  by deleting the gate outright, which
        // would change getLatestPrice's historical round selection and fork a
        // from-genesis replay.
        assert.strictEqual(typeof changes.isNativeFeePriceTimeGateActive, 'function');
        assert.strictEqual(changes.NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME, 1790812800);
        assert.strictEqual(
            changes.isNativeFeePriceTimeGateActive('mainnet', 1790812800 - 1), false);
    });

    it('the widened barrier still opens on the watermark with no local rounds', async function () {
        // The reason widening is safe: a chain that has never seen a price round,
        // or is sitting in a round gap, must not freeze its tip. Case 2 of
        // _priceTimeSyncSatisfied opens once the hub confirms it has streamed
        // everything through blockTime + grace.
        const sync = new HubDbSync({ doQuery: async () => [{ h: 0, ts: 0 }] }, { hubUrl: 'http://hub.invalid' });
        sync.priceBootstrapped = true;
        sync.priceSyncMaxTimestamp = 0;

        const blockTime = 1700000000;
        assert.strictEqual(sync._priceTimeSyncSatisfied(blockTime), false,
            'a behind mirror with a frozen watermark must defer');

        sync.streamWatermark = blockTime + sync.priceWatermarkGraceS;
        assert.strictEqual(sync._priceTimeSyncSatisfied(blockTime), true,
            'the watermark escape must open the barrier with zero local rounds');
    });

    it('the widened barrier is still a no-op when sync is disabled', async function () {
        // Single-host stacks read the hub DB directly, so there is nothing to
        // wait for and the widened barrier must not stall them.
        const sync = new HubDbSync(null, {});
        const got = await sync.waitForPriceSyncTime(1700000000, 10);
        assert.strictEqual(got, 0);
    });
});
