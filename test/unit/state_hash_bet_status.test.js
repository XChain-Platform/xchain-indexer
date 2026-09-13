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
// BET status-flip state_hash class (P4). The latch, the feed terminal
// flip and the per-bet settlement flip are in-place mutations on SURVIVING
// rows - the exact class invisible to action-scoped hashing. Asserts: (a) the
// per-chain gate; (b) the inert default leaves the preimage byte-identical to
// the pre-feature shape (no new keys, blind to the flips); (c) when armed,
// the flips fold in and a divergent flip (a follower that dropped a latch)
// yields a DIFFERENT state_hash - i.e. the follower HALTS instead of serving
// a permanently-open feed. No DB needed: call-order mock like the sibling
// suites.

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility');
const {
    buildStateHashData, isBetStatusStateHashActive, BET_STATUS_STATE_HASH_ACTIVATION,
    POLL_FINALIZE_STATE_HASH_ACTIVATION, TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
    INDEX_MAP_STATE_HASH_ACTIVATION,
} = require('../../src/stateHash');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];

// db whose doQuery returns canned result-sets in CALL ORDER, getStatusId fixed null.
function dbFor(results){
    let i = 0;
    return { doQuery: async () => results[i++], getStatusId: async () => null };
}

// With activationDelay=null (skips the deactivation queries) and no completed
// status id (skips the credits query), the base call order is: slashes x4,
// request_status x2, cooldown x2, anchor_invalid x1 = 9 slots; the 2 BET
// slots are appended when armed.
function baseResults(){ return [[], [], [], [], [], [], [], [], []]; }

async function build(opts, results){
    const data = await buildStateHashData(dbFor(results || baseResults()), 7, opts);
    return { data, hash: util.getDataHash(data) };
}

async function withArmed(height, fn){
    const prev = BET_STATUS_STATE_HASH_ACTIVATION.regtest;
    BET_STATUS_STATE_HASH_ACTIVATION.regtest = height;
    try { return await fn(); } finally { BET_STATUS_STATE_HASH_ACTIVATION.regtest = prev; }
}

describe('state_hash BET status-flip class (P4) @regression', function(){

    // Isolate from the sibling armed-on-regtest classes (their query slots
    // would shift the canned call order; their keys would break the shape
    // assertions). The BET class itself is disarmed suite-locally too, so the
    // inert tests exercise the below-threshold shape; withArmed re-arms.
    let pollPrev, tokenPrev, indexPrev, betPrev;
    before(function(){
        pollPrev  = POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest;
        tokenPrev = TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest;
        indexPrev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;
        betPrev   = BET_STATUS_STATE_HASH_ACTIVATION.regtest;
        POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = 999999999;
        TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest  = 999999999;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest     = 999999999;
        BET_STATUS_STATE_HASH_ACTIVATION.regtest    = 999999999;
    });
    after(function(){
        POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = pollPrev;
        TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest  = tokenPrev;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest     = indexPrev;
        BET_STATUS_STATE_HASH_ACTIVATION.regtest    = betPrev;
    });

    it('gate: below/at/above threshold, coin-keyed first, unknown network inert', function(){
        assert.strictEqual(isBetStatusStateHashActive(999999998, 'regtest', 'BTC'), false);
        assert.strictEqual(isBetStatusStateHashActive(999999999, 'regtest', 'BTC'), true);
        assert.strictEqual(isBetStatusStateHashActive(1, 'nonet', 'BTC'), false);
        // Per-chain mainnet keys resolve via '<COIN>:<network>'
        assert.strictEqual(isBetStatusStateHashActive(BET_STATUS_STATE_HASH_ACTIVATION['BTC:mainnet'], 'mainnet', 'BTC'), true);
        assert.strictEqual(isBetStatusStateHashActive(BET_STATUS_STATE_HASH_ACTIVATION['BTC:mainnet'] - 1, 'mainnet', 'BTC'), false);
        // A coin-less mainnet lookup finds no key and stays inert
        assert.strictEqual(isBetStatusStateHashActive(999999999, 'mainnet', null), false);
    });

    it('inert default: preimage keeps the pre-feature shape and is blind to bet flips', async function(){
        const opts = { activationDelay: null, network: 'regtest', coin: 'BTC' };
        const a = await build(opts);
        assert.deepStrictEqual(Object.keys(a.data), PREFEATURE_KEYS);
        // Same 9 base slots; a latch the class would have seen changes nothing
        const b = await build(opts, baseResults()); // mock rows never reached: queries not issued
        assert.strictEqual(a.hash, b.hash);
    });

    it('armed: the flips fold in and a dropped latch yields a DIFFERENT hash (follower halts)', async function(){
        const opts = { activationDelay: null, network: 'regtest', coin: 'BTC' };
        await withArmed(0, async () => {
            const latched = baseResults().concat([
                [{ action_index: 5, feed_status: 'closed', closed_block: 7, terminal_block: null }],
                [],
            ]);
            const dropped = baseResults().concat([[], []]);
            const a = await build(opts, latched);
            const b = await build(opts, dropped);
            assert.ok(Object.keys(a.data).includes('bet_feed_status'));
            assert.ok(Object.keys(a.data).includes('bet_status'));
            assert.notStrictEqual(a.hash, b.hash, 'a follower that dropped the latch must diverge and halt');
        });
    });

    it('armed: a settlement flip folds into bet_status and changes the hash', async function(){
        const opts = { activationDelay: null, network: 'regtest', coin: 'BTC' };
        await withArmed(0, async () => {
            const settled = baseResults().concat([
                [],
                [{ action_index: 12, bet_status: 'won', settled_block: 7 }],
            ]);
            const empty = baseResults().concat([[], []]);
            const a = await build(opts, settled);
            const b = await build(opts, empty);
            assert.notStrictEqual(a.hash, b.hash);
        });
    });
});
