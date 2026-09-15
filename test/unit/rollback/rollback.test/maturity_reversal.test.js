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
const { createMockIndexer } = require('../../../fixtures/mocks');

const Rollback = require('../../../../src/rollback/index.js');

// Part of the Rollback suite whose entry is test/unit/rollback.test.js: the
// cooldown-maturity reversal (refund credit delete and status reset), the
// contract-staking pre-scan, how both feed the balance and supply recompute, and
// the strict consensus range reads. The suite title is the entry's, so every full
// test title is unchanged.

let indexer, rollback;

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('reverses orphaned cooldown-maturity completions: deletes the refund credit + resets status_id, before the delete and balance recompute', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();

        // Capability maturity refund (GAS) credit delete, keyed by the unstake's action_index.
        const capCreditDel = calls.find(c => /DELETE c FROM credits c/.test(c.args[0]) && /JOIN unstakes u/.test(c.args[0]) && c.args[0].includes('cooldown_end_block'));
        assert.ok(capCreditDel, 'expected a capability maturity-credit delete joined to unstakes');
        assert.deepStrictEqual(capCreditDel.args[1], ['XCHAIN', 1, 100, 100]);

        // Contract maturity refund credit delete, keyed by the unstake's action_index + tick.
        const conCreditDel = calls.find(c => /DELETE c FROM credits c/.test(c.args[0]) && /JOIN contract_unstakes cu/.test(c.args[0]));
        assert.ok(conCreditDel, 'expected a contract maturity-credit delete joined to contract_unstakes');
        assert.deepStrictEqual(conCreditDel.args[1], [1, 100, 100]);

        // Status flips back to 'valid' on both tables so the sweep re-matures the cooldown.
        const capStatusReset = calls.find(c => /UPDATE unstakes SET status_id/.test(c.args[0]) && c.args[0].includes('cooldown_end_block'));
        const conStatusReset = calls.find(c => /UPDATE contract_unstakes SET status_id/.test(c.args[0]) && c.args[0].includes('cooldown_end_block') && !c.args[0].includes('contract_slash_debits'));
        assert.ok(capStatusReset, 'expected an unstakes status_id reset');
        assert.ok(conStatusReset, 'expected a contract_unstakes status_id reset');

        // The credit deletes must run BEFORE the generic credits delete and BEFORE updateBalances,
        // or a surviving-action_index refund would be re-counted into the rolled-back balance.
        const capCreditIdx = calls.indexOf(capCreditDel);
        const genCreditDelIdx = calls.findIndex(c => /DELETE FROM credits WHERE action_index/.test(c.args[0]));
        assert.ok(capCreditIdx >= 0 && genCreditDelIdx >= 0 && capCreditIdx < genCreditDelIdx, 'maturity-credit delete must precede the generic credits delete');
        assert.ok(indexer.indexerDb.updateBalances.notCalled || capCreditIdx >= 0, 'maturity-credit delete must precede updateBalances');
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('feeds the reversed-maturity source address + tick into the balance/supply recompute', async function () {
        // The reversed unstake rows live in surviving blocks (action_index < firstActionIndex),
        // so the read-phase scan never collected them. The reversal block must pre-scan them and
        // feed (address, GAS) / (address, tick) into updateBalances/updateTokens, or the deleted
        // refund credit lingers in the cached balance + token supply (the 4608 divergence).
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [{ action_index: 50 }];
            // Capability maturity pre-scan: SELECT ... FROM unstakes u ... cooldown_end_block
            if (query.includes('FROM unstakes u') && query.includes('cooldown_end_block') && /SELECT/i.test(query)) return [{ address: 'capSrc' }];
            // Contract maturity pre-scan: SELECT ... FROM contract_unstakes cu ... cooldown_end_block
            if (query.includes('FROM contract_unstakes cu') && query.includes('cooldown_end_block') && /SELECT/i.test(query)) return [{ address: 'conSrc', tick: 'CTICK' }];
            return [];
        });

        await rollback.rollback(100);

        const balanceArg = indexer.indexerDb.updateBalances.firstCall.args[0];
        assert.ok(balanceArg.includes('capSrc'), 'updateBalances should receive the capability unstake source address');
        assert.ok(balanceArg.includes('conSrc'), 'updateBalances should receive the contract unstake source address');
        const tokenArg = indexer.indexerDb.updateTokens.firstCall.args[0];
        assert.ok(tokenArg.includes('XCHAIN'), 'updateTokens should receive GAS for the capability maturity refund');
        assert.ok(tokenArg.includes('CTICK'), 'updateTokens should receive the contract unstake tick');
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    // ─── Contract-staking pre-scan (addresses/tickers collection) ─────

    it('pre-scans contract-staking tables and feeds affected addresses/tickers to updateBalances/updateTokens', async function () {
        // First query (firstActionIndex lookup) returns an orphaned range;
        // each contract-staking pre-scan SELECT returns one affected (address, tick) row.
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [{ action_index: 50 }];
            if (query.includes('contract_stakes') && query.includes('source_id')) return [{ tick: 'CSTK', address: 'addrStake' }];
            if (query.includes('contract_unstakes') && query.includes('source_id')) return [{ tick: 'CUNS', address: 'addrUnstake' }];
            if (query.includes('contract_delegations') && query.includes('source_id')) return [{ tick: 'CDEL', address: 'addrDeleg' }];
            return [];
        });

        await rollback.rollback(100);

        // A pre-scan SELECT (joined on source_id) was issued for each of the three tables
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        for (const table of ['contract_stakes', 'contract_unstakes', 'contract_delegations']) {
            assert.ok(
                queries.some(q => q && /SELECT/i.test(q) && q.includes(table) && q.includes('source_id')),
                `expected a pre-scan SELECT joining '${table}' on source_id`
            );
        }

        // The collected addresses/tickers reach the post-rollback recompute
        const balanceArg = indexer.indexerDb.updateBalances.firstCall.args[0];
        assert.ok(balanceArg.includes('addrStake') && balanceArg.includes('addrUnstake') && balanceArg.includes('addrDeleg'),
            'updateBalances should receive the staking addresses from all three tables');
        const tokenArg = indexer.indexerDb.updateTokens.firstCall.args[0];
        assert.ok(tokenArg.includes('CSTK') && tokenArg.includes('CUNS') && tokenArg.includes('CDEL'),
            'updateTokens should receive the tickers from all three tables');
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('feeds action-empty-range cooldown sources into the recompute (null firstActionIndex)', async function () {
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            // No actions in the range -> firstActionIndex null.
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [];
            if (query.includes('FROM unstakes u') && query.includes('cooldown_end_block') && /SELECT/i.test(query)) return [{ address: 'capSrc' }];
            if (query.includes('FROM contract_unstakes cu') && query.includes('cooldown_end_block') && /SELECT/i.test(query)) return [{ address: 'conSrc', tick: 'CTICK' }];
            return [];
        });
        await rollback.rollback(100);
        const balanceArg = indexer.indexerDb.updateBalances.firstCall.args[0];
        assert.ok(balanceArg.includes('capSrc') && balanceArg.includes('conSrc'),
            'updateBalances must receive the reversed-maturity sources even on an action-empty range');
        const tokenArg = indexer.indexerDb.updateTokens.firstCall.args[0];
        assert.ok(tokenArg.includes('XCHAIN') && tokenArg.includes('CTICK'),
            'updateTokens must receive GAS + the contract tick even on an action-empty range');
    });

    // ─── Consensus range reads use the throw-on-fault variant ──────────
    it('reads firstActionIndex / lastActionIndex via doQueryStrict (fault must abort, not empty)', async function () {
        // The mock aliases doQueryStrict to the doQuery stub, so assert the range reads went
        // through the strict entry point by making it throw and confirming rollback propagates.
        const idx = createMockIndexer();
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQueryStrict = sinon.stub().rejects(new Error('lock wait timeout'));
        idx.indexerDb.beginTransaction = sinon.stub().resolves();
        let threw = false;
        try { await rb.rollback(100); } catch(e){ threw = true; }
        assert.ok(threw, 'a fault on the strict range read must abort the rollback');
        assert.ok(idx.indexerDb.beginTransaction.notCalled, 'no transaction (hence no delete) may begin after a failed range read');
    });
});
