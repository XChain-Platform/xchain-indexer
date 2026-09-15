// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

function registerCrossChainUpgradeGroup1(CC_COLS, makeApplySync, callRow, updateClause) { it('lifts push_generation with GREATEST, so a stale finalized row can never lower the fence', async function () {
        const { sync, doQuery } = makeApplySync(CC_COLS);
        await sync.applyRow('cross_chain_calls', callRow(7));
        const clause = updateClause(doQuery);
        assert.ok(/`push_generation` = GREATEST\(COALESCE\(`push_generation`, 0\), COALESCE\(VALUES\(`push_generation`\), 0\)\)/.test(clause),
            'the reorg fence must be monotonic: ' + clause);
    }); }

function registerCrossChainUpgradeGroup2(CC_COLS, makeApplySync, callRow, updateClause) { it('never assigns push_generation through the status gate', async function () {
        const { sync, doQuery } = makeApplySync(CC_COLS);
        await sync.applyRow('cross_chain_calls', callRow(7));
        const clause = updateClause(doQuery);
        assert.ok(!/`push_generation` = IF\(VALUES\(status\)/.test(clause),
            'a status-gated assignment takes the fence wherever the incoming row points it');
    }); }

function registerCrossChainUpgradeGroup3(CC_COLS, makeApplySync, callRow, updateClause) { it('still upgrades content only when the INCOMING row is finalized, and never the unique key', async function () {
        const { sync, doQuery } = makeApplySync(CC_COLS);
        await sync.applyRow('cross_chain_calls', callRow(7));
        const clause = updateClause(doQuery);
        assert.ok(/`effective_time` = IF\(VALUES\(status\) = 'finalized'.*?, VALUES\(`effective_time`\), `effective_time`\)/.test(clause), clause);
        assert.ok(/status = IF\(VALUES\(status\) = 'finalized'.*?, 'finalized', status\)/.test(clause), clause);
        assert.ok(!/`call_id` =/.test(clause));
        assert.ok(!/`phase` =/.test(clause));
        assert.ok(!/`id` =/.test(clause));
    }); }

function registerCrossChainUpgradeGroup4(CC_COLS, makeApplySync, callRow, updateClause) { it('gates content on the incoming generation too, so a stale finalized page cannot overwrite newer terms', async function () {
        const { sync, doQuery } = makeApplySync(CC_COLS);
        await sync.applyRow('cross_chain_calls', callRow(7));
        const clause = updateClause(doQuery);
        const gate = "VALUES\\(status\\) = 'finalized' AND COALESCE\\(VALUES\\(`push_generation`\\), 0\\) >= COALESCE\\(`push_generation`, 0\\)";
        for (const col of ['effective_time', 'validator_signatures', 'snapshot_block', 'target_chain']) {
            assert.ok(new RegExp('`' + col + '` = IF\\(' + gate + ', VALUES\\(`' + col + '`\\), `' + col + '`\\)').test(clause),
                col + ' must be generation-gated: ' + clause);
        }
        assert.ok(new RegExp('status = IF\\(' + gate + ", 'finalized', status\\)").test(clause),
            'status must carry the same gate as the content it describes: ' + clause);
    }); }

function registerCrossChainUpgradeGroup5(CC_COLS, makeApplySync, callRow, updateClause) { it('assigns the fence LAST, so every gated column is judged against the ORIGINAL generation', async function () {
        // MariaDB evaluates ODKU assignments left to right and later expressions read the
        // ALREADY-UPDATED value (the ODKU ordering trap). push_generation is both a gate
        // input and an assignment target, so lifting it first would make every following
        // column compare the incoming generation against itself and the gate would never
        // refuse anything.
        const { sync, doQuery } = makeApplySync(CC_COLS);
        await sync.applyRow('cross_chain_calls', callRow(7));
        const clause = updateClause(doQuery);
        const fenceAt = clause.indexOf('`push_generation` = GREATEST');
        assert.ok(fenceAt > 0, 'fence assignment present: ' + clause);
        assert.strictEqual(clause.indexOf('`push_generation` = GREATEST', fenceAt + 1), -1, 'assigned once');
        const gated = [...clause.matchAll(/COALESCE\(VALUES\(`push_generation`\), 0\) >= COALESCE\(`push_generation`, 0\)/g)]
                        .map(m => m.index);
        assert.ok(gated.length > 0, 'the gate is used at all');
        assert.ok(gated.every(i => i < fenceAt), 'every gated assignment must precede the fence assignment');
    }); }

function registerCrossChainUpgradeGroup6(CC_COLS, makeApplySync, callRow, updateClause) { it('omits the fence assignment when the mirror table carries no push_generation column', async function () {
        const { sync, doQuery } = makeApplySync(['call_id', 'phase', 'status', 'effective_time']);
        await sync.applyRow('cross_chain_calls',
            { call_id: 'C1', phase: 'dispatch', status: 'finalized', effective_time: 1000 });
        const clause = updateClause(doQuery);
        assert.ok(!/push_generation/.test(clause), 'a pre-migration mirror must not be handed a column it lacks');
        // ...and the gate degrades to the status-only form rather than comparing against a
        // column that is not on the wire, which would be ER_BAD_FIELD_ERROR on every apply.
        assert.ok(/`effective_time` = IF\(VALUES\(status\) = 'finalized', VALUES\(`effective_time`\), `effective_time`\)/.test(clause), clause);
    }); }

describe('HubDbSync _applyRow cross_chain_calls generation fence @regression @tier1', function () {

    // push_generation is the item-5308 reorg FENCE, not content. Assigned inside the
    // status gate it followed the incoming finalized row in EITHER direction, so a
    // bootstrap page fetched before a re-publish and landing AFTER the live re-published
    // row (cross_chain_calls does not buffer during the drain; only price_snapshots does)
    // lowered it. The fenced retraction (DELETE ... WHERE push_generation <= gen)
    // then matched a row published ABOVE the fence and deleted it for good. The fence must
    // only ever move up, the rule cross_chain_matches applies to a_/b_push_generation.

    const CC_COLS = ['id', 'call_id', 'phase', 'status', 'snapshot_block', 'source_chain',
                     'source_action_index', 'target_chain', 'effective_time',
                     'validator_signatures', 'push_generation'];

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    function callRow(gen) {
        return { id: 3, call_id: 'C1', phase: 'dispatch', status: 'finalized', snapshot_block: 900,
                 source_chain: 'DOGE', source_action_index: 42, target_chain: 'BTC',
                 effective_time: 1000, validator_signatures: '[]', push_generation: gen };
    }

    function updateClause(doQuery) {
        const call = doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0]));
        assert.ok(call, 'an upsert must run');
        return call.args[0].split('ON DUPLICATE KEY UPDATE')[1];
    }

    registerCrossChainUpgradeGroup1(CC_COLS, makeApplySync, callRow, updateClause);
    registerCrossChainUpgradeGroup2(CC_COLS, makeApplySync, callRow, updateClause);

    registerCrossChainUpgradeGroup3(CC_COLS, makeApplySync, callRow, updateClause);

    // The fence and the content it arrived with must move TOGETHER. With a status-only
    // content gate a STALE finalized page (lower push_generation, fetched before a
    // re-publish and landing after the live re-published row) overwrote effective_time,
    // parameters, snapshot and signatures while GREATEST kept the NEWER fence on the row.
    // A fenced retraction naming the old generation then could not match it, so the stale
    // terms stuck; effective_time gates the injection block, so the mirror dispatches
    // different terms, or at a different block, from its peers and archive recovery.
    registerCrossChainUpgradeGroup4(CC_COLS, makeApplySync, callRow, updateClause);
    registerCrossChainUpgradeGroup5(CC_COLS, makeApplySync, callRow, updateClause);

    registerCrossChainUpgradeGroup6(CC_COLS, makeApplySync, callRow, updateClause);
});

function registerCrossChainUpgradeGroup7(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('uses an ON DUPLICATE KEY UPDATE upsert (not INSERT IGNORE) for cross_chain_matches', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync.applyRow('cross_chain_matches', matchRow('d0ge'.repeat(16)));
        const insert = doQuery.getCalls().find(c => /cross_chain_matches/.test(c.args[0]) && /INSERT/.test(c.args[0]));
        assert.ok(insert, 'an INSERT must run');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(insert.args[0]), 'must be an upsert');
        assert.ok(!/^INSERT IGNORE/.test(insert.args[0]), 'must NOT be a plain INSERT IGNORE');
    }); }

function registerCrossChainUpgradeGroup8(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('converges the revive content on a version gate, so a missed retract/revive cannot strand the mirror (#3211)', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync.applyRow('cross_chain_matches', matchRow('d0ge'.repeat(16)));
        const clause = updateClauseOf(doQuery);
        // The gate: strictly newer effective_time wins; at a tie the non-finalized
        // (retracted) version wins, because a retraction leaves effective_time untouched
        // while a revive always stamps a later one. `>=` keeps re-delivery idempotent.
        const gate = /VALUES\(`effective_time`\) > `effective_time` OR \(VALUES\(`effective_time`\) = `effective_time` AND IF\(VALUES\(`status`\) = 'finalized', 0, 1\) >= IF\(`status` = 'finalized', 0, 1\)\)/;
        assert.ok(gate.test(clause), 'ordering-independent version gate missing:\n' + clause);
        // The money-bearing columns move under that gate, and ONLY under it.
        for (const col of ['effective_time', 'finalizing_view', 'validator_signatures', 'status']) {
            assert.ok(new RegExp('`' + col + '` = IF\\(\\(VALUES').test(clause), col + ' must upgrade under the version gate');
        }
    }); }

function registerCrossChainUpgradeGroup9(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('assigns status then effective_time LAST, because MariaDB evaluates the SET list left to right', async function () {
        // Load-bearing, and caught only by running it: MariaDB reads the ALREADY-UPDATED
        // value in a later ODKU assignment. With effective_time assigned in plain column
        // order, a strictly-newer REVIVE lifted it first, every later column then saw a tie
        // against itself, and status stayed 'retracted' while the content moved - a
        // half-applied row. Assigning the two gate columns last (status, then effective_time)
        // makes every assignment agree on one verdict. Verified end-to-end against MariaDB.
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync.applyRow('cross_chain_matches', matchRow('d0ge'.repeat(16)));
        const clause = updateClauseOf(doQuery);
        const gatedOrder = CM_COLS.filter(c => new RegExp('`' + c + '` = IF\\(\\(VALUES').test(clause))
            .sort((a, b) => clause.indexOf('`' + a + '` = IF((VALUES') - clause.indexOf('`' + b + '` = IF((VALUES'));
        assert.deepStrictEqual(gatedOrder.slice(-2), ['status', 'effective_time'],
            'the two columns the version gate READS must be the last two gated assignments, in this order');
    }); }

function registerCrossChainUpgradeGroup10(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('never reassigns the row key or the hub id, and keeps anchor_txid first-stamp-wins', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync.applyRow('cross_chain_matches', matchRow('d0ge'.repeat(16)));
        const clause = updateClauseOf(doQuery);
        assert.ok(/anchor_txid = COALESCE\(anchor_txid, VALUES\(anchor_txid\)\)/.test(clause),
            'anchor_txid stays first-stamp-wins, outside the version gate');
        // match_id is the unique key and id is the hub-parity PK: reassigning either would
        // move the row, not upgrade it.
        assert.ok(!/`match_id` =/.test(clause), 'match_id must not be reassigned');
        assert.ok(!/`id` =/.test(clause), 'id must not be reassigned');
        // anchor_txid must not ALSO ride the version gate (that would let a later revive
        // clear an already-stamped txid back to NULL).
        assert.ok(!/`anchor_txid` = IF\(/.test(clause), 'anchor_txid must not ride the version gate');
    }); }

function registerCrossChainUpgradeGroup11(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('the per-leg reorg fences only ever move UP (a lowered fence would invite a stale delete)', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync.applyRow('cross_chain_matches', matchRow(null));
        const clause = updateClauseOf(doQuery);
        for (const col of ['a_push_generation', 'b_push_generation']) {
            assert.ok(new RegExp('`' + col + '` = GREATEST\\(COALESCE\\(`' + col + '`, 0\\), COALESCE\\(VALUES\\(`' + col + '`\\), 0\\)\\)').test(clause),
                col + ' must be monotonic (GREATEST), not gated');
            assert.ok(!new RegExp('`' + col + '` = IF\\(').test(clause), col + ' must not ride the version gate');
        }
    }); }

function registerCrossChainUpgradeGroup12(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('re-delivery of an unstamped row is a no-op against a stamped local row', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync.applyRow('cross_chain_matches', matchRow(null));
        const sql = doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0])).args[0];
        // COALESCE(anchor_txid, VALUES(anchor_txid)): local non-NULL wins, and a NULL
        // incoming value cannot regress it; the branch itself is what guarantees this,
        // the SQL shape is asserted here.
        assert.ok(/COALESCE\(anchor_txid, VALUES\(anchor_txid\)\)/.test(sql));
    }); }

function registerCrossChainUpgradeGroup13(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('still filters hub-only columns the local mirror does not carry', async function () {
        const { sync, doQuery } = makeApplySync(['match_id', 'effective_time', 'status', 'anchor_txid']);
        let row = matchRow('ff00'.repeat(16));
        row.batch_seq = 7;             // hub-side-only archive bookkeeping
        row.archived_status = 'finalized';
        await sync.applyRow('cross_chain_matches', row);
        const sql = doQuery.getCalls().find(c => /INSERT/.test(c.args[0])).args[0];
        assert.ok(!sql.includes('batch_seq'), 'hub-only column dropped');
        assert.ok(!sql.includes('archived_status'), 'hub-only column dropped');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(sql));
    }); }

function registerCrossChainUpgradeGroup14(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('falls back to the anchor-stamp-only upgrade when the row carries no version columns (older hub)', async function () {
        const { sync, doQuery } = makeApplySync(['match_id', 'status', 'anchor_txid']);
        await sync.applyRow('cross_chain_matches', { match_id: 'b'.repeat(64), status: 'finalized', anchor_txid: 'ab'.repeat(32) });
        const clause = updateClauseOf(doQuery);
        // With no effective_time there is no version to compare, so never guess: keep the
        // narrow stamp upgrade rather than clobbering content on an unordered feed.
        assert.strictEqual(clause.trim(), 'anchor_txid = COALESCE(anchor_txid, VALUES(anchor_txid))');
    }); }

function registerCrossChainUpgradeGroup15(CM_COLS, makeApplySync, matchRow, updateClauseOf) { it('falls back to INSERT IGNORE if the row carries no anchor_txid column', async function () {
        const { sync, doQuery } = makeApplySync(['match_id', 'status']);
        await sync.applyRow('cross_chain_matches', { match_id: 'b'.repeat(64), status: 'finalized' });
        const insert = doQuery.getCalls().find(c => /INSERT/.test(c.args[0]));
        assert.ok(/^INSERT IGNORE/.test(insert.args[0]), 'no anchor_txid → plain idempotent insert');
    }); }

describe('HubDbSync _applyRow cross_chain_matches convergence upgrade @regression @tier2', function () {

    // Two mutations reach a mirrored match after its first delivery:
    //  1. anchor_txid, stamped later by the ANCHOR v1 archive
    //     (StateAnchorPublisher.backfillBatch) and re-broadcast. A plain INSERT IGNORE
    //     would no-op and leave anchor_txid NULL on streamed mirrors while a fresh REST
    //     bootstrap serves the stamp (divergent mirrors). First-stamp-wins COALESCE.
    //  2. RETRACT -> REVIVE: a source-chain reorg retracts the crossing (mirrored
    //     as a DELETE); the same crossing re-forms at the same snapshot_block, so
    //     deriveMatchId yields the identical match_id and the hub revives the row with a
    //     NEW effective_time / finalizing_view / validator_signatures. A mirror that missed
    //     the deletion (disconnected, or the fence/co-signature guards refused the event) kept
    //     the pre-reorg row, and an anchor_txid-only ODKU could never converge it - not on
    //     the live re-broadcast and not on the FULL_REPAGE bootstrap, which re-delivers
    //     through this same path. effective_time GATES the settlement block, so the mirror
    //     stayed permanently, money-bearingly divergent from a mirror-fed peer.
    // The upgrade must be ORDERING-INDEPENDENT: judged per row against the local version
    // (effective_time, then finalized-before-retracted at a tie), so a late/duplicate/
    // out-of-order delivery is a no-op instead of a regression.

    const CM_COLS = ['id', 'match_id', 'snapshot_block', 'network', 'a_chain', 'a_amount',
                     'b_chain', 'b_amount', 'effective_time', 'finalizing_view', 'status',
                     'validator_signatures', 'batch_root', 'anchor_txid',
                     'a_push_generation', 'b_push_generation', 'created_at'];

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    function matchRow(txid) {
        return { id: 12, match_id: 'a'.repeat(64), snapshot_block: 900, network: 'regtest',
                 a_chain: 'BTC', a_amount: '1', b_chain: 'DOGE', b_amount: '2',
                 effective_time: 1700000000, finalizing_view: 0,
                 status: 'finalized', validator_signatures: '[]',
                 batch_root: null, anchor_txid: txid,
                 a_push_generation: 3, b_push_generation: 4, created_at: '2026-07-06 00:00:00' };
    }

    const updateClauseOf = (doQuery) =>
        doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0])).args[0].split('ON DUPLICATE KEY UPDATE')[1];

    registerCrossChainUpgradeGroup7(CM_COLS, makeApplySync, matchRow, updateClauseOf);
    registerCrossChainUpgradeGroup8(CM_COLS, makeApplySync, matchRow, updateClauseOf);

    registerCrossChainUpgradeGroup9(CM_COLS, makeApplySync, matchRow, updateClauseOf);
    registerCrossChainUpgradeGroup10(CM_COLS, makeApplySync, matchRow, updateClauseOf);

    registerCrossChainUpgradeGroup11(CM_COLS, makeApplySync, matchRow, updateClauseOf);
    registerCrossChainUpgradeGroup12(CM_COLS, makeApplySync, matchRow, updateClauseOf);

    registerCrossChainUpgradeGroup13(CM_COLS, makeApplySync, matchRow, updateClauseOf);
    registerCrossChainUpgradeGroup14(CM_COLS, makeApplySync, matchRow, updateClauseOf);

    registerCrossChainUpgradeGroup15(CM_COLS, makeApplySync, matchRow, updateClauseOf);
});
