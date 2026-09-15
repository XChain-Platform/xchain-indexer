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
 * test/unit/db/db_queries.test/attestations.test.js
 *
 * Attestation and relay requests and responses, their expiry and callback
 * index, validator stats, cross-chain settlement and VM data, and the pending
 * anchor reward attestations.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb, dbWithDoQuery } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// getAttestationRequestById
// ---------------------------------------------------------------------------
describe('Database.getAttestationRequestById() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getAttestationRequestById(99), null);
    });

    it('returns row when found', async function () {
        const db = dbWithDoQuery([{ id: 1, action_index: 5 }]);
        const result = await db.getAttestationRequestById(1);
        assert.strictEqual(result.id, 1);
    });
});

// getRelayRequestById: the v3-admission-only request_id lookup
describe('Database.getRelayRequestById() @regression @tier1', function () {
    it('returns null when no ADMITTED row holds the id', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getRelayRequestById('a'.repeat(64)), null);
    });

    it('returns the admitted row when one holds the id', async function () {
        const db = dbWithDoQuery([{ action_index: 5, request_id: 'a'.repeat(64), request_status: 'pending' }]);
        const result = await db.getRelayRequestById('A'.repeat(64));
        assert.strictEqual(result.action_index, 5);
        assert.strictEqual(db.doQueryStrict.firstCall.args[1][0], 'a'.repeat(64),
            'the id is lower-cased before binding, as the wire value is caller-controlled');
    });

    it('excludes rejected rows, which is the whole point of the separate query', async function () {
        // A rejected v3 is still stored. Counting it let one malformed front-run at a
        // public request_id block the federation's real relay for that id forever, so
        // this clause is the fix, not a filter for tidiness.
        const db = dbWithDoQuery([]);
        await db.getRelayRequestById('a'.repeat(64));
        const sql = db.doQueryStrict.firstCall.args[0];
        assert.match(sql, /request_status\s*<>\s*'rejected'/,
            'a rejected audit row consumed no materialization and must not answer the guard');
        assert.match(sql, /version\s*=\s*0/,
            'only a v0 request row holds the id; a response row shares it');
        assert.match(sql, /ORDER BY\s+action_index ASC/,
            'the FIRST admission is canonical, so every node reaches the same verdict');
    });

    it('reads through doQueryStrict, because null here ADMITS the request', async function () {
        // Under doQuery a swallowed query fault returns [], which this method turns into
        // null, which the v3 guard reads as "id is free" - one faulting node then
        // materializes a BTC request every other node refused.
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'doQueryStrict').rejects(new Error('attests is not a table'));
        await assert.rejects(() => db.getRelayRequestById('a'.repeat(64)), /attests/);
        assert.strictEqual(db.doQuery.called, false, 'the lenient path must not be reachable here');
    });

    it('leaves getAttestationRequestById counting every stored row', async function () {
        // The shared lookup keeps four consensus callers (v1 response, v2 expiry, v4
        // relay response, slash round lookup) and their behaviour is deliberately
        // unchanged: they ask a different question and need to see rejected rows.
        const db = dbWithDoQuery([]);
        await db.getAttestationRequestById('a'.repeat(64));
        assert.doesNotMatch(db.doQuery.firstCall.args[0], /rejected/,
            'narrowing the shared lookup is what the ruling refused');
    });
});

// ---------------------------------------------------------------------------
// updateAttestationRequestStatus
// ---------------------------------------------------------------------------
describe('Database.updateAttestationRequestStatus() @regression @tier1', function () {
    it('calls doQuery with UPDATE', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.updateAttestationRequestStatus(1, 'fulfilled');
        assert.match(db.doQuery.firstCall.args[0], /UPDATE/i);
    });
});

// ---------------------------------------------------------------------------
// getExpiredAttestationRequests
// ---------------------------------------------------------------------------
describe('Database.getExpiredAttestationRequests() @regression @tier1', function () {
    it('returns empty array when none found', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getExpiredAttestationRequests(100);
        assert.deepStrictEqual(result, []);
    });

    it('returns rows when found', async function () {
        const db = dbWithDoQuery([{ id: 1, action_index: 5 }]);
        const result = await db.getExpiredAttestationRequests(100);
        assert.strictEqual(result.length, 1);
    });

    // Unbounded, one block could inherit an arbitrary backlog of
    // expiries (each synthesizing an ATTEST v2 and firing a callback), so block
    // processing time was attacker-selectable by batching a common deadline.
    describe('per-block cap (#3078)', function () {
        const { ATTEST_MAX_EXPIRIES_PER_BLOCK } = require('../../../../src/protocol/constants.js');

        it('bounds the sweep with LIMIT at the pinned constant by default', async function () {
            const db = dbWithDoQuery([]);
            await db.getExpiredAttestationRequests(100);
            assert.match(db.doQuery.firstCall.args[0], /LIMIT \?/,
                'the sweep must be bounded by a LIMIT, not by however many rows exist');
            assert.deepStrictEqual(db.doQuery.firstCall.args[1], [100, ATTEST_MAX_EXPIRIES_PER_BLOCK]);
        });

        it('orders by a TOTAL order so the capped prefix is identical on every node', async function () {
            const db = dbWithDoQuery([]);
            await db.getExpiredAttestationRequests(100);
            const sql = db.doQuery.firstCall.args[0];
            // deadline_block alone is not unique; action_index is. Both, in this
            // order, are what make the LIMIT deterministic rather than a fork.
            assert.match(sql, /ORDER BY\s+ar\.deadline_block ASC,\s*ar\.action_index ASC/,
                'a capped selection over a partial or planner-dependent order lets two ' +
                'nodes take different subsets and fork');
            assert.ok(sql.indexOf('ORDER BY') < sql.indexOf('LIMIT'),
                'the ORDER BY must constrain the LIMIT, not follow it');
        });

        it('is a pinned consensus constant, not a local literal', function () {
            assert.strictEqual(typeof ATTEST_MAX_EXPIRIES_PER_BLOCK, 'number');
            assert.ok(Number.isInteger(ATTEST_MAX_EXPIRIES_PER_BLOCK) && ATTEST_MAX_EXPIRIES_PER_BLOCK > 0,
                'the cap decides which block an expiry lands in, so it is consensus-visible ' +
                'and lives in protocol/constants.js with its cross-repo twins');
        });
    });
});

// ---------------------------------------------------------------------------
// setAttestationResponseCallbackIndex
// ---------------------------------------------------------------------------
describe('Database.setAttestationResponseCallbackIndex() @regression @tier1', function () {
    it('runs UPDATE query', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.setAttestationResponseCallbackIndex(10, 20);
        assert.match(db.doQuery.firstCall.args[0], /UPDATE/i);
    });
});

// ---------------------------------------------------------------------------
// createAttestationRequest: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createAttestationRequest() @regression @tier1', function () {
    function makeAttestreqDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);   // action_index existence probe
        dq.onCall(1).resolves([]);           // v0-dedup guard probe (no prior v0 for this request_id)
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeAttestreqDb([]);
        await db.createAttestationRequest({ ACTION_INDEX: 500, STATUS: 'valid', FEE_PAYER: 'addr1',
                                             REQUEST_ID: 'aabbcc', CONTRACT_INDEX: 400, PROVIDER_ID: 'http_get',
                                             CALLBACK_METHOD: 'onResult', BLOCK_INDEX: 300 });
        assert.ok(db.doQuery.args.some(a => String(a[0]).includes('INSERT INTO attests')),
            'an INSERT INTO attests was issued');
    });

    it('UPDATEs when exists', async function () {
        const db = makeAttestreqDb([{ action_index: 500 }]);
        await db.createAttestationRequest({ ACTION_INDEX: 500, STATUS: 'valid', FEE_PAYER: 'addr1',
                                             REQUEST_ID: 'aabbcc', CONTRACT_INDEX: 400, PROVIDER_ID: 'http_get',
                                             CALLBACK_METHOD: 'onResult', BLOCK_INDEX: 300 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE attests'));
    });
});

// ---------------------------------------------------------------------------
// createAttestationResponse: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createAttestationResponse() @regression @tier1', function () {
    function makeAttestrespDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeAttestrespDb([]);
        await db.createAttestationResponse({ ACTION_INDEX: 510, STATUS: 'valid',
                                              REQUEST_ID: 'aabbcc', PROVIDER_ID: 'http_get',
                                              RESPONSE_HASH: 'ddeeff', RESPONSE_STATUS: 'fulfilled', BLOCK_INDEX: 310 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO attests'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeAttestrespDb([{ action_index: 510 }]);
        await db.createAttestationResponse({ ACTION_INDEX: 510, STATUS: 'valid',
                                              REQUEST_ID: 'aabbcc', PROVIDER_ID: 'http_get',
                                              RESPONSE_HASH: 'ddeeff', RESPONSE_STATUS: 'fulfilled', BLOCK_INDEX: 310 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE attests'));
    });
});

// ---------------------------------------------------------------------------
// incrementAttestationValidatorStat: field whitelist + upsert
// ---------------------------------------------------------------------------
describe('Database.incrementAttestationValidatorStat() @regression @tier1', function () {
    it('throws on unsupported field', async function () {
        const db = makeDb();
        await assert.rejects(
            () => db.incrementAttestationValidatorStat('pk', 'pid', 'evil_column', 1),
            /unsupported field/
        );
    });

    it('silently returns for empty pubkey/pid', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.incrementAttestationValidatorStat('', 'pid', 'fulfilled_count', 1);
        assert.strictEqual(dq.callCount, 0);
    });

    it('runs upsert for fulfilled_count', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.incrementAttestationValidatorStat('aabbcc', 'http_get', 'fulfilled_count', 100);
        assert.ok(String(dq.args[0][0]).includes('fulfilled_count'));
    });
});

// ---------------------------------------------------------------------------
// Cross-chain settlement capture + VM snapshot (crossChain.isSettled backing)
// ---------------------------------------------------------------------------
describe('Database.recordCrossChainSettlement() @regression @tier1', function () {
    it('captures both leg references from the signed match', async function () {
        const db = dbWithDoQuery([]);
        const match = {
            match_id: 'm'.repeat(64),
            a_chain: 'BTC', a_action_index: '42',
            b_chain: 'LTC', b_action_index: '99'
        };
        await db.recordCrossChainSettlement(777, match, 42, 200);
        const [sql, params] = db.doQuery.firstCall.args;
        assert.ok(String(sql).includes('INSERT IGNORE INTO cross_chain_settlements'));
        assert.ok(String(sql).includes('a_chain'));
        assert.deepStrictEqual(params, [777, match.match_id, 42, 200, 'BTC', 42, 'LTC', 99]);
    });
});

describe('Database.getCrossChainDataForVM() @regression @tier1', function () {
    it('builds settled keys for BOTH legs from the LOCAL settlements table', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([
            { a_chain: 'BTC', a_action_index: 42, b_chain: 'LTC', b_action_index: 99 },
            { a_chain: 'DOGE', a_action_index: 7, b_chain: 'BTC', b_action_index: 1234 }
        ]);
        dq.onCall(1).resolves([]);                            // xcalls (getCallResult source)
        const snap = await db.getCrossChainDataForVM(200);
        assert.deepStrictEqual(snap.attestations, {});
        assert.deepStrictEqual(snap.calls, {});
        assert.deepStrictEqual(snap.settled, {
            'BTC:42': true, 'LTC:99': true,
            'DOGE:7': true, 'BTC:1234': true
        });
        // Reads the local table (consensus rule: never the mirror), strictly
        // earlier blocks only; uniform snapshot for every execution in a block.
        const [sql, params] = db.doQuery.firstCall.args;
        assert.ok(String(sql).includes('FROM cross_chain_settlements'));
        assert.ok(String(sql).includes('block_index < ?'));
        assert.deepStrictEqual(params, [200]);
    });

    it('builds call results from terminal xcalls rows (getCallResult source)', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);                            // settlements
        dq.onCall(1).resolves([
            { call_id: 'a'.repeat(64), result_status: 'ok', result_payload: '"42"' },
            { call_id: 'b'.repeat(64), result_status: 'expired', result_payload: null }
        ]);
        const snap = await db.getCrossChainDataForVM(200);
        assert.deepStrictEqual(snap.calls, {
            ['a'.repeat(64)]: { status: 'ok', payload: '"42"' },
            ['b'.repeat(64)]: { status: 'expired', payload: '' }
        });
        // Terminal rows only, visible from the block AFTER the resolving one.
        const [sql, params] = db.doQuery.secondCall.args;
        assert.ok(String(sql).includes('FROM xcalls'));
        assert.ok(String(sql).includes('resolved_block < ?'));
        assert.deepStrictEqual(params, [200]);
    });

    it('returns an empty snapshot when nothing has settled', async function () {
        const db = dbWithDoQuery([]);
        const snap = await db.getCrossChainDataForVM(200);
        assert.deepStrictEqual(snap, { attestations: {}, settled: {}, calls: {} });
    });
});

// getPendingAnchorRewardAttestations: the derive fetch gate (Option C).
// The unit tier stubs the DB, so the predicate itself is the only thing a test at this
// tier can pin - and the predicate is exactly what decides whether a late failover
// publisher ever reaches reconcileAnchorRewardWinner.
//
// SHAPE ONLY, deliberately. doQuery is stubbed here, so nothing below proves the SQL
// parses, joins a column that exists, or actually re-admits a late publisher - and
// doQuery SWALLOWS a non-transactional query error, so a broken predicate would derive
// NO anchor rewards on a live node while every assertion here stayed green. The
// semantics are driven against a real MariaDB in
// test/integration/anchor_reward_late_publisher.test.js; change one and move the other.
describe('Database.getPendingAnchorRewardAttestations() @regression @tier1', function () {
    it('excludes a round PER PUBLISHER, so a smaller-pubkey late arrival is re-admitted', async function () {
        const db = dbWithDoQuery([]);
        await db.getPendingAnchorRewardAttestations('regtest', 900);
        const sql = String(db.doQuery.firstCall.args[0]);
        // The suppression must compare the candidate publisher against the pubkey already
        // credited, not merely test the round for any credited row: a round-scoped filter
        // makes the smallest-pubkey winner rule order-dependent across nodes and replays.
        assert.match(sql, /JOIN\s+index_pubkeys\s+pk\s+ON\s+pk\.id\s*=\s*vr\.signing_pubkey_id/i);
        assert.match(sql, /pk\.pubkey\s*<=\s*LOWER\(ara\.publisher\)/i);
        assert.deepStrictEqual(db.doQuery.firstCall.args[1], ['regtest', 900]);
    });

    it('still matures only attestations at or below the current block, ordered for grouping', async function () {
        const db = dbWithDoQuery([]);
        await db.getPendingAnchorRewardAttestations('mainnet', 961000);
        const sql = String(db.doQuery.firstCall.args[0]);
        assert.match(sql, /ara\.snapshot_block\s*<=\s*\?/i);
        assert.match(sql, /ORDER BY ara\.reward_type, ara\.round_reference, ara\.publisher, ara\.snapshot_block, ara\.id/i);
    });

    // The upsert in deriveAnchorRewards is last-writer-wins on block_index and
    // validator_rewards' UNIQUE key omits snapshot_block, so whichever of two rows sharing
    // (reward_type, round_reference, publisher) is processed LAST sets the reward's earn-block.
    // ara.id is a per-node AUTO_INCREMENT, so it must never be the deciding term.
    it('decides that order on consensus data, never on the local AUTO_INCREMENT id', async function () {
        const db = dbWithDoQuery([]);
        await db.getPendingAnchorRewardAttestations('mainnet', 961000);
        const order = String(db.doQuery.firstCall.args[0]).split(/ORDER BY/i)[1];
        assert.ok(order.indexOf('ara.snapshot_block') < order.indexOf('ara.id'),
            'snapshot_block must break the tie ahead of the local mirror surrogate id');
    });
});
