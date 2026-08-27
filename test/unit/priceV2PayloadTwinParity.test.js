/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/priceV2PayloadTwinParity.test.js
 *
 * The PRICE v0 canonical exists in THREE hand-maintained copies: the producer
 * (xchain-hub OracleConsensus._buildPriceBatchPayload, which signs), the hub's ingest
 * verifier (PriceAggregator._buildPriceBatchPayload) and the on-chain verifier
 * (xchain-indexer ed25519.buildPriceBatchPayload). A one-byte divergence between any two
 * means the producer signs bytes a verifier never checks: every legitimate batch is
 * rejected, the price rail stalls, and the native-fee / XCHAIN-USD path stalls with it.
 * No other suite compares them, so this one asserts byte equality on a batch built to
 * exercise every normalization the builders own (round order, pair order, integer
 * spelling, the coinPair/pair spelling split).
 *
 * The hub twins are resolved by monorepo-relative path, so the three-way comparison runs
 * in the monorepo/aggregator checkout; a standalone single-repo checkout skips it (unless
 * XCHAIN_REQUIRE_SIBLINGS=1, where a missing sibling hard-fails) and still runs the local
 * shape assertions below.
 */

'use strict';

const assert  = require('assert');
const ed25519 = require('../../src/ed25519.js');
const eq      = require('../../src/equivocation_header.js');

const ANCHOR = 912345;   // equals the last round's own anchor, per the wire format
const FIRST  = 1039;
const LAST   = 1042;

// Deliberately hostile input: rounds out of order, pairs out of order, integer fields
// spelled as both strings and numbers, and pairs keyed both `coinPair` (the producer's
// in-memory spelling) and `pair` (the wire-parsed spelling).
function batch() {
    return [
        { round: 1041,   timestamp: 1756200600,   btcBlockHeight: '912344', pairs: [
            { coinPair: 'XCP/USD',  price: 0.4237 },
            { pair:     'BTC/USD',  price: '61234.5' } ] },
        { round: '1039', timestamp: '1756199400', btcBlockHeight: 912342,   pairs: [
            { pair:     'LTC/USD',  price: '71.02' },
            { coinPair: 'BTC/USD',  price: 61111 },
            { pair:     'DOGE/USD', price: '0.1234' } ] },
        { round: 1042,   timestamp: 1756201200,   btcBlockHeight: 912345,   pairs: [
            { coinPair: 'DOGE/USD', price: '0.1240' },
            { coinPair: 'BTC/USD',  price: '61300' } ] },
        { round: '1040', timestamp: 1756200000,   btcBlockHeight: '912343', pairs: [
            { pair:     'BTC/USD',  price: 61222 } ] },
    ];
}

// Same batch, every list handed over in the opposite order. A builder that trusted its
// caller's ordering instead of sorting would emit different bytes for this.
function shuffledBatch() {
    return batch().reverse().map(r => Object.assign({}, r, { pairs: [...r.pairs].reverse() }));
}

const PREFIX = 'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|' + ANCHOR + '|' + FIRST + '|' + LAST + '|0||';

// Real instances of the two hub classes, not prototype stand-ins: the constructors only
// need a hub with db/network/getPeerManager, so the methods under test are reached the
// same way production reaches them.
function hubTwins() {
    const OracleConsensus = require('../../../xchain-hub/src/OracleConsensus.js');
    const PriceAggregator = require('../../../xchain-hub/src/PriceAggregator.js');
    const stubHub = { db: null, network: 'regtest', getPeerManager: () => ({}) };
    return {
        producer: new OracleConsensus(stubHub, {}),
        ingest:   new PriceAggregator(stubHub)
    };
}

function loadHubTwins(ctx) {
    try { return hubTwins(); }
    catch (e) {
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
            throw new Error('PRICE v0 canonical parity cannot run: xchain-hub sibling missing (' + e.message + ')');
        ctx.skip();
        return null;
    }
}

describe('PRICE v0 canonical: three-way twin parity', function () {

    describe('the canonical itself (indexer verifier copy)', function () {

        it('emits the pinned key order, ascending rounds and sorted pairs', function () {
            let canonical = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
            assert.ok(canonical.startsWith(PREFIX), 'EQUIV prefix: ' + canonical.slice(0, 60));

            let body = JSON.parse(canonical.slice(PREFIX.length));
            assert.deepStrictEqual(Object.keys(body), ['first_round', 'last_round', 'btc_block_height', 'rounds']);
            assert.deepStrictEqual([body.first_round, body.last_round, body.btc_block_height], [FIRST, LAST, ANCHOR]);
            assert.deepStrictEqual(body.rounds.map(r => r.round), [1039, 1040, 1041, 1042], 'rounds ascending');

            for (const r of body.rounds) {
                assert.deepStrictEqual(Object.keys(r), ['round', 'timestamp', 'btc_block_height', 'pairs']);
                assert.deepStrictEqual(r.pairs.map(p => p.pair), [...r.pairs.map(p => p.pair)].sort(), 'pairs sorted in round ' + r.round);
                for (const p of r.pairs) {
                    assert.deepStrictEqual(Object.keys(p), ['pair', 'price']);
                    assert.strictEqual(typeof p.price, 'string', 'prices are stringified');
                }
            }
            // Integer fields are parseInt'd whichever way the caller spelled them.
            assert.deepStrictEqual(body.rounds[0], {
                round: 1039, timestamp: 1756199400, btc_block_height: 912342,
                pairs: [ { pair: 'BTC/USD', price: '61111' }, { pair: 'DOGE/USD', price: '0.1234' }, { pair: 'LTC/USD', price: '71.02' } ]
            });
        });

        it('is caller-order independent', function () {
            assert.strictEqual(
                ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch()),
                ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()));
        });

        it('spells coinPair and pair to the same bytes', function () {
            let rounds = [{ round: 7, timestamp: 100, btcBlockHeight: 5, pairs: [{ coinPair: 'BTC/USD', price: '1' }] }];
            let twin   = [{ round: 7, timestamp: 100, btcBlockHeight: 5, pairs: [{ pair:     'BTC/USD', price: 1   }] }];
            assert.strictEqual(
                ed25519.buildPriceBatchPayload(7, 7, 5, rounds),
                ed25519.buildPriceBatchPayload(7, 7, 5, twin));
        });

        // D36: v2 has no pre-flag-day history to stay bit-identical with, and the bare
        // JSON form is the shape that breaks SLASH's "an ORACLE-tagged canonical always
        // carries `round`" invariant. v0 at this height would be headerless.
        it('wraps in the EQUIV header unconditionally, with no activation gate', function () {
            let belowFlagDay = ed25519.buildPriceBatchPayload(1, 1, 1, [{ round: 1, timestamp: 1, btcBlockHeight: 1, pairs: [{ pair: 'BTC/USD', price: '1' }] }]);
            assert.ok(belowFlagDay.startsWith('EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|1|1|1|0||'), belowFlagDay.slice(0, 60));
            assert.strictEqual(eq.isEquivHeaderActive(1, 'mainnet'), false, 'the gate v0 would have failed here');
        });
    });

    describe('byte equality across the producer and both verifiers', function () {

        it('all three twins emit the identical canonical for one batch', function () {
            let hub = loadHubTwins(this);
            if (!hub) return;

            let fromIndexer  = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
            let fromProducer = hub.producer._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
            let fromIngest   = hub.ingest._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());

            assert.strictEqual(fromProducer, fromIndexer,
                'OracleConsensus (PRODUCER) diverged from the indexer verifier: the hub would sign bytes no indexer checks');
            assert.strictEqual(fromIngest, fromIndexer,
                'PriceAggregator (hub ingest verifier) diverged from the indexer verifier: hub ingest would reject every legitimate batch');
            assert.strictEqual(
                Buffer.byteLength(fromProducer, 'utf8'), Buffer.byteLength(fromIndexer, 'utf8'),
                'byte length parity');
        });

        it('all three normalize caller ordering identically', function () {
            let hub = loadHubTwins(this);
            if (!hub) return;

            let expected = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
            for (const [name, canonical] of [
                ['indexer verifier',  ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch())],
                ['hub producer',      hub.producer._buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch())],
                ['hub ingest',        hub.ingest._buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch())],
            ]) {
                assert.strictEqual(canonical, expected, name + ' is sensitive to caller ordering');
            }
        });

        it('all three wrap in the EQUIV header unconditionally', function () {
            let hub = loadHubTwins(this);
            if (!hub) return;

            let rounds = [{ round: 1, timestamp: 1, btcBlockHeight: 1, pairs: [{ pair: 'BTC/USD', price: '1' }] }];
            let want   = 'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|1|1|1|0||';
            for (const [name, canonical] of [
                ['indexer verifier',  ed25519.buildPriceBatchPayload(1, 1, 1, rounds)],
                ['hub producer',      hub.producer._buildPriceBatchPayload(1, 1, 1, rounds)],
                ['hub ingest',        hub.ingest._buildPriceBatchPayload(1, 1, 1, rounds)],
            ]) {
                assert.ok(canonical.startsWith(want), name + ' did not wrap below the v0 flag-day: ' + canonical.slice(0, 60));
            }
        });
    });
});
