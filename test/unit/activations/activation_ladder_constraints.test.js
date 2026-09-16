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
 * test/unit/activations/activation_ladder_constraints.test.js
 *
 * Asserts the two fork-avoiding constraints the bridge activation ladder must satisfy
 * at a train cut, which no other test in the tree checks.
 *
 *   C3 (halt-before-fork): the train boundary for the rule set that introduces the
 *   bridge must sit BELOW that coin's bridge activation height, on the SAME CLOCK
 *   (both are BTC heights on the same network), so a node that has not updated past
 *   the boundary HALTS there instead of reaching a bridge action it does not
 *   implement (train_activation.js:255-265, XChainIndexer.js:2139).
 *
 *   C4 (arming order): each destination chain's own bridge height must arrive no
 *   later, in WALL CLOCK, than the BTC origin's, because the lock handler checks the
 *   destination's escrow address and coin but never the destination's own
 *   activation (actions/xbridge.js), so a destination arming after its origin would
 *   admit a lock its own chain cannot yet apply.
 *
 * TODAY'S STATE (2026-09-12, before the cut). Every mainnet and testnet slot in
 * XCHAIN_BRIDGE_ACTIVATION is still the house sentinel BRIDGE_SENTINEL, and
 * TRAIN_ACTIVATION carries only the launch-floor '1.0.0' row; regtest is 0 on both
 * maps by design, which is genesis-active, not a sentinel. The "against the shipped
 * maps" suites below therefore pass honestly today by asserting the degenerate state
 * they find instead of faking a real ordering, and re-grade for real the moment
 * BRIDGE_TRAIN_VERSION is added to TRAIN_ACTIVATION and a coin's bridge height moves
 * off the sentinel. The "local fixture" suites prove the comparison logic itself is
 * sound and falsifiable right now, independent of whether the cut has happened.
 *
 * C4 CANNOT be soundly checked as a raw cross-chain height comparison once real
 * heights land, and this file does not pretend otherwise. XCHAIN_BRIDGE_ACTIVATION
 * keys each coin on ITS OWN chain's block height, and BTC, LTC and DOGE testnet run
 * at wildly different heights for reasons that have nothing to do with arming order
 * (measured 2026-09-12: TBTC 152141, TLTC 4884268, TDOGE 67890745). A worked ladder
 * for the bridge cut proves the point: DOGE is sized to arm at height
 * 67891080, far above BTC's 152202, while DOGE arms about 6 hours EARLIER in wall
 * clock. A test asserting `destHeight <= originHeight` on those real numbers would
 * FAIL LOUDLY on the CORRECT ladder, which is worse than not checking it: the reader
 * mid-ceremony would be told a right answer is wrong. So the shipped-map C4 case
 * below asserts only what raw heights CAN prove honestly (today's sentinel-equality
 * floor), fails loudly and explicitly the moment a real height appears instead of
 * silently mis-grading it, and the real wall-clock inequality is proven separately
 * on an explicit-hours fixture below. A real per-cut C4 gate needs either the
 * wall-clock offsets recorded alongside each height or a per-coin cadence constant;
 * neither train_activation.js nor xchain_bridge_activation.js carries one today.
 *
 * SINCE THE CUT (2026-09-16). The v0.19.0 train wrote the '0.19.0' row and the three
 * testnet bridge heights, so the C3 shipped-map case grades for real, and the C4
 * shipped-map case now carries what the paragraph above asked for: the tip and the
 * measured cadence of each chain at the sitting the heights were sized in (CUT_RECORD
 * below), so each height's wall-clock offset is (height - tip) * cadence and the
 * destination-before-origin inequality is proven in hours against the shipped map
 * itself. Mainnet stays on the sentinel and is still graded as sentinel equality.
 */

'use strict';

const assert = require('assert');

const { TRAIN_ACTIVATION } = require('../../../src/train_activation.js');
const { XCHAIN_BRIDGE_ACTIVATION: BRIDGE } = require('../../../src/xchain_bridge_activation.js');

// The house 'never armed' literal xchain_bridge_activation.js writes on every mainnet and
// testnet slot until a train sizes it (its own header/comments call it "the house sentinel").
// Not exported by the source module, so pinned here as a plain literal; a change to it would
// already be caught by activation_constants_parity.test.js as a canon drift.
const BRIDGE_SENTINEL = 9999999999;

// The platform version that introduces the bridge. TRAIN_ACTIVATION carries no row for it yet
// (measured 2026-09-12); the cases below name that honestly instead of comparing against the
// wrong (launch-floor) row.
const BRIDGE_TRAIN_VERSION = '0.19.0';

const NETS       = ['mainnet', 'testnet'];
const ALL_COINS  = ['BTC', 'LTC', 'DOGE'];
const DEST_COINS = ['LTC', 'DOGE'];

// The sitting the v0.19.0 testnet heights were sized in: each chain's chain_tip and its
// seconds per block over the 99 blocks before it, read together at 2026-09-16 11:53Z.
// A later train re-sizes by a new row and a new record here, never by editing these.
const CUT_RECORD = {
    testnet: {
        BTC:  { tip: 152676,   secondsPerBlock: 548.6 },
        LTC:  { tip: 4887525,  secondsPerBlock: 128.3 },
        DOGE: { tip: 67900097, secondsPerBlock: 27.3 },
    },
};

// Resolve the height a chain identified by COIN:NETWORK actually reads out of a
// XCHAIN_BRIDGE_ACTIVATION-shaped map: the coin-specific key when present, else the bare
// network fallback. Mirrors xchain_bridge_activation._activationThreshold exactly, restated
// here (as activation_constants_parity.test.js's resolveChainKey also does) because these checks
// must resolve the SAME way the shipped predicate does or they would grade a height nothing
// ever reads.
function resolveBridgeHeight(map, coin, net) {
    const key = coin + ':' + net;
    return map[key] !== undefined ? map[key] : map[net];
}

// C3 over one train row and one bridge map: every armed (non-sentinel) coin:network pair's
// bridge height must sit strictly above that network's train boundary. Returns a list of
// violation messages (empty means C3 holds). Shared by the shipped-map case and the fixture
// falsification case below so the falsification proves the exact logic that will run against
// the real maps once the cut lands.
function c3Violations(trainRow, bridgeMap) {
    const violations = [];
    for (const net of NETS) {
        const trainHeight = trainRow[net];
        for (const coin of ALL_COINS) {
            const bridgeHeight = resolveBridgeHeight(bridgeMap, coin, net);
            if (bridgeHeight === BRIDGE_SENTINEL) continue; // not armed on this chain; nothing to order yet
            if (!(trainHeight < bridgeHeight)) {
                violations.push('C3 violated: the ' + net + ' train boundary (' + trainHeight + ') is not below ' +
                    coin + ':' + net + '\'s bridge activation height (' + bridgeHeight + '); a node that has not ' +
                    'updated past the train boundary would still be applying blocks when it reaches a ' + coin +
                    ' bridge action it does not implement, instead of halting first. That is a fork shipped as a release.');
            }
        }
    }
    return violations;
}

// C4 over one bridge map: every destination coin's height must be at or below the BTC
// origin's height on the same network. Shared the same way as c3Violations above.
function c4Violations(bridgeMap) {
    const violations = [];
    for (const net of NETS) {
        const originHeight = resolveBridgeHeight(bridgeMap, 'BTC', net);
        for (const coin of DEST_COINS) {
            const destHeight = resolveBridgeHeight(bridgeMap, coin, net);
            if (!(destHeight <= originHeight)) {
                violations.push('C4 violated: ' + coin + ':' + net + '\'s bridge activation height (' + destHeight +
                    ') is above BTC:' + net + '\'s (' + originHeight + '); a lock mined on the BTC origin before ' +
                    'the destination is armed would admit a transfer the destination cannot yet apply.');
            }
        }
    }
    return violations;
}

describe('activation ladder fork-avoiding constraints (the bridge train cut)', function () {
    describe('C3: train boundary < bridge height, same clock (against the shipped maps)', function () {
        const trainRow = TRAIN_ACTIVATION[BRIDGE_TRAIN_VERSION];

        it('today: TRAIN_ACTIVATION carries no ' + BRIDGE_TRAIN_VERSION + ' row yet, so C3 is not yet decidable', function () {
            if (trainRow) { this.skip(); return; }
            assert.strictEqual(TRAIN_ACTIVATION[BRIDGE_TRAIN_VERSION], undefined,
                'TRAIN_ACTIVATION.' + BRIDGE_TRAIN_VERSION + ' now exists; the next case should be running for ' +
                'real instead of this placeholder, which should now report itself skipped');
        });

        it('once ' + BRIDGE_TRAIN_VERSION + ' is armed: holds C3 for every armed coin:network pair', function () {
            if (!trainRow) { this.skip(); return; }
            for (const net of NETS) {
                assert.ok(Number.isFinite(trainRow[net]),
                    'TRAIN_ACTIVATION.' + BRIDGE_TRAIN_VERSION + '.' + net + ' must be a finite BTC height');
            }
            const armedPairs = NETS.reduce((n, net) => n + ALL_COINS.filter(
                coin => resolveBridgeHeight(BRIDGE, coin, net) !== BRIDGE_SENTINEL).length, 0);
            assert.ok(armedPairs > 0, 'not vacuous: at least one armed coin:network pair must exist once the train row lands');
            const violations = c3Violations(trainRow, BRIDGE);
            assert.deepStrictEqual(violations, [], violations.join('\n'));
        });

        it('regtest: every TRAIN_ACTIVATION row and the bridge both stay pinned to genesis (0)', function () {
            const versions = Object.keys(TRAIN_ACTIVATION);
            assert.ok(versions.length > 0, 'TRAIN_ACTIVATION must carry at least one row');
            for (const version of versions) {
                assert.strictEqual(TRAIN_ACTIVATION[version].regtest, BRIDGE.regtest,
                    'TRAIN_ACTIVATION[' + version + '].regtest (' + TRAIN_ACTIVATION[version].regtest + ') does ' +
                    'not equal XCHAIN_BRIDGE_ACTIVATION.regtest (' + BRIDGE.regtest + '); regtest is exempt from ' +
                    'the strict C3 inequality by design (a regtest stack is rebuilt from genesis, so there is no ' +
                    'lagging fleet member to fork), and the meaningful check there is that both stay pinned to ' +
                    'the same genesis height rather than that one precedes the other');
            }
        });
    });
});

describe('activation ladder fork-avoiding constraints (the bridge train cut)', function () {
    describe('C3: comparison logic falsified on a local fixture (never the shipped maps)', function () {
        it('holds on a synthetic post-cut fixture built from a worked bridge ladder', function () {
            const fixtureTrain = { mainnet: 9999999999, testnet: 152162, regtest: 0 };
            const fixtureBridge = Object.assign({}, BRIDGE, {
                'BTC:testnet': 152202, 'LTC:testnet': 4884304, 'DOGE:testnet': 67891080
            });
            assert.deepStrictEqual(c3Violations(fixtureTrain, fixtureBridge), []);
        });

        it('goes red, naming both heights, when the fixture is perturbed so the train boundary lands AT the bridge height', function () {
            const fixtureTrain = { mainnet: 9999999999, testnet: 152202, regtest: 0 };
            const fixtureBridge = Object.assign({}, BRIDGE, { 'BTC:testnet': 152202 });
            const violations = c3Violations(fixtureTrain, fixtureBridge);
            assert.strictEqual(violations.length, 1);
            assert.ok(/the testnet train boundary \(152202\) is not below BTC:testnet's bridge activation height \(152202\)/
                .test(violations[0]), 'expected the violation to name both heights, got: ' + violations[0]);
        });

        it('goes red, naming both heights, when the fixture is perturbed so the train boundary lands ABOVE the bridge height', function () {
            const fixtureTrain = { mainnet: 9999999999, testnet: 152210, regtest: 0 };
            const fixtureBridge = Object.assign({}, BRIDGE, { 'BTC:testnet': 152202 });
            const violations = c3Violations(fixtureTrain, fixtureBridge);
            assert.strictEqual(violations.length, 1);
            assert.ok(/the testnet train boundary \(152210\) is not below BTC:testnet's bridge activation height \(152202\)/
                .test(violations[0]), 'expected the violation to name both heights, got: ' + violations[0]);
        });
    });
});

describe('activation ladder fork-avoiding constraints (the bridge train cut)', function () {
    describe('C4: destination bridge height at or before the BTC origin\'s, same network (against the shipped maps)', function () {
        it('mainnet: every slot is still the sentinel, so C4 degenerates to sentinel === sentinel there', function () {
            const originHeight = resolveBridgeHeight(BRIDGE, 'BTC', 'mainnet');
            assert.strictEqual(originHeight, BRIDGE_SENTINEL, 'BTC:mainnet has moved off the sentinel; a mainnet arm needs its own CUT_RECORD');
            for (const coin of DEST_COINS)
                assert.strictEqual(resolveBridgeHeight(BRIDGE, coin, 'mainnet'), BRIDGE_SENTINEL,
                    coin + ':mainnet has moved off the sentinel; a mainnet arm needs its own CUT_RECORD');
        });

        it('testnet: each destination arms no later in wall clock than the BTC origin, from the shipped heights and the cut record', function () {
            // A raw height comparison cannot do this across chains (see the file header); the
            // wall-clock offset of a height is (height - tip at the cut) * measured cadence.
            const record = CUT_RECORD.testnet;
            const hours = (coin) => {
                const h = resolveBridgeHeight(BRIDGE, coin, 'testnet');
                assert.ok(Number.isFinite(h) && h !== BRIDGE_SENTINEL, coin + ':testnet is not a sized height');
                assert.ok(h > record[coin].tip, coin + ':testnet (' + h + ') is not above the tip it was sized from (' + record[coin].tip + ')');
                return (h - record[coin].tip) * record[coin].secondsPerBlock / 3600;
            };
            const originHours = hours('BTC');
            for (const coin of DEST_COINS) {
                const destHours = hours(coin);
                assert.ok(destHours <= originHours,
                    'C4 violated: ' + coin + ':testnet arms ' + destHours.toFixed(2) + ' h after the cut, after the BTC origin\'s ' +
                    originHours.toFixed(2) + ' h; a lock mined on BTC before ' + coin + ' is armed would admit a transfer it cannot apply');
            }
            // The train boundary sits inside the destination lead as well, so the roll window the
            // boundary allows ends before any chain arms (C2 and C5 read together).
            const trainHours = (TRAIN_ACTIVATION[BRIDGE_TRAIN_VERSION].testnet - record.BTC.tip) * record.BTC.secondsPerBlock / 3600;
            assert.ok(trainHours > 0 && trainHours <= originHours, 'the train boundary (' + trainHours.toFixed(2) + ' h) must precede the origin arm');
        });

        it('regtest: every coin resolves to the same genesis height (0) via the bare fallback', function () {
            assert.strictEqual(BRIDGE.regtest, 0, 'XCHAIN_BRIDGE_ACTIVATION.regtest must be genesis (0)');
            for (const coin of ALL_COINS) {
                const height = resolveBridgeHeight(BRIDGE, coin, 'regtest');
                assert.strictEqual(height, 0,
                    coin + ':regtest (' + height + ') must equal the regtest genesis height 0; C4 is trivially ' +
                    'satisfied there by design, not by luck');
            }
        });
    });
});

describe('activation ladder fork-avoiding constraints (the bridge train cut)', function () {
    describe('C4: comparison logic falsified on a local fixture (never the shipped maps)', function () {
        // The worked ladder's raw heights are NOT comparable across chains (LTC and DOGE heights
        // vastly exceed BTC's regardless of arming order; see the file header), so c4Violations
        // is exercised here on a same-clock synthetic map instead, to prove the <= comparison
        // itself is sound and falsifiable independent of that cross-chain limitation. Both
        // mainnet and testnet keys are given so every NETS x DEST_COINS pair the function walks
        // resolves to a real number rather than undefined.
        it('holds on a same-clock synthetic fixture (both networks, both destinations at or before the origin)', function () {
            const sameClockFixture = {
                'BTC:mainnet': 500000, 'LTC:mainnet': 499990, 'DOGE:mainnet': 499995,
                'BTC:testnet': 200000, 'LTC:testnet': 199990, 'DOGE:testnet': 199995
            };
            assert.deepStrictEqual(c4Violations(sameClockFixture), []);
        });

        it('goes red, naming both heights, when a destination is perturbed to arm after the BTC origin', function () {
            const fixtureBridge = {
                'BTC:mainnet': 500000, 'LTC:mainnet': 499990, 'DOGE:mainnet': 499995,
                'BTC:testnet': 200000, 'LTC:testnet': 200010, 'DOGE:testnet': 199995
            };
            const violations = c4Violations(fixtureBridge);
            assert.strictEqual(violations.length, 1);
            assert.ok(/LTC:testnet's bridge activation height \(200010\) is above BTC:testnet's \(200000\)/
                .test(violations[0]), 'expected the violation to name both heights, got: ' + violations[0]);
        });
    });

    describe('C4: wall-clock inequality proven directly in hours (the form raw heights cannot express across chains)', function () {
        // The real inequality (destinations arm no later than the origin): d_dest * s_dest <= d_BTC * s_BTC, stated
        // here in wall-clock hours since neither shipped map carries a per-coin cadence. Proven
        // against a worked ladder (LTC +3.1h, DOGE +3.0h, BTC +9.0h) and
        // falsified by a destination that arrives after the origin. This is the check that
        // actually verifies the ordering; the raw-height cases above are the closest honest proxy this
        // file can run against the committed constants alone.
        function assertC4Hours(destHours, originHours, label) {
            assert.ok(destHours <= originHours,
                label + ': C4 (arming order) violated, destination arms ' + destHours + 'h after the cut, after the BTC ' +
                'origin\'s ' + originHours + 'h');
        }

        it('holds on a worked ladder (LTC 3.1h and DOGE 3.0h, both at or before BTC 9.0h)', function () {
            assertC4Hours(3.1, 9.0, 'row-36 worked ladder, LTC');
            assertC4Hours(3.0, 9.0, 'row-36 worked ladder, DOGE');
        });

        it('goes red, naming both hour figures, at the measured breaking band (destination slowed past 3x)', function () {
            // Measurement shows C4 breaking at a 2.95x to 3.00x destination slowdown against a 9.0h
            // origin lead; 3.1x (9.3h) is past the band.
            assert.throws(() => assertC4Hours(9.3, 9.0, 'destination slowed 3.1x'),
                /C4 \(arming order\) violated, destination arms 9\.3h after the cut, after the BTC origin's 9h/,
                'C4 must fail loudly, naming both hour figures, once the destination slows past the measured band');
        });
    });
});
