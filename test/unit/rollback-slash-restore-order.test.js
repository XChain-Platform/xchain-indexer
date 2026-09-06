// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/*
 * The contract slash reorg-restore, executed rather than mocked.
 *
 * The restore picks ONE debit per stake row and copies its `prev_amount` back.
 * Which debit it picks is the whole correctness of the statement, and a stubbed
 * doQuery cannot observe that: every suite that asserts the SQL text is green for
 * any pick the predicate makes. So the shipped statement runs here for real, on
 * node:sqlite, against the project's own src/sql DDL.
 *
 * The pick must be the row's amount before the FIRST orphaned debit. Debits on one
 * stake row form a strictly decreasing chain, so that value is the HIGHEST orphaned
 * `prev_amount`. Position columns cannot stand in for it: a re-entrant nested
 * EXECUTE runs its SLASH before its parent's while taking a HIGHER action_index,
 * so an (execution_index, slash_position) order reads the chain backwards and
 * restores a value one slash short. A node that restores short carries less active
 * stake than a from-genesis replay, which moves VM staker weighting and quorum
 * eligibility: a fork, not a rounding error.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');
const { makeMigrationDb }   = require('../helpers/sqlMigrationDb');

const Rollback = require('../../src/rollback.js');

// The restore statements rollback() actually issues, keyed by stake table.
async function shippedRestores(){
    const indexer = createMockIndexer();
    indexer.protocolChanges = {
        isDefined: sinon.stub().returns(true),
        isEnabled: sinon.stub().resolves(true),
    };
    const rollback = new Rollback(indexer);
    indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
    indexer.indexerDb.doQuery.resolves([]);
    await rollback.rollback(100);
    const out = {};
    for(const call of indexer.indexerDb.doQuery.getCalls()){
        const sql = String(call.args[0]);
        if(!/UPDATE contract_(?:un)?stakes/.test(sql)) continue;
        if(!sql.includes('contract_slash_debits') || !sql.includes('prev_amount')) continue;
        out[call.args[1][0]] = { sql, args: call.args[1] };
    }
    return out;
}

// MySQL multi-table UPDATE -> the sqlite UPDATE ... FROM spelling. The join
// condition moves into the WHERE and nothing else changes: the SET target, the
// predicate and the bind order stay the shipped text, so what runs below is the
// statement the indexer issues.
function toSqliteUpdate(sql){
    const one = String(sql).replace(/\s+/g, ' ').trim();
    const m = one.match(/^UPDATE (\w+) t JOIN (\w+) d ON (.+?) SET t\.amount = d\.prev_amount WHERE (.+)$/);
    assert.ok(m, 'restore statement is no longer an UPDATE ... JOIN ... SET t.amount = d.prev_amount: ' + one);
    return 'UPDATE ' + m[1] + ' AS t SET amount = d.prev_amount FROM ' + m[2] + ' d WHERE ' + m[3] + ' AND ' + m[4];
}

// One stake row and its debit chain, rolled back to block 100.
// debit = { execution_index, slash_position, prev_amount, amount, block_index }
function restoredAmount(restore, debits){
    const h = makeMigrationDb(['contract_stakes.sql', 'contract_slash_debits.sql']);
    try {
        const post = debits.length ? debits[debits.length - 1] : null;
        h.insert('contract_stakes', {
            action_index: 900, source_id: 1, version: 3, signing_pubkey_id: 1,
            target_contract_index: 7, tick_id: 2,
            amount: post ? String(Number(post.prev_amount) - Number(post.amount)) : '1000',
            status_id: 1, block_index: 90, activation_block: 90
        });
        for(const d of debits){
            h.insert('contract_slash_debits', {
                execution_index: d.execution_index, slash_position: d.slash_position,
                target_table: 'contract_stakes', stake_action_index: 900,
                prev_amount: d.prev_amount, amount: d.amount, block_index: d.block_index
            });
        }
        h.db.prepare(toSqliteUpdate(restore.sql)).run(...restore.args);
        return h.rows('SELECT amount FROM contract_stakes WHERE action_index = 900')[0].amount;
    } finally {
        h.close();
    }
}

describe('Rollback contract slash-restore order @regression @tier3', function(){
    let restores;

    before(async function(){
        restores = await shippedRestores();
    });

    it('issues a restore for both stake-ledger tables', function(){
        assert.ok(restores['contract_stakes'],   'expected a contract_stakes restore');
        assert.ok(restores['contract_unstakes'], 'expected a contract_unstakes restore');
        assert.deepStrictEqual(restores['contract_stakes'].args,   ['contract_stakes', 100, 100]);
        assert.deepStrictEqual(restores['contract_unstakes'].args, ['contract_unstakes', 100, 100]);
    });

    it('restores the pre-slash amount when the orphaned slashes arrive in ascending execution order', function(){
        const got = restoredAmount(restores['contract_stakes'], [
            { execution_index: 500, slash_position: 0, prev_amount: '1000', amount: '300', block_index: 100 },
            { execution_index: 502, slash_position: 0, prev_amount:  '700', amount: '200', block_index: 100 }
        ]);
        assert.strictEqual(got, '1000');
    });

    it('restores the pre-slash amount when a re-entrant nested EXECUTE slashes first under a higher action_index', function(){
        // Emission 0 of the parent EXECUTE (action_index 500) is a nested EXECUTE that
        // re-enters the same contract as action_index 501 and SLASHes; the parent's own
        // SLASH is emission 1. The nested debit is applied FIRST and sorts LAST on
        // execution_index, so an order built from the position columns picks the parent's
        // debit and restores 700 for a row that held 1000.
        const got = restoredAmount(restores['contract_stakes'], [
            { execution_index: 501, slash_position: 0, prev_amount: '1000', amount: '300', block_index: 100 },
            { execution_index: 500, slash_position: 1, prev_amount:  '700', amount: '200', block_index: 100 }
        ]);
        assert.strictEqual(got, '1000',
            'the restore must copy back the amount before the FIRST orphaned debit, not the lowest-execution_index one');
    });

    it('restores the pre-slash amount through three inverted nesting levels', function(){
        const got = restoredAmount(restores['contract_stakes'], [
            { execution_index: 503, slash_position: 0, prev_amount: '1000', amount: '100', block_index: 100 },
            { execution_index: 502, slash_position: 0, prev_amount:  '900', amount: '100', block_index: 100 },
            { execution_index: 501, slash_position: 0, prev_amount:  '800', amount: '100', block_index: 100 },
            { execution_index: 500, slash_position: 3, prev_amount:  '700', amount: '100', block_index: 100 }
        ]);
        assert.strictEqual(got, '1000');
    });

    it('leaves debits below the rollback height applied', function(){
        const got = restoredAmount(restores['contract_stakes'], [
            { execution_index: 400, slash_position: 0, prev_amount: '1200', amount: '200', block_index:  99 },
            { execution_index: 500, slash_position: 0, prev_amount: '1000', amount: '300', block_index: 100 }
        ]);
        assert.strictEqual(got, '1000', 'a surviving debit stays applied; only the orphaned range reverts');
    });

    it('touches nothing when every debit survives the rollback', function(){
        const got = restoredAmount(restores['contract_stakes'], [
            { execution_index: 400, slash_position: 0, prev_amount: '1200', amount: '200', block_index: 98 },
            { execution_index: 450, slash_position: 0, prev_amount: '1000', amount: '300', block_index: 99 }
        ]);
        assert.strictEqual(got, '700', 'no orphaned debit means no restore');
    });

    it('picks one row deterministically when two orphaned debits carry the same prev_amount', function(){
        // A debit that rounds to a zero take leaves the column unchanged, so two debits on
        // one row can share a prev_amount. The value order cannot separate them; the
        // (block_index, execution_index, slash_position) tiebreak does, on every node.
        const got = restoredAmount(restores['contract_stakes'], [
            { execution_index: 500, slash_position: 0, prev_amount: '1000', amount:   '0', block_index: 100 },
            { execution_index: 501, slash_position: 0, prev_amount: '1000', amount: '300', block_index: 100 }
        ]);
        assert.strictEqual(got, '1000');
    });
});
