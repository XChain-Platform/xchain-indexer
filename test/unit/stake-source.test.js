/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/stake-source.test.js
 *
 * Unit tests for getStakeSourceByPubkey(), the stake-source resolution behind
 * the getstakesourcebypubkey RPC. Federation hubs (leader + followers) must all
 * derive the same source for an ANCHOR archive, so every input/branch is locked.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { getStakeSourceByPubkey } = require('../../src/stake-source');
const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const PUB = 'ab'.repeat(32); // 64 hex chars

function makeIndexer({ pubkeyId = 7, validId = 1, doQuery } = {}) {
    const db = {
        getPubkeyId: sinon.stub().resolves(pubkeyId),
        getStatusId: sinon.stub().resolves(validId),
        doQuery:     doQuery || sinon.stub().resolves([])
    };
    // getStakeSourceByPubkey resolves through indexer.indexerDb.apiView() ( /
    // H2 residual: a federation read must draw an independent pooled connection, never
    // join the block's open transaction). The fake view returns the same stubbed db so
    // the behaviour assertions below still observe db.doQuery / db.getPubkeyId; the
    // pooled-isolation guarantee itself is exercised by the real-Database test below.
    db.apiView = () => db;
    return { indexer: { indexerDb: db }, db };
}

describe('getStakeSourceByPubkey()', function () {

    afterEach(function () { sinon.restore(); });

    it('rejects a missing pubkey', async function () {
        const { indexer } = makeIndexer();
        const r = await getStakeSourceByPubkey(indexer, { block_index: 100 });
        assert.deepStrictEqual(r, { error: 'pubkey must be 64 hex chars' });
    });

    it('rejects a non-64-hex pubkey', async function () {
        const { indexer } = makeIndexer();
        const r = await getStakeSourceByPubkey(indexer, { pubkey: 'xyz', block_index: 100 });
        assert.deepStrictEqual(r, { error: 'pubkey must be 64 hex chars' });
    });

    it('rejects a missing / non-numeric block_index', async function () {
        const { indexer } = makeIndexer();
        assert.deepStrictEqual(await getStakeSourceByPubkey(indexer, { pubkey: PUB }),
            { error: 'block_index is required' });
        assert.deepStrictEqual(await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 'soon' }),
            { error: 'block_index is required' });
    });

    it('rejects a negative block_index', async function () {
        const { indexer } = makeIndexer();
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: -1 });
        assert.deepStrictEqual(r, { error: 'block_index is required' });
    });

    it('accepts block_index 0 (genesis is a valid height)', async function () {
        const { indexer, db } = makeIndexer({ doQuery: sinon.stub().resolves([{ source: 'addrA' }]) });
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 0 });
        assert.deepStrictEqual(r, { source: 'addrA' });
        assert.strictEqual(db.doQuery.callCount, 1);
    });

    it('reports when the indexer database is not ready', async function () {
        const r = await getStakeSourceByPubkey({ indexerDb: null }, { pubkey: PUB, block_index: 100 });
        assert.deepStrictEqual(r, { error: 'indexer database not ready' });
    });

    it('returns {source:null} for an unknown pubkey (no id)', async function () {
        const { indexer, db } = makeIndexer({ pubkeyId: null });
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 100 });
        assert.deepStrictEqual(r, { source: null });
        assert.strictEqual(db.doQuery.callCount, 0); // short-circuits before any query
    });

    it('returns {source:null} when the valid status id is missing', async function () {
        const { indexer, db } = makeIndexer({ validId: null });
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 100 });
        assert.deepStrictEqual(r, { source: null });
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('resolves a stake source without consulting delegations', async function () {
        const doQuery = sinon.stub().resolves([{ source: 'stakeAddr' }]);
        const { indexer, db } = makeIndexer({ doQuery });
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 850000 });
        assert.deepStrictEqual(r, { source: 'stakeAddr' });
        assert.strictEqual(db.doQuery.callCount, 1); // only the stakes leg ran
        // pubkey is lowercased before id resolution
        assert.strictEqual(db.getPubkeyId.firstCall.args[0], PUB.toLowerCase());
        // stakes-leg params mirror membership: [pubkey_id, valid_id, activation, deactivation, revoke_status, revoke_deactivation, slash]
        const sql  = db.doQuery.firstCall.args[0];
        const args = db.doQuery.firstCall.args[1];
        assert.deepStrictEqual(args, [7, 1, 850000, 850000, 1, 850000, 850000]);
        assert.match(sql, /FROM stakes/);
        // Must NOT gate on the recording block_index (membership does not), and must
        // apply the permanent-slash exclusion. A stricter resolver strands a counted
        // key as source-unresolved, deferring its anchor reward and blocking publish.
        assert.doesNotMatch(sql, /s\.block_index\s*<=/);
        assert.match(sql, /capability_slash_events/);
    });

    it('falls back to delegations when no stake row matches', async function () {
        const doQuery = sinon.stub();
        doQuery.onCall(0).resolves([]);                       // stakes leg: empty
        doQuery.onCall(1).resolves([{ source: 'delAddr' }]);  // delegations leg: hit
        const { indexer, db } = makeIndexer({ doQuery });
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 900 });
        assert.deepStrictEqual(r, { source: 'delAddr' });
        assert.strictEqual(db.doQuery.callCount, 2);
        const delSql = db.doQuery.secondCall.args[0];
        assert.match(delSql, /FROM delegations/);
        // delegations-leg params mirror membership: [pubkey_id, valid_id, activation, deactivation, slash]
        assert.deepStrictEqual(db.doQuery.secondCall.args[1], [7, 1, 900, 900, 900]);
        // Same invariant as the stakes leg: no recording-block_index gate, slash applied.
        // This is the exact bug that stranded delegated keys as source-unresolved.
        assert.doesNotMatch(delSql, /d\.block_index\s*<=/);
        assert.match(delSql, /capability_slash_events/);
    });

    it('returns {source:null} when neither stake nor delegation matches', async function () {
        const doQuery = sinon.stub().resolves([]); // both legs empty
        const { indexer, db } = makeIndexer({ doQuery });
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 900 });
        assert.deepStrictEqual(r, { source: null });
        assert.strictEqual(db.doQuery.callCount, 2);
    });

    it('catches a query failure and reports a generic error', async function () {
        sinon.stub(console, 'error'); // keep the expected error log out of test output
        const doQuery = sinon.stub().rejects(new Error('db down'));
        const { indexer } = makeIndexer({ doQuery });
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 100 });
        assert.deepStrictEqual(r, { error: 'failed to resolve stake source' });
    });

    //  / H2 residual: a federation read landing mid-block must resolve on an
    // independent pooled connection and NEVER on the block's open transaction
    // connection. Drives getStakeSourceByPubkey against a real Database whose
    // transactionConnection is set (simulating mid-block) and asserts every query
    // ran on the pooled connection, matching the write-path apiView guarantee.
    describe('routes off the open block transaction (real Database) @regression @tier1', function () {
        function makeRealDb() {
            const util = new Utility();
            sinon.stub(util, 'logError'); // keep query-error logs out of test output
            const indexer = { config: getTestConfig(), util };
            const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
            db.pool = { getConnection: sinon.stub() };
            return db;
        }

        it('resolves a stake source without touching the transaction connection', async function () {
            const db = makeRealDb();
            // Simulate a block being processed: getConnection() would hand back this
            // connection to any doQuery routed through the block path.
            const txConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
            db.transactionConnection = txConn;
            // The pooled connection answers the whole helper chain: pubkey id, status
            // id, then the stakes-leg source lookup.
            const poolConn = {
                query: sinon.stub().callsFake(async (sql) => {
                    if (/FROM index_pubkeys/i.test(sql))  return [{ id: 11 }];
                    if (/FROM index_statuses/i.test(sql)) return [{ id: 1 }];
                    if (/FROM stakes/i.test(sql))         return [{ source: 'stakeAddr' }];
                    return [];
                }),
                release: sinon.stub().resolves()
            };
            db.pool.getConnection.resolves(poolConn);

            const r = await getStakeSourceByPubkey({ indexerDb: db }, { pubkey: PUB, block_index: 850000 });
            assert.deepStrictEqual(r, { source: 'stakeAddr' });
            assert.ok(txConn.query.notCalled, 'no federation-read query may join the open block transaction');
            assert.ok(poolConn.query.called, 'reads must run on the pooled connection');
            // Every pooled connection this handler drew was released (pubkey id +
            // status id + stakes leg), so it never leaks the block loop a connection.
            assert.ok(poolConn.release.callCount >= 3, 'each pooled connection is released');
        });
    });
});
