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
 * test/unit/price/price_v2_payload_twin_parity.test.js
 *
 * The PRICE v0 canonical exists in THREE hand-maintained copies: the producer
 * (xchain-hub OracleConsensus.buildPriceBatchPayload, which signs), the hub's ingest
 * verifier (PriceAggregator.buildPriceBatchPayload) and the on-chain verifier
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
 *
 * TWO CANONICALS, TWO ERA RULES, mirrored here from the hub's copy of this suite so neither is
 * checked in one repo only. The BATCH canonical is the subject of the describes above; the
 * SINGLE-ROUND one (buildPriceV0Payload) is a separate write carrying the round's admission
 * map, so the describe at the bottom arms the activation itself and drives both eras. Its own
 * subject is the coinPair / pair SPELLING SPLIT, which nothing else in this repo drives:
 * priceV0CanonicalAdmission.test.js holds the indexer's era, refusal and encoder cases for that
 * builder but spells every fixture `pair`, so a fork of the coinPair branch alone left the
 * whole indexer suite green and went red only in the hub's tree.
 */

'use strict';

const assert  = require('assert');
const ed25519 = require('../../../src/consensus/ed25519.js');
const eq      = require('../../../src/consensus/equivocation_header.js');
const adm     = require('../../../src/consensus/gates/mirror_admission_gate.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const NETWORK = 'regtest';
const ANCHOR = 912345;   // equals the last round's own anchor, per the wire format
const FIRST  = 1039;
const LAST   = 1042;

// Deliberately hostile input: rounds out of order, pairs out of order, integer fields
// spelled as both strings and numbers, and pairs keyed both `coinPair` (the producer's
// in-memory spelling) and `pair` (the wire-parsed spelling).
//
// Each round carries an admission map exactly when ITS OWN anchor is in the admission
// era under whatever activation this process was launched with (inert in a default run,
// armed when XC_MIRROR_ADMISSION_ACTIVATION is set), so the same fixture drives both
// eras and never hands a legacy round a map, which every builder refuses.
function batch() {
    const maps = { 1039: { DOGE: 5000004, BTC: 912346 }, 1040: { BTC: 912347 },
                   1041: { LTC: 2400004, BTC: 912348 }, 1042: { BTC: 912349, DOGE: 5000010, LTC: 2400010 } };
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
    ].map(r => adm.isAdmissionEra(NETWORK, parseInt(r.btcBlockHeight))
                 ? Object.assign({ admitBlocks: maps[parseInt(r.round)] }, r) : r);
}
// A single small round given a map only when its anchor is in the era.
const eraAware = r => adm.isAdmissionEra(NETWORK, parseInt(r.btcBlockHeight)) ? Object.assign({ admitBlocks: { BTC: parseInt(r.btcBlockHeight) + 4 } }, r) : r;
const ROUND_KEYS = () => adm.isAdmissionEra(NETWORK, 912342)
    ? ['round', 'timestamp', 'btc_block_height', 'pairs', 'admit_blocks']
    : ['round', 'timestamp', 'btc_block_height', 'pairs'];

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
    const OracleConsensus = require('../../../../xchain-hub/src/oracle/consensus.js');
    const PriceAggregator = require('../../../../xchain-hub/src/oracle/price_aggregator.js');
    const stubHub = { db: null, network: 'regtest', getPeerManager: () => ({}) };
    return {
        producer: new OracleConsensus(stubHub, {}),
        ingest:   new PriceAggregator(stubHub)
    };
}

function loadHubTwins(ctx) {
    // Judge both hub twins before requiring them, so a lane symlink into a live main
    // checkout skips (or fails naming why) instead of comparing against unpinned bytes.
    for (const rel of ['../../../../xchain-hub/src/oracle/consensus.js', '../../../../xchain-hub/src/oracle/price_aggregator.js']) {
        const verdict = siblingCheckout(__dirname, rel);
        if (!verdict.usable) { skipOrFail(ctx, verdict, 'PRICE v0 canonical parity'); return null; }
    }
    try { return hubTwins(); }
    catch (e) {
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
            throw new Error('PRICE v0 canonical parity cannot run: xchain-hub sibling missing (' + e.message + ')');
        ctx.skip();
        return null;
    }
}
const MODS = ['../../../src/consensus/gates/mirror_admission_gate.js', '../../../src/consensus/ed25519.js',
              '../../../../xchain-hub/src/consensus/gates/mirror_admission_gate.js',
              '../../../../xchain-hub/src/lib/admission_height.js',
              '../../../../xchain-hub/src/oracle/consensus.js',
              '../../../../xchain-hub/src/oracle/price_aggregator.js'];
const MAPS = { 1039: { DOGE: 5000004, BTC: 912346 }, 1040: { BTC: 912347 },
               1041: { LTC: 2400004, BTC: 912348 }, 1042: { BTC: 912349, DOGE: 5000010, LTC: 2400010 } };
const withMaps = rounds => rounds.map(r => Object.assign({ admitBlocks: MAPS[parseInt(r.round)] }, r, { admitBlocks: MAPS[parseInt(r.round)] }));
let armed = null;
function admissionHooks() {
    before(function () {
        // Every module is judged before the purge, for the same reason as loadHubTwins.
        for (const m of MODS) {
            const verdict = siblingCheckout(__dirname, m);
            if (!verdict.usable) return skipOrFail(this, verdict, 'the PRICE v0 admission-era twin parity');
        }
        let paths;
        try { paths = MODS.map(m => require.resolve(m)); }
        catch (e) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw e;
            return this.skip();
        }
        const saved    = paths.map(p => [p, require.cache[p]]);
        const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        for (const p of paths) delete require.cache[p];
        process.env.XC_MIRROR_ADMISSION_ACTIVATION = '0';
        const act = require('../../../src/consensus/gates/mirror_admission_gate.js');
        const ed  = require('../../../src/consensus/ed25519.js');
        const OC  = require('../../../../xchain-hub/src/oracle/consensus.js');
        const PA  = require('../../../../xchain-hub/src/oracle/price_aggregator.js');
        const stubHub = { db: null, network: NETWORK, getPeerManager: () => ({}) };
        armed = { act, ed, producer: new OC(stubHub, {}), ingest: new PA(stubHub), restore() {
            for (const [p, mod] of saved) { if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod; }
            if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
        } };
    });
    after(function () { if (armed) armed.restore(); armed = null; });
}

describe('PRICE v0 canonical: three-way twin parity', function () {

    describe('the canonical itself (indexer verifier copy)', function () {

        it('emits the pinned key order, ascending rounds and sorted pairs', function () {
            let canonical = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch(), NETWORK);
            assert.ok(canonical.startsWith(PREFIX), 'EQUIV prefix: ' + canonical.slice(0, 60));

            let body = JSON.parse(canonical.slice(PREFIX.length));
            assert.deepStrictEqual(Object.keys(body), ['first_round', 'last_round', 'btc_block_height', 'rounds']);
            assert.deepStrictEqual([body.first_round, body.last_round, body.btc_block_height], [FIRST, LAST, ANCHOR]);
            assert.deepStrictEqual(body.rounds.map(r => r.round), [1039, 1040, 1041, 1042], 'rounds ascending');

            for (const r of body.rounds) {
                assert.deepStrictEqual(Object.keys(r), ROUND_KEYS());
                assert.deepStrictEqual(r.pairs.map(p => p.pair), [...r.pairs.map(p => p.pair)].sort(), 'pairs sorted in round ' + r.round);
                for (const p of r.pairs) {
                    assert.deepStrictEqual(Object.keys(p), ['pair', 'price']);
                    assert.strictEqual(typeof p.price, 'string', 'prices are stringified');
                }
            }
            // Integer fields are parseInt'd whichever way the caller spelled them.
            let want0 = {
                round: 1039, timestamp: 1756199400, btc_block_height: 912342,
                pairs: [ { pair: 'BTC/USD', price: '61111' }, { pair: 'DOGE/USD', price: '0.1234' }, { pair: 'LTC/USD', price: '71.02' } ]
            };
            if (adm.isAdmissionEra(NETWORK, 912342)) want0.admit_blocks = 'BTC:912346,DOGE:5000004';
            assert.deepStrictEqual(body.rounds[0], want0);
        });

        it('is caller-order independent', function () {
            assert.strictEqual(
                ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch(), NETWORK),
                ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch(), NETWORK));
        });

        it('spells coinPair and pair to the same bytes', function () {
            let rounds = [eraAware({ round: 7, timestamp: 100, btcBlockHeight: 5, pairs: [{ coinPair: 'BTC/USD', price: '1' }] })];
            let twin   = [eraAware({ round: 7, timestamp: 100, btcBlockHeight: 5, pairs: [{ pair:     'BTC/USD', price: 1   }] })];
            assert.strictEqual(
                ed25519.buildPriceBatchPayload(7, 7, 5, rounds, NETWORK),
                ed25519.buildPriceBatchPayload(7, 7, 5, twin, NETWORK));
        });

        // v2 has no pre-flag-day history to stay bit-identical with, and the bare
        // JSON form is the shape that breaks SLASH's "an ORACLE-tagged canonical always
        // carries `round`" invariant. v0 at this height would be headerless.
        it('wraps in the EQUIV header unconditionally, with no activation gate', function () {
            let belowFlagDay = ed25519.buildPriceBatchPayload(1, 1, 1, [eraAware({ round: 1, timestamp: 1, btcBlockHeight: 1, pairs: [{ pair: 'BTC/USD', price: '1' }] })], NETWORK);
            assert.ok(belowFlagDay.startsWith('EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|1|1|1|0||'), belowFlagDay.slice(0, 60));
            assert.strictEqual(eq.isEquivHeaderActive(1, 'mainnet'), false, 'the gate v0 would have failed here');
        });
    });
});
describe('PRICE v0 canonical: three-way twin parity', function () {

    describe('byte equality across the producer and both verifiers', function () {

        it('all three twins emit the identical canonical for one batch', function () {
            let hub = loadHubTwins(this);
            if (!hub) return;

            let fromIndexer  = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch(), NETWORK);
            let fromProducer = hub.producer.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
            let fromIngest   = hub.ingest.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());

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

            let expected = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch(), NETWORK);
            for (const [name, canonical] of [
                ['indexer verifier',  ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch(), NETWORK)],
                ['hub producer',      hub.producer.buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch())],
                ['hub ingest',        hub.ingest.buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch())],
            ]) {
                assert.strictEqual(canonical, expected, name + ' is sensitive to caller ordering');
            }
        });

        it('all three wrap in the EQUIV header unconditionally', function () {
            let hub = loadHubTwins(this);
            if (!hub) return;

            let rounds = [eraAware({ round: 1, timestamp: 1, btcBlockHeight: 1, pairs: [{ pair: 'BTC/USD', price: '1' }] })];
            let want   = 'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|1|1|1|0||';
            for (const [name, canonical] of [
                ['indexer verifier',  ed25519.buildPriceBatchPayload(1, 1, 1, rounds, NETWORK)],
                ['hub producer',      hub.producer.buildPriceBatchPayload(1, 1, 1, rounds)],
                ['hub ingest',        hub.ingest.buildPriceBatchPayload(1, 1, 1, rounds)],
            ]) {
                assert.ok(canonical.startsWith(want), name + ' did not wrap below the v0 flag-day: ' + canonical.slice(0, 60));
            }
        });
    });
});

describe('PRICE v0 canonical: three-way twin parity', function () {
    // The admission era, driven in a DEFAULT run rather than left to whoever sets the env:
    // the resolver freezes at require time, so the describe purges every module that closes
    // over it, arms at height 0, re-requires the three builders, and restores the process
    // exactly as found. Without this the per-round map's parity is asserted only when a
    // process happens to be launched armed, which is the false green row 16 closed hub-side.
    describe('the admission era: one map per round, byte-equal across all three twins', function () {
        admissionHooks();



        it('is ARMED here, whatever the process was launched with', function () {
            assert.strictEqual(armed.act.isAdmissionEra(NETWORK, 912342), true);
        });

        it('all three twins emit the identical canonical, the map LAST in each round and spelled by the one encoder', function () {
            let rounds = withMaps(batch());
            let fromIndexer  = armed.ed.buildPriceBatchPayload(FIRST, LAST, ANCHOR, rounds, NETWORK);
            let fromProducer = armed.producer.buildPriceBatchPayload(FIRST, LAST, ANCHOR, rounds);
            let fromIngest   = armed.ingest.buildPriceBatchPayload(FIRST, LAST, ANCHOR, rounds);
            assert.strictEqual(fromProducer, fromIndexer, 'OracleConsensus diverged from the indexer verifier in the admission era');
            assert.strictEqual(fromIngest,   fromIndexer, 'PriceAggregator diverged from the indexer verifier in the admission era');
            let body = JSON.parse(fromIndexer.slice(PREFIX.length));
            assert.deepStrictEqual(body.rounds.map(r => Object.keys(r).slice(-1)[0]), ['admit_blocks', 'admit_blocks', 'admit_blocks', 'admit_blocks']);
            assert.deepStrictEqual(body.rounds.map(r => r.admit_blocks),
                ['BTC:912346,DOGE:5000004', 'BTC:912347', 'BTC:912348,LTC:2400004', 'BTC:912349,DOGE:5000010,LTC:2400010']);
            assert.deepStrictEqual(body.rounds.map(r => armed.act.decodeAdmitBlocks(r.admit_blocks)),
                [MAPS[1039], MAPS[1040], MAPS[1041], MAPS[1042]].map(m => Object.fromEntries(Object.entries(m).sort())));
            // Caller ordering still normalizes identically with the map in play.
            assert.strictEqual(armed.ed.buildPriceBatchPayload(FIRST, LAST, ANCHOR, withMaps(shuffledBatch()), NETWORK), fromIndexer);
        });
    });
});

// The SINGLE-ROUND canonical, mirrored from the hub's copy of this suite. buildPriceV0Payload
// is a separate write from the batch builder with its own three twins, and unlike the batch it
// carries the round's ADMISSION MAP, so it is era-keyed on the round's own BTC anchor and the
// describe drives both eras. It ARMS ITSELF for the reason admissionHooks() gives, and the
// LOCAL twin is armed in every checkout: a forked indexer builder goes red here even where the
// hub entry is refused, and only the three-way comparison waits on the siblings.
const V0 = { ADMIT: 799000, LEGACY: 798999, ROUND: 5, TIME: 1756199400,
             TAIL: '|BTC:799004,DOGE:5000004,LTC:2400004',
             MAP:  () => ({ DOGE: 5000004, BTC: 799004, LTC: 2400004 }) };   // insertion order is not ASCII order
// The producer keys a round's pairs `coinPair` in memory and the wire-parsed round keys them
// `pair`; both spellings must reach identical bytes on all three twins.
const coinKeyed = () => [{ coinPair: 'XCP/USD', price: 0.4237 }, { pair: 'BTC/USD', price: '61234.5' },
                         { coinPair: 'AAA/USD', price: 1 }];
const pairKeyed = () => coinKeyed().map(p => ({ pair: p.coinPair || p.pair, price: p.price }));
const V0_ERAS = [
    { name: 'below the activation, where the round is legacy',             height: V0.LEGACY, map: () => undefined, tail: null },
    { name: 'at the activation, where the round carries an admission map', height: V0.ADMIT,  map: V0.MAP,          tail: V0.TAIL }];

let v0 = null;
function armV0Twins() {
    const localPaths = MODS.filter(m => !m.includes('xchain-hub')).map(m => require.resolve(m));
    const hubMods    = MODS.filter(m => m.includes('xchain-hub'));
    // Judged before anything is required, for the same reason loadHubTwins judges first.
    const refused = hubMods.map(m => siblingCheckout(__dirname, m)).find(v => !v.usable) || null;
    let hubPaths = null;
    if (!refused) {
        try { hubPaths = hubMods.map(m => require.resolve(m)); }
        catch (e) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('PRICE v0 single-round parity cannot run: xchain-hub sibling missing (' + e.message + ')');
        }
    }
    const paths    = localPaths.concat(hubPaths || []);
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(V0.ADMIT);
    const act = require('../../../src/consensus/gates/mirror_admission_gate.js');
    const ed  = require('../../../src/consensus/ed25519.js');
    let hub = null;
    if (hubPaths) {
        const OC = require('../../../../xchain-hub/src/oracle/consensus.js');
        const PA = require('../../../../xchain-hub/src/oracle/price_aggregator.js');
        const stubHub = { db: null, network: NETWORK, getPeerManager: () => ({}) };
        hub = { producer: new OC(stubHub, {}), ingest: new PA(stubHub) };
    }
    // Restored byte-exact: the arming is scoped to this describe and never to the process.
    return { act, ed, hub, refused, restore() {
        for (const [p, mod] of saved) { if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod; }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    } };
}
function v0Hooks() {
    before(function () { v0 = armV0Twins(); });
    after(function () { if (v0) v0.restore(); v0 = null; });
}
// The indexer verifier takes `network` before the height; the hub twins read theirs off the
// instance, so each side gets one helper and a call-site typo cannot read as a divergence.
const v0Local = (pairs, era) => v0.ed.buildPriceV0Payload(V0.ROUND, V0.TIME, pairs, NETWORK, era.height, era.map());
const v0Hub   = (twin, pairs, era) => twin.buildPriceV0Payload(V0.ROUND, V0.TIME, pairs, era.height, era.map());

// The era is DRIVEN, not merely named: without this case both blocks could be running the
// legacy path and the two-era structure would prove nothing.
const v0EraCase = era => function () {
    let canonical = v0Local(coinKeyed(), era);
    if (era.tail === null) {
        assert.ok(canonical.endsWith('}'), 'a legacy round ends at its JSON body: ' + canonical.slice(-40));
        assert.ok(!/BTC:799004/.test(canonical), 'a legacy round carries no admission field: ' + canonical.slice(-60));
    } else assert.ok(canonical.endsWith(era.tail), 'the admission field is missing from the rebuilt bytes: ' + canonical.slice(-60));
};
const v0SpellingCase = era => function () {
    assert.strictEqual(v0Local(coinKeyed(), era), v0Local(pairKeyed(), era),
        'the indexer verifier spells coinPair and pair to different bytes, so it cannot rebuild what the producer signed');
};
const v0ThreeWayCase = era => function () {
    if (!v0.hub) { if (v0.refused) skipOrFail(this, v0.refused, 'the PRICE v0 single-round twin parity'); else this.skip(); return; }
    let expected = v0Local(pairKeyed(), era);
    assert.strictEqual(v0Local(coinKeyed(), era), expected, 'indexer verifier: coinPair input must match pair input');
    for (const [name, twin] of [['OracleConsensus (PRODUCER)', v0.hub.producer], ['PriceAggregator (hub ingest)', v0.hub.ingest]])
        for (const pairs of [coinKeyed(), pairKeyed()])
            assert.strictEqual(v0Hub(twin, pairs, era), expected, name + ' diverged from the indexer verifier');
};

describe('PRICE v0 single-round canonical: three-way twin parity', function () {
    v0Hooks();
    it('is ARMED, so neither era block below is the other one in disguise', function () {
        assert.strictEqual(v0.act.isMirrorAdmissionProducerActive('BTC', NETWORK, V0.ADMIT), true,
            'the admission-era cases would be vacuous: the activation did not arm');
        assert.strictEqual(v0.act.isMirrorAdmissionProducerActive('BTC', NETWORK, V0.LEGACY), false,
            'the legacy cases would be vacuous: ' + V0.LEGACY + ' is not below the armed height');
    });
    for (const era of V0_ERAS) describe(era.name, function () {
        it('puts the admission field on the indexer verifier\'s bytes exactly in its own era', v0EraCase(era));
        it('spells coinPair and pair to the same bytes on the indexer verifier', v0SpellingCase(era));
        it('all three twins emit identical bytes for both spellings of the round', v0ThreeWayCase(era));
    });
});
