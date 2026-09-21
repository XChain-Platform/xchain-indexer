/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The indexer's binding rule and its canonical twins under the mirror-admission
 * flag day (the time-keyed mirror barrier family).
 *
 * WHAT IS DRIVEN, IN BOTH ARMS. Every predicate and every twin below is run with the
 * activation INERT (today's behaviour, byte for byte) and ARMED on regtest, at height 0
 * and at a realistic height, because the activation resolver freezes at require time
 * and a suite that only ran whichever arming the process launched with would leave one
 * whole era vacuous. Arming at 0 is what catches the `Number(null)` is 0 trap: an
 * unreadable height coerced to 0 sits ABOVE a threshold of 0 and below any realistic
 * one, so a suite armed only at 799000 certifies the null guards without testing them.
 *
 *   - The four consensus-critical canonical twins (match, call dispatch and result,
 *     bridge transfer, policy snapshot) and the attest-response canonical are compared
 *     BYTE FOR BYTE against the hub's own builders, required out of the sibling checkout
 *     and driven with a stub `this`, legacy rows and admission-era rows alike.
 *   - Both version seams keep the legacy bytes: an admission-era row with no admission
 *     columns and a legacy-era row handed admission columns.
 *   - The mirrored selects (match, two call reads in both mirror topologies, the attest
 *     response read, the bridge transfer and policy selects) issue their pre-train SQL
 *     text byte for byte below the activation and the guarded height form above it, asserted as
 *     literal strings against a capturing stub database.
 *   - The attest-response bind predicate binds by admit_block_btc above the activation
 *     and by effective_time below it, with every other clause untouched.
 *   - The direct-hub-DB call-presence member reads the hub's persisted admission floor
 *     above the activation, fails closed on every unusable reading, retires the hub-clock
 *     escape, and keeps its coin scope and its clock form below it.
 *
 * THE LAYOUT. This file holds the verify-side canonical twins. The attest-response twin,
 * the mirrored selects, the attest-response bind predicate and the call-presence member
 * each live in a part beside it under test/unit/admission_binding.test/, and the arming
 * loader, the rail fixtures, the SQL pins and the call-presence harness they share live in
 * its helpers/ directory. Every block repeats its suite and arm titles and arms itself in
 * its own before hook, so each full test title is unchanged and no case runs in an arm its
 * block did not load.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

// The arming loader and the three arms every block runs under.
const { NETWORK, ADMIT_AT, HAVE_HUB, load, ARMS } = require('./admission_binding.test/helpers/arms.js');
// One row per rail, the hand-spelled pre-train bytes, and both sides' canonical builders.
const { COLS, FIELD, NO_COLS, RAILS, indexerTwins, hubBuilders } = require('./admission_binding.test/helpers/rail_fixtures.js');

describe('admission binding: the verify-side canonical twins byte-match the hub builders', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h, twins, hub;
            before(function () { h = load(arm.activation); twins = indexerTwins(h); hub = h.hub ? hubBuilders(h) : null; });
            after(function () { if (h) h.restore(); h = null; });

            it('drives the hub builders out of the sibling checkout (PENDING here means no sibling, never a silent pass)', function () {
                if (!HAVE_HUB) { this.skip(); return; }
                assert.ok(hub !== null && typeof h.hub.Dex.prototype.canonicalMatch === 'function');
                assert.ok(typeof h.hub.Attest.prototype.buildCanonical === 'function');
            });

            it('is in the arm it says it is, so no case below is vacuous', function () {
                const armed = arm.activation !== null;
                assert.strictEqual(h.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT), armed);
                assert.strictEqual(h.act.isMirrorAdmissionProducerActive('BTC', NETWORK, 0), arm.activation === 0);
                assert.strictEqual(h.act.isMirrorAdmissionProducerActive('BTC', 'mainnet', ADMIT_AT + 1000000), false);
                if (h.hub) assert.strictEqual(h.hub.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT), armed,
                    'the hub twin must be armed identically or the parity below compares two eras');
            });

            for (const [rail, rowOf, legacyBytes] of RAILS) {

                it(rail + ': a legacy row below the activation rebuilds the pre-train bytes, equal to the hub', function () {
                    const row = (arm.legacyBlock !== null) ? rowOf(arm.legacyBlock) : rowOf(5, { network: 'mainnet' });
                    const got = twins[rail](row);
                    assert.strictEqual(got, legacyBytes(row), 'the legacy bytes must be the pre-train format exactly');
                    assert.ok(!/\|[A-Z]+:\d+(,[A-Z]+:\d+)*$/.test(got), 'no admission field on a legacy row: ' + got.slice(-40));
                    if (hub) assert.strictEqual(got, hub[rail](row));
                });
            }
        });
    }
});

describe('admission binding: the verify-side canonical twins byte-match the hub builders', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h, twins, hub;
            before(function () { h = load(arm.activation); twins = indexerTwins(h); hub = h.hub ? hubBuilders(h) : null; });
            after(function () { if (h) h.restore(); h = null; });

            for (const [rail, rowOf, legacyBytes] of RAILS) {

                if (arm.modernBlock !== null) {
                    it(rail + ': an admission-era row with columns appends the ASCII-ordered map, equal to the hub', function () {
                        const row = rowOf(arm.modernBlock, COLS);
                        const got = twins[rail](row);
                        assert.ok(got.endsWith('|' + FIELD), got.slice(-60));
                        // The field is APPENDED: strip it and the pre-train bytes are what is left.
                        const inner = got.slice(0, got.length - ('|' + FIELD).length);
                        assert.strictEqual(inner, legacyBytes(rowOf(arm.modernBlock)));
                        if (hub) {
                            assert.strictEqual(got, hub[rail](row));
                            assert.deepStrictEqual(h.hub.ah.rowAdmitBlocks(row), h.act.columnsAdmitBlocks(row),
                                'the hub and the indexer must read the same map back off the same columns');
                        }
                    });

                    it(rail + ': an admission-era row with NO columns keeps the legacy bytes at the version seam', function () {
                        const absent = rowOf(arm.modernBlock);
                        const nulls = rowOf(arm.modernBlock, NO_COLS);
                        assert.strictEqual(twins[rail](absent), legacyBytes(absent));
                        assert.strictEqual(twins[rail](nulls), legacyBytes(nulls));
                        if (hub) assert.strictEqual(hub[rail](nulls), legacyBytes(nulls));
                    });

                    it(rail + ': a different map is different bytes, and an unusable column is a refusal', function () {
                        const a = twins[rail](rowOf(arm.modernBlock, COLS));
                        const b = twins[rail](rowOf(arm.modernBlock, Object.assign({}, COLS, { admit_block_btc: 799005 })));
                        assert.notStrictEqual(a, b);
                        assert.throws(() => twins[rail](rowOf(arm.modernBlock, Object.assign({}, COLS, { admit_block_btc: 'abc' }))),
                            /not a usable admission height/);
                    });
                }

                it(rail + ': a legacy-era row handed columns keeps the legacy bytes in the other direction', function () {
                    const row = (arm.legacyBlock !== null) ? rowOf(arm.legacyBlock, COLS) : rowOf(5, Object.assign({ network: 'mainnet' }, COLS));
                    assert.strictEqual(twins[rail](row), legacyBytes(row));
                    if (hub) assert.strictEqual(hub[rail](row), legacyBytes(row));
                });
            }
        });
    }
});
