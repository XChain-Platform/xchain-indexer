process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');

const Rollback = require('../../src/rollback.js');

describe('Rollback @regression @tier3', function () {
    let indexer, rollback;

    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback accesses indexer.protocolChanges; set a stub
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    // ─── Table array contents ─────────────────────────────────────────

    it('blockTables contains blocks and transactions', function () {
        assert.ok(rollback.blockTables.includes('blocks'));
        assert.ok(rollback.blockTables.includes('transactions'));
    });

    it('dataTables contains expected core tables', function () {
        const expected = ['actions', 'credits', 'debits', 'escrows', 'issues', 'swaps', 'orders', 'mappings_actions'];
        for (const table of expected) {
            assert.ok(rollback.dataTables.includes(table), `dataTables should include '${table}'`);
        }
    });

    it('dataTables contains all dispenser-related tables', function () {
        const dispenserTables = ['dispensers', 'dispenser_cancels', 'dispenser_closes', 'dispenser_edits', 'dispenser_expires', 'dispenser_statuses', 'dispenses'];
        for (const table of dispenserTables) {
            assert.ok(rollback.dataTables.includes(table), `dataTables should include '${table}'`);
        }
    });

    it('dataTables contains the prices table so orphaned PRICE rows are pruned', function () {
        assert.ok(rollback.dataTables.includes('prices'), `dataTables should include 'prices'`);
    });

    // ─── Hub price retraction signal ──────────────────────────────────

    it('signals the hub to retract prices for the rolled-back range', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        // First query returns an action_index so the rollback has an orphaned range
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractPriceRange.calledOnce, 'expected retractPriceRange to be called once');
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[0], rb.config['COIN']);
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[1], 50);
    });

    it('does NOT signal the hub when there are no actions in the rolled-back range', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]); // no action_index found
        await rb.rollback(100);
        assert.ok(hubClient.retractPriceRange.notCalled, 'expected no retraction when range is empty');
    });

    it('does not throw when the hub retraction fails (best-effort)', async function () {
        const hubClient = { retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')) };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
    });

    // ─── Transaction wrapping ─────────────────────────────────────────

    it('calls beginTransaction at the start of rollback', async function () {
        // Return no action_indexes so the DELETE phase is minimal
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.beginTransaction.calledOnce);
    });

    it('calls commitTransaction on success', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.commitTransaction.calledOnce);
    });

    it('does NOT call rollbackTransaction on success', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.rollbackTransaction.notCalled);
    });

    // ─── Error path: rollbackTransaction called on failure ────────────

    it('calls rollbackTransaction when an error occurs inside the transaction', async function () {
        // First doQuery call returns rows (triggering the delete phase)
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        // Subsequent doQuery calls resolve normally until the commit path hits updateBalances
        indexer.indexerDb.doQuery.resolves([]);
        // Force commitTransaction to throw
        indexer.indexerDb.commitTransaction.rejects(new Error('commit failed'));
        await assert.rejects(() => rollback.rollback(100), /commit failed/);
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce);
    });

    // ─── DELETE queries issued ────────────────────────────────────────

    it('issues DELETE queries for blockTables using block_index', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        const blockDeletes = queries.filter(q => q && q.includes('DELETE FROM') && q.includes('block_index'));
        assert.ok(blockDeletes.length >= rollback.blockTables.length,
            `Expected at least ${rollback.blockTables.length} block_index DELETE queries, got ${blockDeletes.length}`);
    });

    it('issues DELETE queries for dataTables when firstActionIndex exists', async function () {
        // First query returns an action_index so DELETE phase runs
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        const actionDeletes = queries.filter(q => q && q.includes('DELETE FROM') && q.includes('action_index'));
        assert.ok(actionDeletes.length > 0, 'Expected action_index DELETE queries when firstActionIndex exists');
    });

    // ─── Post-rollback updates ────────────────────────────────────────

    it('calls updateBalances after rollback', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.updateBalances.calledOnce);
    });

    it('calls updateTokens after rollback', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.updateTokens.calledOnce);
    });

    it('calls updateMarkets after rollback', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.updateMarkets.calledOnce);
    });

    it('calls sanityCheck after rollback', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.sanityCheck.calledOnce);
    });
});
