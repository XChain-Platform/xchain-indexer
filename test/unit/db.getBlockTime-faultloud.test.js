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
 * test/unit/db.getBlockTime-faultloud.test.js
 *
 * CONSENSUS REGRESSION GUARD for getBlockTime() fault handling (finding #898).
 *
 * getBlockTime() feeds ProtocolChanges.isEnabled() on the consensus path. It used to run
 * through doQuery, which collapses ANY decoder-DB fault to [] - indistinguishable from
 * "no such block" - and returned the `false` sentinel. `false` coerces to 0 in isEnabled's
 * `change.mainnet_time > current.block_time` compare, silently marking every armed time-gated
 * protocol change INACTIVE on the faulting node only: a unilateral contract_hash fork, with
 * the fail-loud catch at protocol_changes.js:583 never firing because nothing threw.
 *
 * The fix routes the read through doQueryStrict and rethrows infrastructure faults
 * (rethrowIfInfraFault: any errno other than the benign missing-table/column 1146/1054),
 * while preserving the `false` sentinel for a genuinely-missing block and NEVER memoizing a
 * failed lookup. These tests pin all four behaviours.
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
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

function faultWith(errno) {
    const e = new Error('injected db fault');
    e.errno = errno;
    return e;
}

describe('getBlockTime() fail-loud fault handling (#898)', function () {

    afterEach(() => sinon.restore());

    it('returns the block_time for an existing block', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([{ block_time: 1700000000 }]);
        assert.strictEqual(await db.getBlockTime(500), 1700000000);
    });

    it('returns the false sentinel for a genuinely-missing block (empty result)', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([]);
        assert.strictEqual(await db.getBlockTime(999999), false);
    });

    it('RETHROWS an infrastructure fault (lock-wait timeout 1205) instead of returning false', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').rejects(faultWith(1205));
        await assert.rejects(() => db.getBlockTime(500), /injected db fault/);
    });

    it('does NOT memoize a failed lookup: a later healthy query re-reads and succeeds', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQueryStrict');
        stub.onFirstCall().rejects(faultWith(1205));
        stub.onSecondCall().resolves([{ block_time: 1700000042 }]);

        await assert.rejects(() => db.getBlockTime(500), /injected db fault/);
        // Same block_index: if the fault had been cached, this would return the stale value
        // without a second query. It must re-query and return the real time.
        assert.strictEqual(await db.getBlockTime(500), 1700000042);
        assert.strictEqual(stub.callCount, 2);
    });

    it('absorbs a benign missing-table fault (1146) as false and does not cache it', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQueryStrict');
        stub.onFirstCall().rejects(faultWith(1146));
        stub.onSecondCall().resolves([{ block_time: 1700000100 }]);

        assert.strictEqual(await db.getBlockTime(500), false);
        // Not cached: the retry re-queries rather than serving the false sentinel.
        assert.strictEqual(await db.getBlockTime(500), 1700000100);
        assert.strictEqual(stub.callCount, 2);
    });

    it('memoizes a successful lookup (no second query for the same block_index)', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQueryStrict').resolves([{ block_time: 1700000200 }]);
        assert.strictEqual(await db.getBlockTime(777), 1700000200);
        assert.strictEqual(await db.getBlockTime(777), 1700000200);
        assert.strictEqual(stub.callCount, 1);
    });
});
