'use strict';

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
 * test/unit/address-preferences-format-scope.test.js
 *
 * The preferences read is format-0-only, and this is the guard on it.
 *
 * An ADDRESS format 1 is a controller bind, not a preferences edit. It now writes an
 * `addresses` audit row like every other ADDRESS action, so a REFUSED bind can be read
 * back at all, and that row necessarily carries NULL in all three preference columns.
 * getAddressPreferences reads with `Number(row.fee_preference)`, and Number(null) is 0,
 * which is FEE_PREFERENCE=1's neighbour "destroy the fee". Without the format guard a
 * user who bound a controller to their own account would have silently switched every
 * later action's fee handling, on a consensus path.
 *
 * The guard is expressed as "not format 1" rather than "preferences not NULL", because a
 * format-0 row with a blank preference has always read back as 0 (setActionParams nulls
 * an empty field) and must keep doing so: this change is bookkeeping, and it may not move
 * a single existing verdict.
 ********************************************************************/

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');

const Utility  = require('../../src/utility.js');
const Database = require('../../src/db.js');

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'createAddress').resolves(7);
    return db;
}

describe('getAddressPreferences excludes the controller-bind format @regression', function () {

    afterEach(function () { sinon.restore(); });

    it('scopes the read away from format 1 in SQL, not in JS', async function () {
        const db = makeDb();
        const query = sinon.stub(db, 'doQuery').resolves([]);
        await db.getAddressPreferences('bcrt1qsource', 900, null);
        const sql = String(query.firstCall.args[0]).replace(/\s+/g, ' ');
        assert.ok(/action_format\s*!=\s*1/.test(sql),
            'the preferences read must exclude ADDRESS format 1: ' + sql);
        // A row predating the action_format column would otherwise be dropped by a bare
        // `!=`, since NULL != 1 is NULL and not TRUE.
        assert.ok(/action_format IS NULL OR/.test(sql),
            'a NULL action_format must still be read: ' + sql);
    });

    it('leaves the placeholders in their original order', async function () {
        const db = makeDb();
        const query = sinon.stub(db, 'doQuery').resolves([]);
        await db.getAddressPreferences('bcrt1qsource', null, 1800);
        const sql  = String(query.firstCall.args[0]).replace(/\s+/g, ' ');
        const args = query.firstCall.args[1];
        assert.deepStrictEqual(args, [7, 'valid', 1800]);
        // source_id, then status, then the bound: the guard carries no placeholder of its own.
        assert.ok(sql.indexOf('t1.source_id=?') < sql.indexOf('s1.status=?'));
        assert.ok(sql.indexOf('s1.status=?') < sql.indexOf('a1.action_index < ?'));
    });

    it('still reads a format-0 preferences row exactly as before', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([
            { fee_preference: 1, require_memo: 1, dispenser_preference: 2 }
        ]);
        const prefs = await db.getAddressPreferences('bcrt1qsource', 900, null);
        assert.strictEqual(prefs['FEE_PREFERENCE'], 1);
        assert.strictEqual(prefs['REQUIRE_MEMO'], 1);
        assert.strictEqual(prefs['DISPENSER_PREFERENCE'], 2);
    });

    it('returns the protocol defaults when an address has only ever bound a controller', async function () {
        // The v1 audit row is filtered out in SQL, so the read sees no rows at all.
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const prefs = await db.getAddressPreferences('bcrt1qsource', 900, null);
        assert.strictEqual(prefs['FEE_PREFERENCE'], 2, 'donate, NOT destroy');
        assert.strictEqual(prefs['REQUIRE_MEMO'], 0);
        assert.strictEqual(prefs['DISPENSER_PREFERENCE'], 1);
    });
});
