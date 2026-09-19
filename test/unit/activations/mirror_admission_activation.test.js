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
 * test/unit/activations/mirror_admission_activation.test.js
 *
 * The predicate matrix for the time-keyed mirror barrier family's arming seam. Every
 * case here drives a BEHAVIOUR the design depends on, not a label:
 *
 *   - `0 >= null` is true in JavaScript, so an inert key that is compared without a
 *     Number.isFinite guard on the THRESHOLD arms every network at height 0. That is
 *     the single defect this file exists to catch, and it is driven at height 0 and at
 *     a huge height so a guard that only happens to work at the boundary fails here.
 *   - The follower window is PER CHAIN. A flat block count would collapse DOGE's
 *     clock-skew tolerance from 3600 s to 360 s, so BTC and DOGE are asserted to
 *     accept genuinely different windows from the same tip.
 *   - The legacy-row rule holds at EVERY height. A row with no admission height for
 *     this chain binds by effective_time <= t(B) whether the chain is below the flag
 *     day or a thousand blocks above it; the failure mode being guarded is the bare
 *     `admit_block_<c> <= ?` on a nullable column, which drops legacy rows silently.
 */

'use strict';

const assert = require('assert');
const path   = require('path');

const MODULE_PATH = path.resolve(__dirname, '../../../src/consensus/gates/mirror_admission_gate.js');
const mirror = require(MODULE_PATH);

// Load a FRESH copy of the module against a stand-in environment. The activation maps are
// frozen at require time from process.env, so the armed direction of every predicate is
// only reachable by re-requiring; without this the whole armed half of the matrix would be
// untestable and the suite would only ever prove the inert branch.
function loadWith(envValue) {
    const saved = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    const savedModule = require.cache[MODULE_PATH];
    try {
        if (envValue === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = envValue;
        delete require.cache[MODULE_PATH];
        return require(MODULE_PATH);
    } finally {
        if (saved === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = saved;
        require.cache[MODULE_PATH] = savedModule;
    }
}

describe('mirror_admission_activation: the arming seam @regression', function () {
    // THE `0 >= null` TRAP. Every live network key is null today, so a predicate with no
    // Number.isFinite guard on the threshold reports every one of them ARMED at height 0
    // and the whole fleet silently switches binding rules the moment this ships.
    it('holds an INERT (null) key inert at height 0 and at a huge height', function () {
        const inert = [
            ['BTC', 'mainnet'], ['LTC', 'mainnet'], ['DOGE', 'mainnet'],
        ];
        for (const [coin, net] of inert) {
            assert.strictEqual(mirror.MIRROR_ADMISSION_ACTIVATION[coin + ':' + net], null,
                'not vacuous: ' + coin + ':' + net + ' must still be the inert null this case is about');
            for (const h of [0, 1, 999999999, Number.MAX_SAFE_INTEGER]) {
                assert.strictEqual(mirror.isMirrorAdmissionProducerActive(coin, net, h), false,
                    'producer armed an INERT key ' + coin + ':' + net + ' at height ' + h);
                assert.strictEqual(mirror.isMirrorAdmissionConsumerActive(coin, net, h), false,
                    'consumer armed an INERT key ' + coin + ':' + net + ' at height ' + h);
            }
        }
    });

    // An unknown chain is a chain the federation added after this build shipped. It must read
    // as the era it was signed under, never as armed, or the new chain's first mirrored row is
    // bound by a rule no producer was applying when it was signed.
    it('reads an unknown (coin, network) key as INERT, never as armed', function () {
        for (const [coin, net] of [['XMR', 'mainnet'], ['BTC', 'signet'], ['BCH', 'regtest'], ['', 'regtest'], ['BTC', '']]) {
            for (const h of [0, 1000000]) {
                assert.strictEqual(mirror.isMirrorAdmissionProducerActive(coin, net, h), false,
                    'unknown key ' + coin + ':' + net + ' armed the producer at ' + h);
                assert.strictEqual(mirror.isMirrorAdmissionConsumerActive(coin, net, h), false,
                    'unknown key ' + coin + ':' + net + ' armed the consumer at ' + h);
            }
        }
        // A null/undefined coin or network must not reach the map at all, and must not throw
        // inside a verdict path.
        assert.strictEqual(mirror.admissionKey(null, 'regtest'), null);
        assert.strictEqual(mirror.admissionKey('BTC', undefined), null);
        assert.strictEqual(mirror.isMirrorAdmissionProducerActive(null, null, 0), false);
        // Prototype keys are not map entries: hasOwnProperty is what stops 'toString' resolving.
        assert.strictEqual(mirror.isMirrorAdmissionProducerActive('toString', 'toString', 0), false);
    });

    // Driven against an ARMED venue so the non-finite-height guard is proven where it can
    // actually fail: on an inert key every height returns false for the other reason.
    it('never arms on a non-finite height, even on an armed chain', function () {
        const armed = loadWith('armed');
        assert.strictEqual(armed.MIRROR_ADMISSION_ACTIVATION['BTC:regtest'], 0,
            'not vacuous: the venue lever must have armed BTC:regtest at 0 for this case to mean anything');
        assert.strictEqual(armed.isMirrorAdmissionProducerActive('BTC', 'regtest', 0), true,
            'not vacuous: a readable height on the same key must arm');
        for (const h of [NaN, undefined, Infinity, -Infinity, 'not-a-height', {}]) {
            assert.strictEqual(armed.isMirrorAdmissionProducerActive('BTC', 'regtest', h), false,
                'an unreadable height ' + JSON.stringify(String(h)) + ' armed the producer');
            assert.strictEqual(armed.isMirrorAdmissionConsumerActive('BTC', 'regtest', h), false,
                'an unreadable height ' + JSON.stringify(String(h)) + ' armed the consumer');
        }
    });
});

describe('mirror_admission_activation: canonical version seam @regression', function () {
    it('uses legacy canonical bytes for an inert row with no map', function () {
        const inert = loadWith(undefined);
        assert.strictEqual(inert.admissionCanonicalValue('INERT-ABSENT', 'regtest', 280, null), null);
    });

    it('uses legacy canonical bytes for an inert row with a present map', function () {
        const inert = loadWith(undefined);
        assert.strictEqual(inert.admissionCanonicalValue('INERT-PRESENT', 'regtest', 280, { BTC: 280 }), null);
    });

    it('encodes a present map for an armed row', function () {
        const armed = loadWith('armed');
        assert.strictEqual(armed.admissionCanonicalValue('ARMED-PRESENT', 'regtest', 280, { BTC: 280 }), 'BTC:280');
    });

    it('uses legacy canonical bytes for an armed row with no map', function () {
        const armed = loadWith('armed');
        assert.strictEqual(armed.admissionCanonicalValue('ARMED-ABSENT', 'regtest', 280, null), null);
    });
});

describe('mirror_admission_activation: the arming seam @regression', function () {
    // The three testnet keys left the inert list above at the 2026-09-16 cut, and what
    // replaces the coverage they carried is the cut's OWN property rather than nothing.
    // The producer and the consumer arm at DIFFERENT heights, which is the entire reason
    // the family carries two maps instead of one: between them, producers stamp rows that
    // consumers still bind by effective_time. A build that collapses the two maps, or that
    // reads the consumer height off the producer map, passes every inert case above and
    // fails only here.
    it('arms BTC:testnet producer-first at the sized cut, the consumer trailing by its own lead', function () {
        assert.strictEqual(mirror.MIRROR_ADMISSION_ACTIVATION['BTC:testnet'], 153222,
            'not vacuous: the sized PRODUCER height this case is about must still be in the map');
        assert.strictEqual(mirror.MIRROR_ADMISSION_CONSUMER_ACTIVATION['BTC:testnet'], 153266,
            'not vacuous: the sized CONSUMER height this case is about must still be in the map');

        // One block below the producer height the key is still wholly inert. This is the
        // boundary an off-by-one in the comparison moves, and the direction that matters:
        // arming early stamps rows under a rule the fleet has not adopted yet.
        assert.strictEqual(mirror.isMirrorAdmissionProducerActive('BTC', 'testnet', 153221), false,
            'the producer armed a block BELOW its sized height');
        assert.strictEqual(mirror.isMirrorAdmissionConsumerActive('BTC', 'testnet', 153221), false,
            'the consumer armed a block BELOW the producer height');

        // Inside the producer-only lead the producer stamps and the consumer must NOT yet
        // bind by height, or it refuses rows that no producer was required to stamp.
        for (const h of [153222, 153265]) {
            assert.strictEqual(mirror.isMirrorAdmissionProducerActive('BTC', 'testnet', h), true,
                'the producer is not armed at height ' + h + ', at or above its sized height');
            assert.strictEqual(mirror.isMirrorAdmissionConsumerActive('BTC', 'testnet', h), false,
                'the consumer armed at height ' + h + ', inside the producer-only lead');
        }

        // The consumer arms at its own height, and the <= direction is what is asserted:
        // exactly at 153266, not one block later.
        assert.strictEqual(mirror.isMirrorAdmissionConsumerActive('BTC', 'testnet', 153266), true,
            'the consumer is not armed at its own sized height');
    });
});

describe('mirror_admission_activation: the arming seam @regression', function () {
    // Number() maps null, '', whitespace, [] and the booleans onto FINITE values (0 or 1), so a
    // Number.isFinite check alone lets an unread height arm a venue at 0: a fail-OPEN on a
    // consensus flag day. NaN and undefined fail closed, which is what hides it from review.
    it('refuses to arm a venue at 0 on a height that was never read', function () {
        const armed = loadWith('armed');
        assert.strictEqual(armed.MIRROR_ADMISSION_ACTIVATION['BTC:regtest'], 0,
            'not vacuous: this only bites where the threshold is 0');
        for (const h of [null, '', '   ', [], [0], false, true, NaN, undefined, {}, 'not-a-height', '1.5']) {
            assert.strictEqual(armed.isMirrorAdmissionProducerActive('BTC', 'regtest', h), false,
                JSON.stringify(h) + ' is not a height and must never arm a flag day');
            assert.strictEqual(armed.isMirrorAdmissionConsumerActive('BTC', 'regtest', h), false,
                'the consumer predicate must refuse ' + JSON.stringify(h) + ' the same way');
        }
        // Not vacuous in the other direction: a real height still arms, in both spellings.
        assert.strictEqual(armed.isMirrorAdmissionProducerActive('BTC', 'regtest', 0), true);
        assert.strictEqual(armed.isMirrorAdmissionProducerActive('BTC', 'regtest', 1000), true);
        assert.strictEqual(armed.isMirrorAdmissionProducerActive('BTC', 'regtest', '1000'), true,
            'a digit string is a legitimate height spelling and must still arm');
    });

    // The same guard binds the other two predicates: a null tip is not tip zero, and a null
    // effective_time does not bind a row at t=0.
    it('refuses an unreadable tip and an unreadable effective_time in the other two predicates', function () {
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', 3, null), false,
            'a null tip is not tip zero: coercing it opens a three-block window');
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', 3, ''), false);
        assert.strictEqual(mirror.isRowReadableAt(null, 500, null, null), false,
            'a null effective_time is not t=0 and must not bind a row');
        // intact for real inputs
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', 103, 100), true);
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', 107, 100), false);
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('DOGE', 160, 100), true,
            'DOGE spans 60 blocks for the same 3600 s, and a flat bound is the defect this guards');
        assert.strictEqual(mirror.isRowReadableAt(null, 500, 1000, 1000), true);
        assert.strictEqual(mirror.isRowReadableAt(499, 500, 99999999999, 1000), true,
            'a modern row binds by height and ignores a future stamp entirely');
    });

    it('normalises the key so a lower-case coin or an upper-case network cannot miss the map', function () {
        const armed = loadWith('armed');
        assert.strictEqual(armed.admissionKey('btc', 'REGTEST'), 'BTC:regtest');
        assert.strictEqual(armed.admissionKey('  doge  ', ' Regtest '), 'DOGE:regtest');
        assert.strictEqual(armed.isMirrorAdmissionProducerActive('btc', 'REGTEST', 0), true,
            'a caller spelling the key differently must not silently read INERT');
    });
});

describe('mirror_admission_activation: the arming seam @regression', function () {
    it('fails the venue lever CLOSED on anything it does not recognise', function () {
        const env = k => ({ XC_MIRROR_ADMISSION_ACTIVATION: k });
        for (const armedForm of ['armed', 'ARMED', 'on', 'true', 'yes', 'genesis'])
            assert.strictEqual(mirror.resolveMirrorAdmissionRegtest(env(armedForm)), 0, armedForm);
        for (const offForm of ['off', 'inert', 'false', 'no', 'none', ''])
            assert.strictEqual(mirror.resolveMirrorAdmissionRegtest(env(offForm)), null, offForm);
        assert.strictEqual(mirror.resolveMirrorAdmissionRegtest(env('250')), 250);
        assert.strictEqual(mirror.resolveMirrorAdmissionRegtest(env('0')), 0);
        // The point of failing closed: a typo must leave the venue INERT, never stamp NaN or a
        // negative into a height comparison where `h >= NaN` is false but `h >= -1` is always true.
        for (const junk of ['-1', 'armedd', '12.5', 'yes please', '1e3'])
            assert.strictEqual(mirror.resolveMirrorAdmissionRegtest(env(junk)), null, junk);
        assert.strictEqual(mirror.resolveMirrorAdmissionRegtest({}), null);
        assert.strictEqual(mirror.resolveMirrorAdmissionRegtest(undefined), null);
    });

    // The ordering invariant the two maps exist to carry: no row is ever produced under the
    // modern rule and read under the legacy one, or the reverse.
    it('holds every PRODUCER height at or below its CONSUMER height for the same key', function () {
        const prod = mirror.MIRROR_ADMISSION_ACTIVATION;
        const cons = mirror.MIRROR_ADMISSION_CONSUMER_ACTIVATION;
        assert.deepStrictEqual(Object.keys(prod).sort(), Object.keys(cons).sort(),
            'the two maps must be keyed identically or a key is armed on one side only');
        for (const key of Object.keys(prod)) {
            const p = prod[key], c = cons[key];
            if (p === null || c === null) {
                assert.ok(!(p !== null && c === null),
                    key + ': the producer is armed while the consumer is inert; rows would be ' +
                    'stamped modern and read legacy');
                continue;
            }
            assert.ok(p <= c, key + ': producer height ' + p + ' is above consumer height ' + c);
        }
    });
});

describe('mirror_admission_activation: the follower admission window @regression', function () {
    // THE DEFECT THIS GUARDS IS A FLAT BOUND. Six blocks is an hour on BTC and six minutes on
    // DOGE, so a flat [tip+1, tip+6] refuses honest DOGE rows between hubs whose tips differ by
    // three blocks. The assertion is therefore that the two chains accept DIFFERENT windows
    // from the same tip, which a flattened map cannot satisfy however it is spelled.
    it('gives each chain its own window: a height DOGE accepts is one BTC refuses', function () {
        const TIP = 1000;
        assert.strictEqual(mirror.admitMaxFutureBlocks('BTC'), 6);
        assert.strictEqual(mirror.admitMaxFutureBlocks('DOGE'), 60);
        assert.strictEqual(mirror.admitMaxFutureBlocks('LTC'), 24);

        // The band between BTC's ceiling and DOGE's: accepted on DOGE, refused on BTC.
        for (const h of [TIP + 7, TIP + 24, TIP + 60]) {
            assert.strictEqual(mirror.isAdmitBlockInFollowerBound('DOGE', h, TIP), true,
                'DOGE must accept tip+' + (h - TIP));
            assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', h, TIP), false,
                'BTC must refuse tip+' + (h - TIP) + '; a flat bound would accept it');
        }
        // LTC sits between the two, so the map is genuinely per chain and not a BTC/DOGE pair.
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('LTC', TIP + 24, TIP), true);
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('LTC', TIP + 25, TIP), false);
    });

    it('closes both ends of the window and refuses a height at or below the tip', function () {
        const TIP = 500;
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', TIP + 1, TIP), true, 'the lower edge is inclusive');
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', TIP + 6, TIP), true, 'the upper edge is inclusive');
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', TIP, TIP), false,
            'a row admissible at a block that already exists lets a producer backdate into ' +
            'a block its peers have already committed');
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', TIP - 1, TIP), false);
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', TIP + 7, TIP), false);
    });

    it('refuses every unreadable input rather than throwing inside a verdict path', function () {
        for (const bad of [NaN, undefined, null, Infinity, 'x', {}])
            assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', bad, 100), false, String(bad));
        for (const bad of [NaN, undefined, null, Infinity, 'x'])
            assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', 101, bad), false, String(bad));
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', 101.5, 100), false, 'a fractional height is not a block');
        assert.strictEqual(mirror.isAdmitBlockInFollowerBound('BTC', -1, -5), false, 'a negative height is never admissible');
    });

    it('takes BTC\'s window for an unknown chain, matching the seconds axis', function () {
        assert.strictEqual(mirror.admitMaxFutureBlocks('XMR'), 6);
        assert.strictEqual(mirror.admitMaxFutureBlocks(null), 6);
        assert.strictEqual(mirror.admitMaxFutureBlocks('default'), 6,
            'the literal key "default" must not be addressable as a chain');
        assert.strictEqual(mirror.admitMaxFutureBlocks('btc'), 6, 'the chain code is folded up');
    });
});

describe('mirror_admission_activation: the follower admission window @regression', function () {
    it('gives each mirrored table its own margin and an unknown table the default', function () {
        assert.strictEqual(mirror.admitMarginBlocks('attestation_responses'), 1);
        assert.strictEqual(mirror.admitMarginBlocks('oracle_prices'), 1);
        assert.strictEqual(mirror.admitMarginBlocks('anchor_reward_attestations'), 144,
            'the anchor rail keeps the frozen fleet-wide ANCHOR_REWARD_MIRROR_MATURITY');
        assert.strictEqual(mirror.admitMarginBlocks('a_table_added_later'), 4);
        assert.strictEqual(mirror.admitMarginBlocks(null), 4);
        assert.strictEqual(mirror.admitMarginBlocks('default'), 4,
            'the literal key "default" must not be addressable as a table');
    });
});

describe('mirror_admission_activation: the legacy-row rule @regression', function () {

    // A row with no admission height for this chain binds by effective_time <= t(B), and it
    // does so at EVERY height. The failure this guards is the bare `admit_block_<c> <= ?` on a
    // nullable column: it evaluates to NULL for legacy rows, drops them silently, and is a
    // consensus change nothing reports.
    it('binds a legacy (null admit_block) row by effective_time at EVERY height', function () {
        const HEIGHTS = [0, 1, 144, 1000000, Number.MAX_SAFE_INTEGER];
        for (const b of HEIGHTS) {
            assert.strictEqual(mirror.isRowReadableAt(null, b, 1000, 1000), true,
                'a legacy row whose effective_time equals t(B) must bind at height ' + b);
            assert.strictEqual(mirror.isRowReadableAt(null, b, 999, 1000), true,
                'a legacy row already effective must bind at height ' + b);
            assert.strictEqual(mirror.isRowReadableAt(null, b, 1001, 1000), false,
                'a legacy row not yet effective must NOT bind at height ' + b);
            assert.strictEqual(mirror.isRowReadableAt(undefined, b, 999, 1000), true,
                'undefined is the same absence as null at height ' + b);
        }
    });

    // The same rule stated the way it actually bites: a row whose admission map simply does not
    // name this chain (a chain added to the federation after the row was signed) must fall back
    // to the clock, never be dropped.
    it('binds a row whose admission map omits THIS chain by effective_time, never drops it', function () {
        // What a caller does: look this chain up in the row's map, get undefined, pass it on.
        const row = { admit_blocks: { BTC: 900, LTC: 1800 }, effective_time: 500 };
        const admitForDoge = row.admit_blocks.DOGE;          // undefined: DOGE is not in the map
        assert.strictEqual(admitForDoge, undefined, 'not vacuous: the map must omit DOGE');
        assert.strictEqual(mirror.isRowReadableAt(admitForDoge, 10, row.effective_time, 600), true,
            'a row the producer never stamped for DOGE must still bind on DOGE by its clock');
        assert.strictEqual(mirror.isRowReadableAt(row.admit_blocks.BTC, 899, row.effective_time, 600), false,
            'and the chain the map DOES name binds by height, not by the clock');
        assert.strictEqual(mirror.isRowReadableAt(row.admit_blocks.BTC, 900, row.effective_time, 600), true);
    });

    it('binds a stamped row by height alone, ignoring the clock entirely', function () {
        // effective_time far in the future of t(B): the height is what decides, which is the
        // whole point of the axis change. A block stamped 7200 s ahead is height B like any other.
        assert.strictEqual(mirror.isRowReadableAt(100, 100, 9999999999, 0), true);
        assert.strictEqual(mirror.isRowReadableAt(100, 99, 0, 9999999999), false);
        assert.strictEqual(mirror.isRowReadableAt(0, 0, 9999999999, 0), true, 'admit_block 0 is a height, not an absence');
    });

    it('fails closed on an unreadable height or an unreadable clock', function () {
        assert.strictEqual(mirror.isRowReadableAt(null, 10, NaN, 1000), false);
        assert.strictEqual(mirror.isRowReadableAt(null, 10, 1000, NaN), false);
        assert.strictEqual(mirror.isRowReadableAt(null, 10, undefined, 1000), false);
        assert.strictEqual(mirror.isRowReadableAt(NaN, 10, 1000, 1000), false);
        assert.strictEqual(mirror.isRowReadableAt(100, NaN, 1000, 1000), false);
        assert.strictEqual(mirror.isRowReadableAt(100, undefined, 1000, 1000), false);
    });
});
