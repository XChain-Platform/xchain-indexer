/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/stake-source.test.js
 *
 * Unit tests for getStakeSourceByPubkey() — the stake-source resolution behind
 * the getstakesourcebypubkey RPC. Federation hubs (leader + followers) must all
 * derive the same source for an ANCHOR archive, so every input/branch is locked.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { getStakeSourceByPubkey } = require('../../src/stake-source');

const PUB = 'ab'.repeat(32); // 64 hex chars

// Build a fake indexer whose indexerDb stubs return queued values.
function makeIndexer({ pubkeyId = 7, validId = 1, doQuery } = {}) {
    const db = {
        getPubkeyId: sinon.stub().resolves(pubkeyId),
        getStatusId: sinon.stub().resolves(validId),
        doQuery:     doQuery || sinon.stub().resolves([])
    };
    return { indexer: { indexerDb: db }, db };
}

describe('getStakeSourceByPubkey()', function () {

    afterEach(function () { sinon.restore(); });

    // --- input validation -------------------------------------------------

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

    // --- resolution branches ---------------------------------------------

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
        // stakes-leg params: [pubkey_id, valid_id, blockIdx, blockIdx, blockIdx, valid_id, blockIdx]
        const args = db.doQuery.firstCall.args[1];
        assert.deepStrictEqual(args, [7, 1, 850000, 850000, 850000, 1, 850000]);
        assert.match(db.doQuery.firstCall.args[0], /FROM stakes/);
    });

    it('falls back to delegations when no stake row matches', async function () {
        const doQuery = sinon.stub();
        doQuery.onCall(0).resolves([]);                       // stakes leg: empty
        doQuery.onCall(1).resolves([{ source: 'delAddr' }]);  // delegations leg: hit
        const { indexer, db } = makeIndexer({ doQuery });
        const r = await getStakeSourceByPubkey(indexer, { pubkey: PUB, block_index: 900 });
        assert.deepStrictEqual(r, { source: 'delAddr' });
        assert.strictEqual(db.doQuery.callCount, 2);
        assert.match(db.doQuery.secondCall.args[0], /FROM delegations/);
        // delegations-leg params: [pubkey_id, valid_id, blockIdx, blockIdx, blockIdx]
        assert.deepStrictEqual(db.doQuery.secondCall.args[1], [7, 1, 900, 900, 900]);
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
});
