/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/rollback/db_is_reorg_halted.test.js
 *
 * the decoder writes a durable REORG_HALT marker into its events table
 * when it halts on a reorg it cannot safely rewind, but the indexer only ever
 * selects code='REORG', so a halted decoder is invisible (looks idle/lagging).
 * isReorgHalted() probes for the marker on decoderDb using the same throwing read
 * contract (doQueryStrict) as getReorgsSince.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

const halt = (id, data='safe-depth halt') => ({ id, code: 'REORG_HALT', data });
const clear = (id, target, reason='audited operator clear') => ({
    id, code: 'REORG_HALT_CLEARED',
    data: JSON.stringify({ reason, ...(target === undefined ? {} : { cleared_halt_id: target }) })
});

function stubHaltRows(db, rows){
    const newest = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
    return sinon.stub(db, 'doQueryStrict').callsFake(async sql => {
        if(/LIMIT 1$/.test(sql)) return newest.slice(0, 1);
        if(/LIMIT 1001$/.test(sql)) return newest.slice(0, 1001);
        throw new Error('unexpected query: ' + sql);
    });
}

describe('db.isReorgHalted', function () {

    afterEach(() => sinon.restore());

    it('returns halted:true with the marker payload when a REORG_HALT row exists', async function () {
        const db = makeDb();
        const strict = sinon.stub(db, 'doQueryStrict').resolves([{ data: 'reorg depth 12 exceeds safe rewind' }]);
        const r = await db.isReorgHalted();
        assert.deepStrictEqual(r, { halted: true, payload: 'reorg depth 12 exceeds safe rewind' });
        assert.match(strict.firstCall.args[0], /REORG_HALT/);
    });

    it('returns halted:false, payload null when no REORG_HALT row exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([]);
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: false, payload: null });
    });

    it('selects both the halt and the cleared code, newest row first', async function () {
        const db = makeDb();
        const strict = sinon.stub(db, 'doQueryStrict').resolves([]);
        await db.isReorgHalted();
        assert.match(strict.firstCall.args[0], /REORG_HALT_CLEARED/);
        assert.match(strict.firstCall.args[0], /ORDER BY id DESC LIMIT 1/);
    });

    it('reads halted:false when the newest row is an audited REORG_HALT_CLEARED', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([{ code: 'REORG_HALT_CLEARED',
            data: JSON.stringify({ reason: 'reviewed, depth was benign', at: '2026-01-01T00:00:00Z' }) }]);
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: false, payload: null });
    });

    it('lifts the halt on a clear whose reason is exactly 8 characters after trim, or an object payload', async function () {
        const db = makeDb();
        const strict = sinon.stub(db, 'doQueryStrict').callsFake(async sql => {
            if(/LIMIT 1$/.test(sql)) return [{ id: 2, code: 'REORG_HALT_CLEARED',
                data: JSON.stringify({ reason: '  12345678  ' }) }];
            return [{ id: 2, code: 'REORG_HALT_CLEARED', data: { reason: 'reviewed by operator' } }];
        });
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: false, payload: null });
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: false, payload: null });
        assert.strictEqual(strict.callCount, 4);
    });

    it('keeps a newer halt live when a delayed clear names an older halt', async function () {
        const db = makeDb();
        stubHaltRows(db, [halt(10), clear(11, 10), halt(12, 'newer halt'), clear(13, 10)]);
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: true, payload: 'newer halt' });
    });

    it('lets a later clear lift the newer halt it names', async function () {
        const db = makeDb();
        stubHaltRows(db, [halt(10), clear(11, 10), halt(12), clear(13, 10), clear(14, 12)]);
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: false, payload: null });
    });

    it('keeps legacy clears valid but fails closed on a null target', async function () {
        const legacy = makeDb();
        const legacyStrict = stubHaltRows(legacy, [halt(10), clear(11, undefined)]);
        assert.deepStrictEqual(await legacy.isReorgHalted(), { halted: false, payload: null });
        legacyStrict.restore();
        const nullTarget = makeDb();
        stubHaltRows(nullTarget, [halt(10, 'live halt'), clear(11, null)]);
        assert.deepStrictEqual(await nullTarget.isReorgHalted(), { halted: true, payload: 'live halt' });
    });

    it('fails closed when halt history exceeds the shared scan bound', async function () {
        const db = makeDb();
        const rows = Array.from({ length: 1001 }, (_, offset) => halt(offset + 1));
        rows.push(clear(1002, 1001));
        stubHaltRows(db, rows);
        assert.deepStrictEqual(await db.isReorgHalted(), {
            halted: true, payload: 'REORG_HALT history exceeded the safe scan bound'
        });
    });

    it('propagates a history read fault after an audited clear', async function () {
        const db = makeDb();
        const strict = sinon.stub(db, 'doQueryStrict');
        strict.onFirstCall().resolves([clear(11, 10)]);
        strict.onSecondCall().rejects(new Error('decoder history read fault'));
        await assert.rejects(() => db.isReorgHalted(), /decoder history read fault/);
    });

    // Parity with xchain-decoder readReorgHaltState: an unaudited clear is a live halt there,
    // so it must be one here too, or the indexer reports synced past a halted decoder.
    const unauditedClears = [
        ['non-JSON text', 'reviewed, depth was benign'],
        ['null data', null],
        ['JSON null', 'null'],
        ['a JSON array', JSON.stringify([{ reason: 'reviewed, depth was benign' }])],
        ['an object with no reason', JSON.stringify({ at: '2026-01-01T00:00:00Z' })],
        ['a numeric reason', JSON.stringify({ reason: 123456789 })],
        ['a reason under 8 characters after trim', JSON.stringify({ reason: '   short  ' })],
    ];
    for (const [label, data] of unauditedClears) {
        it('stays halted when the newest clear row carries ' + label, async function () {
            const db = makeDb();
            sinon.stub(db, 'doQueryStrict').resolves([{ code: 'REORG_HALT_CLEARED', data: data }]);
            const r = await db.isReorgHalted();
            assert.strictEqual(r.halted, true);
            assert.strictEqual(typeof r.payload, 'string');
            assert.match(r.payload, /unaudited REORG_HALT_CLEARED/);
        });
    }

    it('reads halted:true again when a halt follows a clear (halt -> clear -> halt)', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([{ code: 'REORG_HALT', data: 'second halt, depth 40' }]);
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: true, payload: 'second halt, depth 40' });
    });

    it('fails closed when the newest row carries no readable code', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([{ code: null, data: 'unreadable marker' }]);
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: true, payload: 'unreadable marker' });
    });

    it('propagates a read fault (throwing contract, no silent "not halted")', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').rejects(new Error('decoder read fault'));
        await assert.rejects(() => db.isReorgHalted(), /decoder read fault/);
    });
});
