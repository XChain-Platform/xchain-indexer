/*
 * test/unit/reward-source-resolution.test.js
 *
 * Locks the strict active-row source resolution shared by the reward writers
 * (createValidatorReward, createNodeProofVerification) and _resolveActiveStakeSourceId.
 *
 * validator_rewards is block-scoped replicated/hashed state, so the source_id
 * stored during block processing must equal the source the ANCHOR archive pins
 * and recovery restores (resolved by stake-source.js getStakeSourceByPubkey with
 * the same predicates). A loose "latest stake by action_index" resolution diverges
 * from the archive and breaks byte-identical recovery. These tests assert the
 * writers use the strict predicates: no recording-block_index gate, slash exclusion
 * applied, params mirroring getStakeSourceByPubkey.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert   = require('assert');
const sinon    = require('sinon');
const Database = require('../../src/db');

const PUB = 'ab'.repeat(32); // 64 hex chars

// Minimal db-like object carrying only the methods under test plus stubbed
// primitives, mirroring db.test.js's makeDbLike pattern.
function makeDb({ pubkeyId = 7, validId = 1, doQuery } = {}) {
    return {
        getPubkeyId: sinon.stub().resolves(pubkeyId),
        getStatusId: sinon.stub().resolves(validId),
        doQuery:     doQuery || sinon.stub().resolves([]),
        _resolveActiveStakeSourceId: Database.prototype._resolveActiveStakeSourceId,
        createValidatorReward:       Database.prototype.createValidatorReward,
        createNodeProofVerification: Database.prototype.createNodeProofVerification,
    };
}

describe('_resolveActiveStakeSourceId() strict active-row resolution', function () {
    afterEach(function () { sinon.restore(); });

    it('stakes leg: slash exclusion applied, no recording-block_index gate', async function () {
        const doQuery = sinon.stub().resolves([{ source_id: 99 }]);
        const db = makeDb({ doQuery });
        const id = await db._resolveActiveStakeSourceId.call(db, 7, 850000);
        assert.strictEqual(id, 99);
        assert.strictEqual(doQuery.callCount, 1); // stakes leg hit, no delegation fallback
        const sql = doQuery.firstCall.args[0];
        assert.match(sql, /FROM stakes/);
        assert.match(sql, /capability_slash_events/);
        assert.doesNotMatch(sql, /s\.block_index\s*<=/);
        // params mirror getStakeSourceByPubkey's stakes leg exactly
        assert.deepStrictEqual(doQuery.firstCall.args[1], [7, 1, 850000, 850000, 1, 850000, 850000]);
    });

    it('falls back to delegations (strict, slash-excluded) when no stake matches', async function () {
        const doQuery = sinon.stub();
        doQuery.onCall(0).resolves([]);
        doQuery.onCall(1).resolves([{ source_id: 42 }]);
        const db = makeDb({ doQuery });
        const id = await db._resolveActiveStakeSourceId.call(db, 7, 900);
        assert.strictEqual(id, 42);
        const delSql = doQuery.secondCall.args[0];
        assert.match(delSql, /FROM delegations/);
        assert.match(delSql, /capability_slash_events/);
        assert.doesNotMatch(delSql, /d\.block_index\s*<=/);
        assert.deepStrictEqual(doQuery.secondCall.args[1], [7, 1, 900, 900, 900]);
    });

    it('returns null when neither stake nor delegation is active', async function () {
        const db = makeDb({ doQuery: sinon.stub().resolves([]) });
        assert.strictEqual(await db._resolveActiveStakeSourceId.call(db, 7, 900), null);
    });

    it('returns null for a null pubkey id or missing valid status', async function () {
        const db1 = makeDb();
        assert.strictEqual(await db1._resolveActiveStakeSourceId.call(db1, null, 900), null);
        const db2 = makeDb({ validId: null });
        assert.strictEqual(await db2._resolveActiveStakeSourceId.call(db2, 7, 900), null);
    });
});

describe('reward writers resolve source strictly (recovery byte-identity)', function () {
    afterEach(function () { sinon.restore(); });

    it('createValidatorReward stores the strict-resolved source and inserts', async function () {
        const doQuery = sinon.stub().callsFake(function (sql) {
            if (/FROM stakes/.test(sql))       return Promise.resolve([{ source_id: 55 }]);
            if (/validator_rewards/.test(sql)) return Promise.resolve({ affectedRows: 1 });
            return Promise.resolve([]);
        });
        const db = makeDb({ doQuery });
        const ok = await db.createValidatorReward.call(db, PUB, 12, 'anchor_btc', '10', 850000, true);
        assert.strictEqual(ok, true);
        // source resolution used the strict query (slash exclusion present)
        const resolveCall = doQuery.getCalls().find(c => /FROM stakes/.test(c.args[0]));
        assert.match(resolveCall.args[0], /capability_slash_events/);
        // the INSERT used the strict-resolved source_id (first param)
        const insertCall = doQuery.getCalls().find(c => /validator_rewards/.test(c.args[0]) && /INSERT/i.test(c.args[0]));
        assert.ok(insertCall, 'expected an INSERT into validator_rewards');
        assert.strictEqual(insertCall.args[1][0], 55);
    });

    it('createValidatorReward skips the insert when no active source resolves', async function () {
        sinon.stub(console, 'warn');
        const doQuery = sinon.stub().resolves([]); // both resolution legs empty
        const db = makeDb({ doQuery });
        const ok = await db.createValidatorReward.call(db, PUB, 12, 'anchor_btc', '10', 850000, true);
        assert.strictEqual(ok, false);
        assert.ok(!doQuery.getCalls().some(c => /INSERT/i.test(c.args[0])), 'no INSERT when source unresolved');
    });

    it('createNodeProofVerification resolves source strictly', async function () {
        const doQuery = sinon.stub().callsFake(function (sql) {
            if (/FROM stakes/.test(sql))             return Promise.resolve([{ source_id: 77 }]);
            if (/full_node_verifications/.test(sql)) return Promise.resolve({ affectedRows: 1 });
            return Promise.resolve([]);
        });
        const db = makeDb({ doQuery });
        const ok = await db.createNodeProofVerification.call(db, PUB, 'chal', 100, 120, 5, 850000);
        assert.strictEqual(ok, true);
        const resolveCall = doQuery.getCalls().find(c => /FROM stakes/.test(c.args[0]));
        assert.match(resolveCall.args[0], /capability_slash_events/);
        // full_node_verifications INSERT param order puts source_id at index 5
        const insertCall = doQuery.getCalls().find(c => /full_node_verifications/.test(c.args[0]) && /INSERT/i.test(c.args[0]));
        assert.ok(insertCall, 'expected an INSERT into full_node_verifications');
        assert.strictEqual(insertCall.args[1][5], 77);
    });
});
