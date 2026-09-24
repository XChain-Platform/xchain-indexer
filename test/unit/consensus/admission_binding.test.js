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

// The four-cell compatibility table, driven on the gate itself in every repo that carries it,
// so a copy that forked its era gate fails here by name. The reader's state is the arm the copy
// was loaded under; the map is a valid {BTC:280} on a row whose own BTC block is 275.
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, siblingsRequired } = require('../../helpers/sibling_checkout.js');

const GATE_COPIES = [
    ['xchain-indexer', path.resolve(__dirname, '../../../src/consensus/gates/mirror_admission_gate.js')],
    ['xchain-hub',      path.resolve(__dirname, '../../../../xchain-hub/src/consensus/gates/mirror_admission_gate.js')],
    ['xchain-explorer', path.resolve(__dirname, '../../../../xchain-explorer/src/consensus/gates/mirror_admission_gate.js')]
];
const MEASURED_MAP  = { BTC: 280 };
const MEASURED_ERA  = 275;
const TABLE_ARMS    = [['INERT', null], ['ARMED', 0]];

// Load one copy under one arm and hand back the copy plus its restore. Only the gate module is
// purged: every copy reads its registry rows at require time, and the registry applies the
// venue's regtest arming at the moment a row is read.
function loadGateCopy(file, activation) {
    const saved    = require.cache[file];
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    delete require.cache[file];
    if (activation === null) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    else process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(activation);
    const gate = require(file);
    return {
        gate,
        restore() {
            delete require.cache[file];
            if (saved !== undefined) require.cache[file] = saved;
            if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
        }
    };
}

describe('admission binding: the four-cell compatibility table holds on every byte-identical gate copy', function () {

    const verdicts = GATE_COPIES.map(([repo, file]) => [repo, file, siblingCheckout(__dirname, file)]);
    const missing  = verdicts.filter(([, , v]) => !v.usable);
    if (missing.length && siblingsRequired())
        throw new Error('the gate copies cannot be compared: ' + missing.map(([r, , v]) => r + ': ' + v.reason).join('; '));

    it('the copies present are byte-identical (PENDING here means a sibling is absent, never a silent pass)', function () {
        const usable = verdicts.filter(([, , v]) => v.usable);
        if (usable.length < GATE_COPIES.length) { this.skip(); return; }
        const digests = usable.map(([repo, file]) =>
            [repo, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
        for (const [repo, digest] of digests)
            assert.strictEqual(digest, digests[0][1], repo + ' copy differs from the indexer canonical copy');
    });

    for (const [repo, file, verdict] of verdicts) {
        for (const [state, activation] of TABLE_ARMS) {
            describe(repo + ' copy, reader ' + state, function () {
                let loaded;
                before(function () {
                    if (!verdict.usable) { this.skip(); return; }
                    loaded = loadGateCopy(file, activation);
                });
                after(function () { if (loaded) loaded.restore(); loaded = null; });

                it('is loaded in the arm it names, so no cell below is vacuous', function () {
                    assert.strictEqual(loaded.gate.isAdmissionEra(NETWORK, MEASURED_ERA), activation !== null);
                });

                it('map absent: no admission value, the legacy bytes', function () {
                    assert.strictEqual(loaded.gate.admissionCanonicalValue('table', NETWORK, MEASURED_ERA, null), null);
                    assert.strictEqual(loaded.gate.admissionCanonicalValue('table', NETWORK, MEASURED_ERA, undefined), null);
                    assert.strictEqual(loaded.gate.admissionCanonicalField('table', NETWORK, MEASURED_ERA, null), '');
                });

                if (activation === null) {
                    it('map present: presence alone does not select the era, so the legacy bytes, with no throw', function () {
                        assert.strictEqual(loaded.gate.admissionCanonicalValue('table', NETWORK, MEASURED_ERA, MEASURED_MAP), null);
                        assert.strictEqual(loaded.gate.admissionCanonicalField('table', NETWORK, MEASURED_ERA, MEASURED_MAP), '');
                    });
                } else {
                    it('map present: the encoded map in the declared slot', function () {
                        assert.strictEqual(loaded.gate.admissionCanonicalValue('table', NETWORK, MEASURED_ERA, MEASURED_MAP), 'BTC:280');
                        assert.strictEqual(loaded.gate.admissionCanonicalField('table', NETWORK, MEASURED_ERA, MEASURED_MAP), '|BTC:280');
                    });

                    it('a malformed map is still refused: the compatibility rule covers a valid map only', function () {
                        assert.throws(() => loaded.gate.admissionCanonicalValue('table', NETWORK, MEASURED_ERA, { BTC: '0280' }),
                            /not a canonically spelled/);
                        assert.throws(() => loaded.gate.admissionCanonicalValue('table', NETWORK, MEASURED_ERA, {}),
                            /EMPTY admission map/);
                    });
                }
            });
        }
    }
});
