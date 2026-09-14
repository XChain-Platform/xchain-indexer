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
 * The direct-hub-DB call-presence member (XChainIndexer.waitForDirectCallPresence) under
 * the mirror-admission flag day: above the activation it reads the hub's persisted
 * admission floor, fails closed on every unusable reading and retires the hub-clock
 * escape; below it, it keeps its coin scope and its clock form.
 * Part of the suite whose entry is test/unit/admission_binding.test.js.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { NETWORK, ADMIT_AT, LEGACY_AT, load, ARMS } = require('./helpers/arms.js');
const { GRACE, NOW_S, FLOOR_SQL, COVERAGE_SQL, ctx, run, clearsAt, floorRow, floorTargets } = require('./helpers/call_presence.js');

describe('admission binding: the direct-hub-DB call-presence member', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            const legacyHeights = arm.activation === null ? [0, LEGACY_AT, ADMIT_AT] : (arm.legacyBlock !== null ? [arm.legacyBlock] : []);
            for (const B of legacyHeights) {
                it('below the activation at B=' + B + ' the coverage read is the clock form, scoped to this coin', async function () {
                    const bt = NOW_S() + 3600;
                    const self = ctx(h, { rows: [{ ts: bt, hub_now: NOW_S() }] });
                    await run(h, self, bt, B);
                    assert.strictEqual(self.captured.length, 1);
                    assert.strictEqual(self.captured[0].sql, COVERAGE_SQL);
                    assert.deepStrictEqual(self.captured[0].args, ['BTC', 'BTC']);
                });

                it('below the activation at B=' + B + ' the hub-clock escape still opens and the verdict is the clock instant', async function () {
                    const bt = NOW_S() - 500;
                    const self = ctx(h, { rows: [{ ts: bt - 100, hub_now: bt + GRACE }] });
                    await run(h, self, bt, B);
                    assert.strictEqual(self.captured.length, 1, 'the escape opens on the first poll');
                    assert.strictEqual(clearsAt(h, ctx(h, {}), bt, B), (bt + GRACE) * 1000);
                });

                it('below the activation at B=' + B + ' the floor is never read', async function () {
                    const bt = NOW_S() + 3600;
                    const self = ctx(h, { rows: [{ ts: bt - 1, hub_now: NOW_S() }] });
                    await assert.rejects(() => run(h, self, bt, B), /direct call-presence barrier timed out after 40ms waiting for block_time/);
                    for (const c of self.captured) assert.ok(!/configs/.test(c.sql));
                });
            }

            it('the one-argument shape stays inert and never touches config (the pre-train harness)', async function () {
                const bt = NOW_S() + 3600;
                const self = ctx(h, { rows: [{ ts: bt, hub_now: NOW_S() }], noConfig: true });
                delete self.mirrorAdmissionActiveAt;
                await run(h, self, bt);
                assert.strictEqual(self.captured[0].sql, COVERAGE_SQL.replace(" AND (target_chain = ? OR source_chain = ?)", ''),
                    'no coin configured: the unscoped superset');
                assert.deepStrictEqual(self.captured[0].args, []);
                assert.strictEqual(clearsAt(h, self, bt), (bt + GRACE) * 1000);
                assert.strictEqual(clearsAt(h, self, bt, undefined), (bt + GRACE) * 1000);
                assert.strictEqual(clearsAt(h, self, bt, null), (bt + GRACE) * 1000);
            });
        });
    }
});

describe('admission binding: the direct-hub-DB call-presence member', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;
                const { covering, short } = floorTargets(B);

                it('above the activation at B=' + B + ' coverage is the persisted floor at or above B - margin, read from configs', async function () {
                    const bt = NOW_S() + 7200;                        // a far-future stamp holds nothing here
                    const self = ctx(h, { rows: floorRow(covering) });
                    await run(h, self, bt, B);
                    assert.strictEqual(self.captured.length, 1);
                    assert.strictEqual(self.captured[0].sql, FLOOR_SQL);
                    assert.deepStrictEqual(self.captured[0].args, ['xchain', NETWORK, 'admission_watermark', 'cross_chain_calls.BTC']);
                    // One more than needed also covers; one short does not.
                    await run(h, ctx(h, { rows: floorRow(String(Number(covering) + 1)) }), bt, B);
                    if (short !== null)
                        await assert.rejects(() => run(h, ctx(h, { rows: floorRow(short) }), bt, B),
                            /timed out after 40ms waiting for block_time/);
                });

                it('above the activation the hub-clock escape is retired and t(B) is never read', async function () {
                    const bt = NOW_S() - 100000;                      // a stamp far in the past would open every clock escape
                    const self = ctx(h, { rows: short !== null ? floorRow(short) : [] });
                    await assert.rejects(() => run(h, self, bt, B), /timed out/);
                    for (const c of self.captured) {
                        assert.strictEqual(c.sql, FLOOR_SQL);
                        assert.ok(!/UNIX_TIMESTAMP|effective_time/.test(c.sql));
                    }
                    assert.strictEqual(clearsAt(h, ctx(h, {}), bt, B), null, 'no clock instant opens a height-keyed barrier (C8)');
                });

                it('above the activation an absent row, a non-digit value, a null value and a query error all read as NOT covered', async function () {
                    const bt = NOW_S();
                    for (const rows of [[], floorRow(null), floorRow(undefined), floorRow('abc'), floorRow('0' + covering), floorRow(' '), floorRow('-1'), floorRow('1e21')]) {
                        await assert.rejects(() => run(h, ctx(h, { rows }), bt, B), /timed out/, 'covered on ' + JSON.stringify(rows));
                    }
                    await assert.rejects(() => run(h, ctx(h, { fail: 'table missing' }), bt, B), /timed out[\s\S]*\[last query error: table missing\]/);
                });
            }
        });
    }
});

describe('admission binding: the direct-hub-DB call-presence member', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;
                const { target, covering } = floorTargets(B);

                if (B === 0) {
                    it('armed at 0, a null floor at a negative target is still NOT covered (Number(null) is 0, and 0 >= -4)', async function () {
                        assert.ok(target < 0, 'the target below genesis is what makes this case bite');
                        await assert.rejects(() => run(h, ctx(h, { rows: floorRow(null) }), NOW_S(), B), /timed out/);
                        await assert.rejects(() => run(h, ctx(h, { rows: [] }), NOW_S(), B), /timed out/);
                        // While a real floor of 0 does cover a negative target.
                        await run(h, ctx(h, { rows: floorRow('0') }), NOW_S(), B);
                    });
                }

                it('above the activation the timeout keeps its byte-identical prefix and appends the height form', async function () {
                    const bt = NOW_S();
                    let msg = '';
                    const prefix = 'direct call-presence barrier timed out after 40ms waiting for block_time ' + bt +
                                   ' (call mirror at null, hub clock at null, escape at ' + (bt + GRACE) + ')';
                    if (target >= 3) {
                        try { await run(h, ctx(h, { rows: floorRow(String(target - 3)) }), bt, B); } catch (e) { msg = e.message; }
                        assert.ok(msg.startsWith(prefix), msg);
                        assert.strictEqual(msg.slice(prefix.length), ' (admission height cross_chain_calls.BTC at ' + (target - 3) + ', needs ' + target + ')');
                    }
                    try { await run(h, ctx(h, { rows: [] }), bt, B); } catch (e) { msg = e.message; }
                    assert.ok(msg.startsWith(prefix), msg);
                    assert.strictEqual(msg.slice(prefix.length), ' (admission height cross_chain_calls.BTC at none, needs ' + target + ')');
                });

                it('above the activation the floor is read for THIS coin', async function () {
                    const self = ctx(h, { coin: 'DOGE', rows: floorRow(covering) });
                    await run(h, self, NOW_S(), B);
                    assert.deepStrictEqual(self.captured[0].args, ['xchain', NETWORK, 'admission_watermark', 'cross_chain_calls.DOGE']);
                });

                it('above the activation a string height is a height, so the caller cannot pass one and read inert', async function () {
                    const self = ctx(h, { rows: floorRow(covering) });
                    await run(h, self, NOW_S(), String(B));
                    assert.strictEqual(self.captured[0].sql, FLOOR_SQL);
                });
            }
        });
    }
});
