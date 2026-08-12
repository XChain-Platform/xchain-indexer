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
 * test/unit/db.close.test.js
 *
 * every bin/ harness ends with `if(db.close) await db.close()` and there
 * was no such method, so the guard silently did nothing, the pool's idle sockets
 * kept the event loop alive, and each tool hung after printing its results. The
 * damage was not the hang itself but what it did to the numbers: a benchmark run
 * that took twelve seconds read as ten minutes.
 *
 * The first assertion is therefore that the method EXISTS, because the bug was an
 * optional-call guard finding nothing. The rest pin the two ways an exit path can
 * still fail to exit: a held transaction connection, and a pool that refuses to
 * end.
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
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
}

describe('db.close (the bin/ harnesses could not exit)', function () {

    afterEach(() => sinon.restore());

    it('exists, so that `if(db.close)` in every harness is not a silent no-op', function () {
        assert.strictEqual(typeof Database.prototype.close, 'function');
    });

    it('ends the pool and drops it, so no idle socket holds the event loop open', async function () {
        const db  = makeDb();
        const end = sinon.stub().resolves();
        db.pool   = { end };
        await db.close();
        assert.strictEqual(end.callCount, 1);
        assert.strictEqual(db.pool, null);
    });

    it('releases a held transaction connection before ending the pool', async function () {
        const db      = makeDb();
        const release = sinon.stub().resolves();
        const end     = sinon.stub().resolves();
        db.transactionConnection = { release };
        db.pool = { end };
        await db.close();
        assert.strictEqual(release.callCount, 1);
        assert.strictEqual(db.transactionConnection, null);
        assert.ok(release.calledBefore(end), 'the transaction connection must go back before the pool ends');
    });

    it('does not throw when the pool refuses to end, because a tool must still exit', async function () {
        const db = makeDb();
        db.pool  = { end: sinon.stub().rejects(new Error('pool already closed')) };
        await db.close();
        assert.strictEqual(db.pool, null);
    });

    it('is idempotent, so a finally block that runs twice cannot fail the run', async function () {
        const db  = makeDb();
        const end = sinon.stub().resolves();
        db.pool   = { end };
        await db.close();
        await db.close();
        assert.strictEqual(end.callCount, 1);
    });
});
