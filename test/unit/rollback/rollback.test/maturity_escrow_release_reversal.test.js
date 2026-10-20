// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');

const maturitySql = require('../../../../src/db/rollback/cooldown_maturities.js');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const Rollback = require('../../../../src/rollback/index.js');
const { makeMigrationDb } = require('../../../helpers/sqlMigrationDb');

const GATE_KEY = 'cooldown_maturity_escrow_reversal_activation.COOLDOWN_MATURITY_ESCROW_REVERSAL_ACTIVATION';

// Far above any chain tip and every armed testnet height, yet below the sentinel an unarmed row holds.
const FAR_HEIGHT = 1e9;

const isReleaseDelete = c => /DELETE e FROM escrows AS e/.test(c.args[0]);
const isRefundDelete = c => /DELETE c FROM credits c/.test(c.args[0]) && /cooldown_end_block/.test(c.args[0]);
const isStatusReset = c => /^UPDATE (contract_)?unstakes SET status_id = \?\s+WHERE status_id = \? AND cooldown_end_block/.test(c.args[0]);

describe('cooldown maturity escrow release reversal @regression @tier3', function () {
    it('deletes each legacy refund credit together with its paired negative escrow release', async function () {
        const db = { doQuery: sinon.stub().resolves([]) };

        await maturitySql.reverseMaturedRefunds(db, 'XCHAIN', 7, 3, 100, true);

        const calls = db.doQuery.getCalls();
        const capEscrowDel = calls.find(c => /DELETE e FROM escrows AS e/.test(c.args[0]) && /JOIN unstakes u/.test(c.args[0]));
        const conEscrowDel = calls.find(c => /DELETE e FROM escrows AS e/.test(c.args[0]) && /JOIN contract_unstakes cu/.test(c.args[0]));
        assert.ok(capEscrowDel, 'expected the capability maturity escrow release to be deleted');
        assert.ok(conEscrowDel, 'expected the contract maturity escrow release to be deleted');
        assert.match(capEscrowDel.args[0], /u\.action_index = e\.action_index AND u\.source_id = e\.address_id/);
        assert.match(capEscrowDel.args[0], /g\.id = e\.tick_id AND g\.tick = \?/);
        assert.match(conEscrowDel.args[0], /cu\.action_index = e\.action_index/);
        assert.match(conEscrowDel.args[0], /cu\.source_id\s*= e\.address_id/);
        assert.match(conEscrowDel.args[0], /cu\.tick_id\s*= e\.tick_id/);
        assert.match(capEscrowDel.args[0], /CAST\(e\.amount AS DECIMAL\(60,18\)\) < 0/);
        assert.match(conEscrowDel.args[0], /CAST\(e\.amount AS DECIMAL\(60,18\)\) < 0/);
        assert.deepStrictEqual(capEscrowDel.args[1], ['XCHAIN', 7, 100, 100]);
        assert.deepStrictEqual(conEscrowDel.args[1], [7, 100, 100]);
        // Each release goes while its unstake still reads 'completed', the status the join keys on.
        const firstReset = calls.findIndex(isStatusReset);
        assert.ok(calls.indexOf(capEscrowDel) < firstReset && calls.indexOf(conEscrowDel) < firstReset,
            'both release deletes must precede the status reset');
    });

    it('keeps both escrow releases and still deletes the credits and resets the status when the delete is off', async function () {
        const db = { doQuery: sinon.stub().resolves([]) };

        await maturitySql.reverseMaturedRefunds(db, 'XCHAIN', 7, 3, 100, false);

        const calls = db.doQuery.getCalls();
        assert.strictEqual(calls.filter(isReleaseDelete).length, 0, 'no escrow release may be deleted');
        assert.strictEqual(calls.filter(isRefundDelete).length, 2, 'both refund credits are still deleted');
        assert.strictEqual(calls.filter(isStatusReset).length, 2, 'both completed flips are still reset');
        assert.strictEqual(calls.length, 4, 'the legacy reversal is exactly two credit deletes and two resets');
    });
});

describe('cooldown maturity escrow release reversal: activation @regression @tier3', function () {
    let indexer;

    // Runs one rollback to `block_index` on `network` and returns every statement it issued.
    async function rollbackCalls(network, block_index) {
        indexer.config.NETWORK = network;
        const rollback = new Rollback(indexer);
        indexer.util.resetLists();
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(block_index);
        return indexer.indexerDb.doQuery.getCalls();
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
    });

    afterEach(function () { sinon.restore(); });

    it('the row is unarmed on mainnet, armed per testnet chain, and active from regtest genesis', function () {
        const row = gateRegistry.get(GATE_KEY);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'mainnet', coin, FAR_HEIGHT, null), false);
            // The armed height is read from the registry so the next cut moves it without a test edit.
            const armed = row[coin + ':testnet'];
            assert.ok(Number.isSafeInteger(armed) && armed > 1 && armed < FAR_HEIGHT, coin + ' ' + armed);
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', coin, armed, null), true, coin);
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', coin, 1, null), false, coin);
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'regtest', coin, 0, null), true);
        }
    });

    it('a rollback on an unarmed network keeps the escrow releases and reverses everything else as before', async function () {
        for (const network of ['mainnet', 'testnet']) {
            indexer.indexerDb.doQuery.resetHistory();
            const calls = await rollbackCalls(network, 100);
            assert.strictEqual(calls.filter(isReleaseDelete).length, 0, network + ': the release must survive below the activation');
            assert.strictEqual(calls.filter(isRefundDelete).length, 2, network + ': both refund credits are still deleted');
            assert.strictEqual(calls.filter(isStatusReset).length, 2, network + ': both completed flips are still reset');
        }
    });

    it('a rollback at an active height deletes both releases so the re-maturity writes the only one', async function () {
        const calls = await rollbackCalls('regtest', 100);
        const releases = calls.filter(isReleaseDelete);
        assert.strictEqual(releases.length, 2, 'the capability and the contract release are both deleted');
        assert.deepStrictEqual(releases[0].args[1], ['XCHAIN', 1, 100, 100]);
        assert.deepStrictEqual(releases[1].args[1], [1, 100, 100]);
        assert.strictEqual(calls.filter(isRefundDelete).length, 2);
        assert.strictEqual(calls.filter(isStatusReset).length, 2);
    });

    it('the switch is read at the rollback target block, for this network and coin', async function () {
        const activeAt = sinon.stub(gateRegistry, 'activeAt').callThrough();
        activeAt.withArgs(GATE_KEY).callsFake((key, network, coin, height) => height >= 500);

        const below = await rollbackCalls('testnet', 499);
        assert.strictEqual(below.filter(isReleaseDelete).length, 0, 'one block below the height keeps the releases');
        indexer.indexerDb.doQuery.resetHistory();
        const at = await rollbackCalls('testnet', 500);
        assert.strictEqual(at.filter(isReleaseDelete).length, 2, 'the height itself deletes them');

        const reads = activeAt.getCalls().filter(c => c.args[0] === GATE_KEY).map(c => c.args.slice(1));
        assert.deepStrictEqual(reads, [['testnet', 'BTC', 499, null], ['testnet', 'BTC', 500, null]]);
    });
});

// A cooldown slashed to zero never matures: the sweep skips amount = 0, so the row keeps
// 'valid' and no refund credit or release is written under the unstake's action_index. The
// only negative escrow its source holds is the slash's own release, keyed on the slash's
// action_index. The reversal must leave that row, that release and the stake-time lock
// alone while it undoes a sibling cooldown that did mature in the orphaned range. These
// cases run the real statements on node:sqlite rather than matching their text, since a
// join that also caught the slash release would read the same as one that does not.
describe('cooldown maturity escrow release reversal: slash to zero @regression @tier3', function () {
    const cooldownSql = require('../../../../src/db/contracts/cooldowns.js');

    const GAS = 'XCHAIN';
    const REORG = 100;
    const VALID = 3;
    const COMPLETED = 7;
    // Two sources: alice's cooldowns matured in the orphaned range, bob's were slashed to zero.
    const ALICE = 1;
    const BOB = 2;
    const GAS_ID = 1;
    const TOK_ID = 2;

    let sql;
    let db;

    // MySQL's multi-table DELETE has no sqlite spelling; rewrite it to the equivalent
    // rowid subselect so the join and WHERE run unchanged.
    function toSqlite(text){
        const m = /^\s*DELETE (\w+) FROM (\w+) (?:AS )?(\w+)\s+([\s\S]*)$/.exec(text);
        if(!m) return text;
        assert.strictEqual(m[1], m[3], 'the delete target is the aliased table');
        return 'DELETE FROM ' + m[2] + ' WHERE rowid IN (SELECT ' + m[3] + '.rowid FROM ' + m[2] + ' AS ' + m[3] + ' ' + m[4] + ')';
    }

    function rows(text, ...args){
        return sql.prepare(text).all(...args).map(r => Object.assign({}, r));
    }

    beforeEach(function () {
        const mem = makeMigrationDb([
            'index_addresses.sql', 'index_tickers.sql', 'unstakes.sql',
            'contract_unstakes.sql', 'credits.sql', 'escrows.sql'
        ]);
        sql = mem.db;
        const { insert } = mem;
        insert('index_addresses', { id: ALICE, address: 'alice' });
        insert('index_addresses', { id: BOB, address: 'bob' });
        insert('index_tickers', { id: GAS_ID, tick: 'XCHAIN' });
        insert('index_tickers', { id: TOK_ID, tick: 'TOK' });

        const escrow = (action_index, address_id, tick_id, amount) =>
            insert('escrows', { action_index, address_id, tick_id, amount });
        const credit = (action_index, address_id, tick_id, amount) =>
            insert('credits', { action_index, address_id, tick_id, amount });
        const unstake = (action_index, source_id, cooldown_end_block, amount, status_id) =>
            insert('unstakes', {
                action_index, source_id, signing_pubkey_id: 1, cooldown_end_block, amount, status_id, block_index: 50
            });
        const contractUnstake = (action_index, source_id, tick_id, cooldown_end_block, amount, status_id) =>
            insert('contract_unstakes', {
                action_index, source_id, signing_pubkey_id: 1, tick_id, cooldown_end_block, amount, status_id, block_index: 50
            });

        // Stake-time locks for every bond.
        escrow(4, ALICE, GAS_ID, '5'); escrow(5, BOB, GAS_ID, '7');
        escrow(14, ALICE, TOK_ID, '3'); escrow(15, BOB, TOK_ID, '9');

        // alice: both cooldowns matured at 120, inside the orphaned range, with the legacy
        // refund and release written under each unstake's own action_index.
        unstake(10, ALICE, 120, '5', COMPLETED);
        contractUnstake(20, ALICE, TOK_ID, 120, '3', COMPLETED);
        credit(10, ALICE, GAS_ID, '5'); credit(20, ALICE, TOK_ID, '3');
        escrow(10, ALICE, GAS_ID, '-5'); escrow(20, ALICE, TOK_ID, '-3');

        // bob: both cooldowns slashed to zero at surviving block 60 (slash actions 30 and 31),
        // so neither ever matured. The slash released each bond under its own action_index.
        unstake(11, BOB, 120, '0', VALID);
        contractUnstake(21, BOB, TOK_ID, 120, '0', VALID);
        escrow(30, BOB, GAS_ID, '-7'); escrow(31, BOB, TOK_ID, '-9');
        db = {
            config: { GAS },
            async doQuery(text, args){ return rows(toSqlite(text), ...(args || [])); },
            async getStatusId(name){ return { valid: VALID, completed: COMPLETED }[name] ?? null; },
            async createStatus(name){ return { valid: VALID, completed: COMPLETED }[name]; },
        };
    });

    afterEach(function () { sql.close(); });

    function bobState(){
        return {
            unstakes: rows('SELECT action_index, amount, status_id FROM unstakes WHERE source_id = ?', BOB),
            contractUnstakes: rows('SELECT action_index, amount, status_id FROM contract_unstakes WHERE source_id = ?', BOB),
            credits: rows('SELECT * FROM credits WHERE address_id = ? ORDER BY action_index', BOB),
            escrows: rows('SELECT * FROM escrows WHERE address_id = ? ORDER BY action_index', BOB),
        };
    }

    it('the sweep never matures a slashed-to-zero cooldown, so it never reads completed', async function () {
        const sweep = await cooldownSql.sweepCompletedCooldowns.call(db, 120);
        // alice is already completed; bob's rows are due and valid but hold nothing.
        assert.deepStrictEqual(sweep.capabilityRows, []);
        assert.deepStrictEqual(sweep.contractRows, []);
        sql.exec('UPDATE unstakes SET status_id = 3 WHERE action_index = 10');
        sql.exec('UPDATE contract_unstakes SET status_id = 3 WHERE action_index = 20');
        const both = await cooldownSql.sweepCompletedCooldowns.call(db, 120);
        assert.deepStrictEqual(both.capabilityRows, [10], 'only the funded capability cooldown is swept');
        assert.deepStrictEqual(both.contractRows, [20], 'only the funded contract cooldown is swept');
    });

    it('a slashed-to-zero source is not seeded into the recompute', async function () {
        const cap = await maturitySql.readMaturedCapabilitySources(db, COMPLETED, REORG);
        const con = await maturitySql.readMaturedContractSources(db, COMPLETED, REORG);
        assert.deepStrictEqual(cap, [{ address: 'alice' }]);
        assert.deepStrictEqual(con, [{ address: 'alice', tick: 'TOK' }]);
    });

    it('an active reversal undoes the matured sibling and keeps the slash release and the slashed row', async function () {
        const before = bobState();

        await maturitySql.reverseMaturedRefunds(db, GAS, COMPLETED, VALID, REORG, true);

        assert.deepStrictEqual(bobState(), before, 'nothing of the slashed-to-zero source moves');
        assert.deepStrictEqual(before.escrows.map(e => [e.action_index, e.amount]),
            [[5, '7'], [15, '9'], [30, '-7'], [31, '-9']], 'both stake locks and both slash releases survive');
        assert.deepStrictEqual(rows('SELECT * FROM credits'), [], 'only the matured refunds existed and both are gone');
        assert.deepStrictEqual(rows('SELECT action_index, amount FROM escrows WHERE address_id = ? ORDER BY action_index', ALICE),
            [{ action_index: 4, amount: '5' }, { action_index: 14, amount: '3' }], 'only the matured releases are deleted');
        assert.deepStrictEqual(rows('SELECT status_id FROM unstakes WHERE action_index = 10'), [{ status_id: VALID }]);
        assert.deepStrictEqual(rows('SELECT status_id FROM contract_unstakes WHERE action_index = 20'), [{ status_id: VALID }]);
        // Net escrow per source and tick: alice's bond is locked again for the re-maturity,
        // bob's slashed bond stays fully released.
        assert.deepStrictEqual(
            rows('SELECT address_id, tick_id, SUM(CAST(amount AS REAL)) AS net FROM escrows GROUP BY address_id, tick_id ORDER BY address_id, tick_id'),
            [{ address_id: ALICE, tick_id: GAS_ID, net: 5 }, { address_id: ALICE, tick_id: TOK_ID, net: 3 },
             { address_id: BOB, tick_id: GAS_ID, net: 0 }, { address_id: BOB, tick_id: TOK_ID, net: 0 }]);
    });

    it('an unarmed reversal also leaves the slashed-to-zero source untouched', async function () {
        const before = bobState();

        await maturitySql.reverseMaturedRefunds(db, GAS, COMPLETED, VALID, REORG, false);

        assert.deepStrictEqual(bobState(), before);
        assert.deepStrictEqual(rows('SELECT * FROM credits'), []);
        assert.strictEqual(rows('SELECT * FROM escrows WHERE address_id = ? AND CAST(amount AS REAL) < 0', ALICE).length, 2,
            'below the activation the matured releases survive');
    });

    it('a slashed-to-zero cooldown alone makes the reversal a no-op', async function () {
        sql.exec('DELETE FROM unstakes WHERE source_id = 1; DELETE FROM contract_unstakes WHERE source_id = 1;');
        sql.exec('DELETE FROM credits; DELETE FROM escrows WHERE address_id = 1;');
        const before = bobState();

        await maturitySql.reverseMaturedRefunds(db, GAS, COMPLETED, VALID, REORG, true);

        assert.deepStrictEqual(bobState(), before);
    });
});
