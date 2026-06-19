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
 * test/unit/db.unstake-reunstake-double-credit.test.js
 *
 * ECONOMIC REGRESSION GUARD for the re-UNSTAKE double-credit (item 4617).
 *
 * After an UNSTAKE, the stake row keeps deactivation_block set to a FUTURE block
 * (BLOCK + activation delay). During that window getActiveStakeByPubkey's default
 * filter ((deactivation_block IS NULL OR deactivation_block > blockIndex)) still
 * returns the row as active, so a second UNSTAKE re-read the same tokens and wrote
 * a duplicate cooldown credit, double-crediting the staker at maturity.
 *
 * Fix: the UNSTAKE path calls getActiveStakeByPubkey(pubkey, blockIndex,
 * {undeactivatedOnly:true}), which sums only deactivation_block IS NULL rows, so a
 * second UNSTAKE finds nothing to unstake and is rejected. Other callers
 * (stake/delegate) keep the default window semantics.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

afterEach(function () { sinon.restore(); });

describe('getActiveStakeByPubkey undeactivatedOnly excludes deactivating rows @regression @tier1', function () {

    function stubAggregate(db) {
        sinon.stub(db, 'getPubkeyId').resolves(10);
        sinon.stub(db, 'getStatusId').resolves(1);
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => { captured = { sql, args }; return []; });
        return () => captured;
    }

    it('undeactivatedOnly: filters deactivation_block IS NULL and drops the future-block window clause', async function () {
        const db = makeDb();
        const get = stubAggregate(db);

        await db.getActiveStakeByPubkey('pk', 300, { undeactivatedOnly: true });

        const cap = get();
        assert.ok(cap, 'SELECT ran');
        assert.ok(/deactivation_block IS NULL/i.test(cap.sql), 'must require not-yet-unstaked rows');
        assert.ok(!/deactivation_block\s*>\s*\?/.test(cap.sql),
            'must NOT include the future-block window (which kept a deactivating stake "active")');
        // only one blockIndex bound for the activation filter (no second bound for the window)
        assert.strictEqual(cap.args.filter(a => a === 300).length, 1, 'single activation-window bound');
    });

    it('default (no opts): keeps the activation-window clause for stake/delegate callers', async function () {
        const db = makeDb();
        const get = stubAggregate(db);

        await db.getActiveStakeByPubkey('pk', 300);

        const cap = get();
        assert.ok(cap, 'SELECT ran');
        assert.ok(/deactivation_block IS NULL OR\s+s\.deactivation_block\s*>\s*\?/i.test(cap.sql),
            'default keeps the (IS NULL OR > blockIndex) window');
    });
});
