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
 * priceV0CanonicalAdmission (indexer half): ed25519.buildPriceV0Payload is the ON-CHAIN
 * VERIFIER of a PRICE v0 round. It rebuilds the bytes a validator quorum signed from the
 * parsed action, so the round's ADMISSION MAP must be spelled here exactly as the hub's two
 * builders spell it: chain codes in ASCII order, each CODE:digits under the canonical
 * integer spelling rule, joined by commas, the whole field appended after a single pipe and
 * inside the EQUIV wrapper. A one-sided edit in either repo makes every signed round
 * unverifiable on this side, which stops the price rail and the native-fee path with it.
 *
 * The hub carries its own instance of the three-way comparison. This is the indexer's, so a
 * one-sided edit cannot pass by running only the other repo's suite; the hub builders are
 * resolved by monorepo-relative path and a standalone checkout still drives every local case.
 *
 * THE SUITE ARMS ITSELF: the activation is read from the environment at module load, so the
 * suite purges the activation twin and its dependents from the require cache, arms the
 * regtest height, re-requires them and restores everything afterwards. Driving only whichever
 * arming the process launched with would leave the admission-era cases PENDING, and a pending
 * case on a consensus byte layout is the failure this file exists to close.
 ********************************************************************/

'use strict';

const assert = require('assert');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const ADMIT_AT  = 799000;
const LEGACY_AT = ADMIT_AT - 1;
const NETWORK   = 'regtest';
const ROUND     = 5;
const TIME      = 1756199400;

const LOCAL_MODULES = [
    '../../../src/mirror_admission_activation.js',
    '../../../src/consensus/ed25519.js'
];
const HUB_MODULES = [
    '../../../../xchain-hub/src/mirror_admission_activation.js',
    '../../../../xchain-hub/src/lib/admission_height.js',
    '../../../../xchain-hub/src/oracle/consensus.js',
    '../../../../xchain-hub/src/oracle/price_aggregator.js'
];

function pairs() {
    return [
        { pair: 'XCP/USD', price: 0.4237 },
        { pair: 'BTC/USD', price: '61234.5' },
        { pair: 'AAA/USD', price: 1 }
    ];
}

// Insertion order deliberately NOT ASCII order; the encoding sorts.
function admitMap() { return { DOGE: 5000004, BTC: 799004, LTC: 2400004 }; }
const ADMIT_FIELD = 'BTC:799004,DOGE:5000004,LTC:2400004';

let armed = null;

function armTwins() {
    const localPaths = LOCAL_MODULES.map(m => require.resolve(m));
    // Judge every hub twin before requiring any: absent, or a lane symlink into a live main
    // checkout, is refused, and the hub cases skip (or fail naming why) through hubOrSkip.
    const hubVerdict = HUB_MODULES.map(m => siblingCheckout(__dirname, m)).find(v => !v.usable) || null;
    let hubPaths = null;
    if (!hubVerdict) {
        try { hubPaths = HUB_MODULES.map(m => require.resolve(m)); }
        catch (e) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('PRICE v0 admission parity cannot run: xchain-hub sibling missing (' + e.message + ')');
        }
    }

    const paths    = localPaths.concat(hubPaths || []);
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(ADMIT_AT);

    const ed  = require('../../../src/consensus/ed25519.js');
    const act = require('../../../src/mirror_admission_activation.js');
    let hub = null;
    if (hubPaths) {
        const OracleConsensus = require('../../../../xchain-hub/src/oracle/consensus.js');
        const PriceAggregator = require('../../../../xchain-hub/src/oracle/price_aggregator.js');
        const stubHub = { db: null, network: NETWORK, getPeerManager: () => ({}) };
        hub = { producer: new OracleConsensus(stubHub, {}), ingest: new PriceAggregator(stubHub) };
    }

    function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }

    return { ed: ed, act: act, hub: hub, hubVerdict: hubVerdict, restore: restore };
}

function build(height, map, network) {
    return armed.ed.buildPriceV0Payload(ROUND, TIME, pairs(), network || NETWORK, height, map);
}

function useArmedTwins() {
    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });
}

function hubOrSkip(ctx) {
    if (armed.hub) return armed.hub;
    // A refused hub twin skips, or fails naming the reason under strict.
    if (armed.hubVerdict) skipOrFail(ctx, armed.hubVerdict, 'the PRICE v0 hub twin parity');
    else ctx.skip();
    return null;
}

describe('PRICE v0 canonical: the admission field on the indexer verifier', function () {
    useArmedTwins();

    it('is ARMED for this suite, so neither era case is vacuous', function () {
        assert.strictEqual(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT), true);
        assert.strictEqual(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, LEGACY_AT), false);
        assert.strictEqual(armed.act.isMirrorAdmissionProducerActive('BTC', 'mainnet', ADMIT_AT + 1000000), false);
    });

    it('rebuilds a legacy round byte for byte as it did before the field existed', function () {
        const canonical = build(LEGACY_AT, undefined);
        assert.ok(canonical.endsWith('}'), 'a legacy round ends at its JSON body: ' + canonical.slice(-40));
        assert.ok(!/BTC:799004/.test(canonical));
        // An unarmed network is legacy at every height, which is the from-genesis replay case.
        assert.ok(build(ADMIT_AT + 1000000, undefined, 'mainnet').endsWith('}'));
    });

    it('appends the ASCII-ordered map after the body and inside the EQUIV wrapper', function () {
        const canonical = build(ADMIT_AT, admitMap());
        assert.ok(canonical.startsWith('EQUIV|'), canonical.slice(0, 40));
        assert.ok(canonical.endsWith('|' + ADMIT_FIELD), canonical.slice(-60));
        const cut  = canonical.lastIndexOf('|');
        const body = canonical.slice(canonical.indexOf('{'), cut);
        assert.deepStrictEqual(Object.keys(JSON.parse(body)),
            ['round', 'timestamp', 'btc_block_height', 'pairs'],
            'the round body must be unchanged: the admission field is APPENDED, never interleaved');
        assert.deepStrictEqual(armed.act.decodeAdmitBlocks(canonical.slice(cut + 1)),
            { BTC: 799004, DOGE: 5000004, LTC: 2400004 });
    });

    it('is insensitive to the map\'s insertion order and sensitive to its heights', function () {
        assert.strictEqual(build(ADMIT_AT, { LTC: 2400004, BTC: 799004, DOGE: 5000004 }),
            build(ADMIT_AT, admitMap()));
        assert.notStrictEqual(build(ADMIT_AT, { DOGE: 5000004, BTC: 799005, LTC: 2400004 }),
            build(ADMIT_AT, admitMap()));
    });

    it('refuses in BOTH directions rather than rebuilding the wrong era', function () {
        assert.throws(() => build(ADMIT_AT, null), /refusing to build a legacy canonical/);
        assert.throws(() => build(ADMIT_AT, undefined), /refusing to build a legacy canonical/);
        assert.throws(() => build(LEGACY_AT, admitMap()), /refusing to build an admission-era canonical/);
        assert.throws(() => build(ADMIT_AT + 1000000, admitMap(), 'mainnet'),
            /refusing to build an admission-era canonical/);
    });

    it('refuses a map the encoding cannot spell injectively', function () {
        for (const bad of [{ BTC: '0799004' }, { btc: 799004 }, { BTC: -1 }, {}])
            assert.throws(() => build(ADMIT_AT, bad),
                /canonically spelled|closed vocabulary|EMPTY admission map/, JSON.stringify(bad));
    });
});

describe('PRICE v0 canonical: the admission field on the indexer verifier', function () {
    useArmedTwins();
    describe('against the hub producer and its ingest verifier', function () {
        it('all three twins emit the identical canonical for an admission-era round', function () {
            const hub = hubOrSkip(this);
            if (!hub) return;
            const expected = build(ADMIT_AT, admitMap());
            assert.strictEqual(hub.producer._buildPriceV0Payload(ROUND, TIME, pairs(), ADMIT_AT, admitMap()),
                expected, 'the hub PRODUCER would sign bytes this verifier cannot rebuild');
            assert.strictEqual(hub.ingest._buildPriceV0Payload(ROUND, TIME, pairs(), ADMIT_AT, admitMap()),
                expected, 'the hub ingest verifier diverged from this verifier');
        });

        it('all three twins emit the identical canonical for a legacy round', function () {
            const hub = hubOrSkip(this);
            if (!hub) return;
            const expected = build(LEGACY_AT, undefined);
            assert.strictEqual(hub.producer._buildPriceV0Payload(ROUND, TIME, pairs(), LEGACY_AT, undefined), expected);
            assert.strictEqual(hub.ingest._buildPriceV0Payload(ROUND, TIME, pairs(), LEGACY_AT, undefined), expected);
        });
    });
});

describe('PRICE v0 canonical: the admission field on the indexer verifier', function () {
    useArmedTwins();
    describe('against the hub producer and its ingest verifier', function () {
        it('all three refuse the same two wrong-era builds', function () {
            const hub = hubOrSkip(this);
            if (!hub) return;
            for (const twin of [hub.producer, hub.ingest]) {
                assert.throws(() => twin._buildPriceV0Payload(ROUND, TIME, pairs(), ADMIT_AT, null),
                    /refusing to build a legacy canonical/);
                assert.throws(() => twin._buildPriceV0Payload(ROUND, TIME, pairs(), LEGACY_AT, admitMap()),
                    /refusing to build an admission-era canonical/);
            }
        });

        // The encoder itself is ONE definition per repo held byte-identical across them, so
        // the two copies must agree on every map, not merely on the ones spelled above.
        it('the two copies of the encoder agree over a generated corpus', function () {
            const hub = hubOrSkip(this);
            if (!hub) return;
            const theirs = require('../../../../xchain-hub/src/mirror_admission_activation.js');
            const chains = ['BTC', 'LTC', 'DOGE'];
            let compared = 0;
            for (let mask = 1; mask < 8; mask++) {
                for (const h of [0, 1, 12, 23, 799004, 9007199254740989]) {
                    const map = {};
                    chains.forEach((c, i) => { if (mask & (1 << i)) map[c] = h + i; });
                    const mine = armed.act.encodeAdmitBlocks(map);
                    assert.strictEqual(theirs.encodeAdmitBlocks(map), mine, JSON.stringify(map));
                    assert.deepStrictEqual(theirs.decodeAdmitBlocks(mine), armed.act.decodeAdmitBlocks(mine));
                    compared++;
                }
            }
            assert.strictEqual(compared, 7 * 6, 'not vacuous: every non-empty subset at every height');
        });
    });
});
