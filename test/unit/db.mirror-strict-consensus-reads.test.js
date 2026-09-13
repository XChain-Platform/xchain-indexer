/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.mirror-strict-consensus-reads.test.js
 *
 * The hub-mirrored reads are consensus INPUTS and must fail loudly.
 *
 * Database.doQuery catches a driver error and returns [] whenever the instance
 * holds no transaction connection. Every read routed through _mirrorDb() runs on
 * the hub-DB instance, which XChainIndexer builds read-only and which therefore
 * never opens a transaction, so a transient fault comes back as "no rows" and is
 * indistinguishable from a genuinely empty mirror. One node then omits the XEXEC,
 * CROSS_SETTLE and callback actions its peers inject, or resolves a smaller
 * capability set, and the actions/contract/ledger hashes diverge.
 *
 * The negative control is the point of the file: swapping doQueryStrict back to
 * doQuery in any ONE of these methods turns exactly that method's case red,
 * because each case faults the whole connection and asserts a rejection.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// A Database on a NON-transactional instance (the hub mirror's shape) whose every
// query rejects the way a lock wait timeout does, and which counts releases.
function faultingDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    assert.strictEqual(db.transactionConnection, null,
        'the mirror instance holds no transaction, which is what makes the swallow reachable');
    const fault = Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'),
        { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT', sqlState: 'HY000' });
    const released = { count: 0 };
    sinon.stub(db, 'getConnection').resolves({
        query:   () => Promise.reject(fault),
        release: () => { released.count++; return Promise.resolve(); }
    });
    db._released = released;
    return db;
}

async function rejects(fn) {
    try { await fn(); }
    catch (err) { return err; }
    return null;
}

afterEach(function () { sinon.restore(); });

describe('hub-mirrored consensus reads fail loudly on a DB fault @regression @tier1', function () {

    // One case per converted read. Each names the empty value the swallow produced,
    // which is the value the fleet would disagree with this node about.
    const READS = [
        ['getEffectiveUnsettledMatches',    db => db.getEffectiveUnsettledMatches('BTC', 1700000000, 25)],
        ['getEffectiveUndispatchedCalls',   db => db.getEffectiveUndispatchedCalls('BTC', 'regtest', 1700000000, 25)],
        ['getEffectiveUnprocessedCallResults', db => db.getEffectiveUnprocessedCallResults('BTC', 'regtest', 1700000000, 25)],
        ['getCapabilitySnapshotWeights',    db => db.getCapabilitySnapshotWeights('cross_chain', 961000)],
        ['getCapabilitySnapshotValidators', db => db.getCapabilitySnapshotValidators('cross_chain', 961000)],
        ['getCapabilitySnapshotCount',      db => db.getCapabilitySnapshotCount('cross_chain', 961000)],
        ['isPubkeyInCapabilitySnapshot',    db => db.isPubkeyInCapabilitySnapshot('aa'.repeat(32), 'cross_chain', 961000)],
        ['getMirroredAttestationResponses', db => db.getMirroredAttestationResponses('regtest', ['ab'.repeat(16)], 1700000000)]
    ];

    for (const [name, call] of READS) {
        it(`${name} rejects rather than resolving an empty consensus input`, async function () {
            const db  = faultingDb();
            const err = await rejects(() => call(db));
            assert.ok(err, name + ' must not resolve at all on a query fault');
            assert.strictEqual(err.errno, 1205,
                'and it must surface the driver error, not a substitute');
            assert.ok(db._released.count > 0, 'the connection is still released on the error path');
        });
    }

    it('getMirroredAttestationResponses still short-circuits an empty id list without a query', async function () {
        // The guard above the read returns before any connection is taken, so the
        // strict conversion must not turn an empty request into a rejection.
        const db = faultingDb();
        assert.deepStrictEqual(await db.getMirroredAttestationResponses('regtest', [], 1700000000), []);
        assert.strictEqual(db._released.count, 0, 'no connection is taken for an empty id list');
    });
});
