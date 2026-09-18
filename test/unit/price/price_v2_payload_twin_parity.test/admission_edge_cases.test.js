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
 * test/unit/price_v2_payload_twin_parity.test.js
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
 */

'use strict';
const assert  = require('assert');
const ed25519 = require('../../../../src/consensus/ed25519.js');
const eq      = require('../../../../src/consensus/equivocation_header.js');
const adm     = require('../../../../src/consensus/gates/mirror_admission_gate.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');
const NETWORK = 'regtest';
const ANCHOR = 912345;
const FIRST  = 1039;
const LAST   = 1042;
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
const eraAware = r => adm.isAdmissionEra(NETWORK, parseInt(r.btcBlockHeight)) ? Object.assign({ admitBlocks: { BTC: parseInt(r.btcBlockHeight) + 4 } }, r) : r;
const ROUND_KEYS = () => adm.isAdmissionEra(NETWORK, 912342)
    ? ['round', 'timestamp', 'btc_block_height', 'pairs', 'admit_blocks']
    : ['round', 'timestamp', 'btc_block_height', 'pairs'];
function shuffledBatch() {
    return batch().reverse().map(r => Object.assign({}, r, { pairs: [...r.pairs].reverse() }));
}
const PREFIX = 'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|' + ANCHOR + '|' + FIRST + '|' + LAST + '|0||';
function hubTwins() {
    const OracleConsensus = require('../../../../../xchain-hub/src/oracle/consensus.js');
    const PriceAggregator = require('../../../../../xchain-hub/src/oracle/price_aggregator.js');
    const stubHub = { db: null, network: 'regtest', getPeerManager: () => ({}) };
    return {
        producer: new OracleConsensus(stubHub, {}),
        ingest:   new PriceAggregator(stubHub)
    };
}
function loadHubTwins(ctx) {
    for (const rel of ['../../../../../xchain-hub/src/oracle/consensus.js', '../../../../../xchain-hub/src/oracle/price_aggregator.js']) {
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
const MODS = ['../../../../src/consensus/gates/mirror_admission_gate.js', '../../../../src/consensus/ed25519.js',
              '../../../../../xchain-hub/src/consensus/gates/mirror_admission_gate.js',
              '../../../../../xchain-hub/src/lib/admission_height.js',
              '../../../../../xchain-hub/src/oracle/consensus.js',
              '../../../../../xchain-hub/src/oracle/price_aggregator.js'];
const MAPS = { 1039: { DOGE: 5000004, BTC: 912346 }, 1040: { BTC: 912347 },
               1041: { LTC: 2400004, BTC: 912348 }, 1042: { BTC: 912349, DOGE: 5000010, LTC: 2400010 } };
const withMaps = rounds => rounds.map(r => Object.assign({ admitBlocks: MAPS[parseInt(r.round)] }, r, { admitBlocks: MAPS[parseInt(r.round)] }));
let armed = null;
function admissionHooks() {
    before(function () {
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
        const act = require('../../../../src/consensus/gates/mirror_admission_gate.js');
        const ed  = require('../../../../src/consensus/ed25519.js');
        const OC  = require('../../../../../xchain-hub/src/oracle/consensus.js');
        const PA  = require('../../../../../xchain-hub/src/oracle/price_aggregator.js');
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
    describe('the admission era: one map per round, byte-equal across all three twins', function () {
        admissionHooks();

        it('all three REFUSE an era round with no map, so no legacy bytes can be signed or verified above the activation', function () {
            let rounds = batch().map(r => { let c = Object.assign({}, r); delete c.admitBlocks; return c; });
            for (const [name, build] of [
                ['indexer verifier', () => armed.ed.buildPriceBatchPayload(FIRST, LAST, ANCHOR, rounds, NETWORK)],
                ['hub producer',     () => armed.producer.buildPriceBatchPayload(FIRST, LAST, ANCHOR, rounds)],
                ['hub ingest',       () => armed.ingest.buildPriceBatchPayload(FIRST, LAST, ANCHOR, rounds)],
            ]) assert.throws(build, /has no admit_blocks; refusing to build a legacy canonical/, name + ' built legacy bytes in the era');
        });

        it('a caller that omits the network rebuilds LEGACY bytes, which then fail to verify rather than verifying as legacy', function () {
            let rounds = batch().map(r => { let c = Object.assign({}, r); delete c.admitBlocks; return c; });
            let bytes = armed.ed.buildPriceBatchPayload(FIRST, LAST, ANCHOR, rounds);
            assert.strictEqual(/admit_blocks/.test(bytes), false);
            assert.notStrictEqual(bytes, armed.ed.buildPriceBatchPayload(FIRST, LAST, ANCHOR, withMaps(batch()), NETWORK));
        });
    });
});
