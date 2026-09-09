/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/actions/execute.slash-ledger-consolidation.test.js
 *
 * ECONOMIC REGRESSION GUARD for multi-slash ledger overwrite.
 *
 * Every slash in one EXECUTE writes its escrow releases and its destination credit
 * under that EXECUTE's action_index, and db.createLedgerChangeRecord keys a ledger row
 * on (action_index, address_id, tick_id) and OVERWRITES a same-key row with
 * `UPDATE ... SET amount=?`. So two same-token slashes deduct stake and release escrow
 * for the full total while the credit row keeps only the last write, and two slashes
 * against one owner collapse that owner's release the same way. Graduated penalties are
 * documented as repeated slash calls (protocol/contract-staking.md), so this is the
 * normal path.
 *
 * These cases assert the ARGUMENT handed to createCredit / createEscrow, because that is
 * what the overwriting UPDATE stores: post-activation it must be the execution's running
 * total, pre-activation it must still be the per-emission share (the gate is inert on
 * every unpinned chain, so historical replay must not move).
 *
 * The stubs stand in for the DB, not for the unit under test: the running-total
 * arithmetic being checked is _processSlashEmission's own.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');
const Execute = require('../../../src/actions/execute.js');
const gate    = require('../../../src/slash_ledger_consolidation_activation.js');

describe('Execute._processSlashEmission multi-slash ledger conservation @regression @tier1', function () {

    const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const CONTRACT = 5;
    const PUBKEY_A = 'a'.repeat(64);
    const PUBKEY_B = 'b'.repeat(64);
    const DEST     = '1SlashDestXXXXXXXXXXXXXXXXXXXXX';

    // `network` picks the gate state: regtest and mainnet are armed at genesis (mainnet by
    // the 2026-09-09 ruling), testnet is unpinned and therefore inert, which is what makes
    // the legacy cases below reachable at all.
    function makeHandler(network) {
        const config = Object.assign({}, getTestConfig(), { NETWORK: network, COIN: 'BTC' });
        config['GAS_PRICE'] = '0';
        const indexer = createMockIndexer({ config });
        const db = indexer.indexerDb;
        db.getContract      = sinon.stub().resolves({ slash_destination_id: 42 });
        db.getPubkeyId      = sinon.stub().callsFake(async (pk) => (pk === PUBKEY_A ? 7 : 8));
        db.getTickerId      = sinon.stub().resolves(3);
        db.doQuery          = sinon.stub().resolves([{ address: DEST }]);
        db.createCredit     = sinon.stub().resolves();
        db.createEscrow     = sinon.stub().resolves();
        db.createSlashEvent = sinon.stub().resolves();
        const handler = new Execute({
            config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: db,
            protocolChanges: indexer.protocolChanges
        });
        return { handler, db };
    }

    function slashEmission(pubkey) {
        return { action: 'SLASH', params: { contractIndex: CONTRACT, pubkey, token: 'STK', amount: '0' } };
    }

    function slashData() {
        return createBaseData({ ACTION: 'EXECUTE', FORMAT: 0, SOURCE,
            CONTRACT_ACTION_INDEX: CONTRACT, ACTION_INDEX: 99, BLOCK_INDEX: 200 });
    }

    afterEach(function () { sinon.restore(); });

    it('gate is armed on regtest and on mainnet at genesis by the 2026-09-09 ruling, inert on testnet', function () {
        assert.strictEqual(gate.isSlashLedgerConsolidationActive(0, 'regtest', 'BTC'), true);
        assert.strictEqual(gate.isSlashLedgerConsolidationActive(9e9, 'mainnet', 'BTC'), true);
        assert.strictEqual(gate.isSlashLedgerConsolidationActive(9e9, 'testnet', 'BTC'), false);
    });

    // Two owners, one token, one EXECUTE. Both credits land on (99, DEST, STK).
    async function twoOwnerSlashes(network) {
        const { handler, db } = makeHandler(network);
        db.slashContractStake = sinon.stub()
            .onFirstCall().resolves({ total: '10', releases: [{ address: 'ownerX', amount: '10' }] })
            .onSecondCall().resolves({ total: '20', releases: [{ address: 'ownerY', amount: '20' }] });
        const ledger = { credits: new Map(), escrows: new Map() };
        await handler._processSlashEmission(slashEmission(PUBKEY_A), slashData(), 0, ledger);
        await handler._processSlashEmission(slashEmission(PUBKEY_B), slashData(), 1, ledger);
        return {
            credits: db.createCredit.getCalls().map(c => String(c.args[2])),
            escrows: db.createEscrow.getCalls().map(c => [c.args[3], String(c.args[2])]),
            events:  db.createSlashEvent.getCalls().map(c => String(c.args[0]['AMOUNT']))
        };
    }

    it('LEGACY (inert gate): the second credit overwrites the first, losing 10', async function () {
        const out = await twoOwnerSlashes('testnet');
        // Each write carries only its own share, and the row keyed (99, DEST, STK) ends at 20
        // while 30 of stake was debited and 30 of escrow released.
        assert.deepStrictEqual(out.credits, ['10', '20']);
    });

    it('ACTIVE: the second credit carries the running total, so the row ends at 30', async function () {
        const out = await twoOwnerSlashes('regtest');
        assert.deepStrictEqual(out.credits, ['10', '30'],
            'the last write is what the overwriting UPDATE stores, so it must be the total');
        // Distinct owners keep distinct escrow keys, so each release stays its own figure.
        assert.deepStrictEqual(out.escrows, [['ownerX', '-10'], ['ownerY', '-20']]);
        // Per-slash granularity must stay in slash_events, untouched by the consolidation.
        assert.deepStrictEqual(out.events, ['10', '20']);
    });

    // Two slashes against the SAME owner: the escrow releases collide as well as the credits.
    async function sameOwnerSlashes(network) {
        const { handler, db } = makeHandler(network);
        db.slashContractStake = sinon.stub()
            .onFirstCall().resolves({ total: '10', releases: [{ address: 'ownerX', amount: '10' }] })
            .onSecondCall().resolves({ total: '5',  releases: [{ address: 'ownerX', amount: '5' }] });
        const ledger = { credits: new Map(), escrows: new Map() };
        await handler._processSlashEmission(slashEmission(PUBKEY_A), slashData(), 0, ledger);
        await handler._processSlashEmission(slashEmission(PUBKEY_A), slashData(), 1, ledger);
        return {
            credits: db.createCredit.getCalls().map(c => String(c.args[2])),
            escrows: db.createEscrow.getCalls().map(c => String(c.args[2]))
        };
    }

    it('LEGACY (inert gate): a repeat slash on one owner collapses that owner release', async function () {
        const out = await sameOwnerSlashes('testnet');
        assert.deepStrictEqual(out.credits, ['10', '5']);
        assert.deepStrictEqual(out.escrows, ['-10', '-5']);
    });

    it('ACTIVE: a repeat slash on one owner releases -15 and credits 15', async function () {
        const out = await sameOwnerSlashes('regtest');
        assert.deepStrictEqual(out.credits, ['10', '15']);
        assert.deepStrictEqual(out.escrows, ['-10', '-15']);
    });

    // Two spellings of ONE token in one EXECUTE. getTickerId resolves both to
    // the same tick_id, and createLedgerChangeRecord collides on tick_id, so
    // the running total must merge them. Keying the buckets on the raw wire
    // spelling gave each spelling its own bucket, each total came out short,
    // and the later write erased the earlier row exactly as in the legacy case.
    async function mixedCaseSlashes(network) {
        const { handler, db } = makeHandler(network);
        db.slashContractStake = sinon.stub()
            .onFirstCall().resolves({ total: '10', releases: [{ address: 'ownerX', amount: '10' }] })
            .onSecondCall().resolves({ total: '20', releases: [{ address: 'ownerX', amount: '20' }] });
        const ledger = { credits: new Map(), escrows: new Map() };
        const upper = slashEmission(PUBKEY_A);
        const lower = slashEmission(PUBKEY_B);
        lower.params.token = 'stk';
        await handler._processSlashEmission(upper, slashData(), 0, ledger);
        await handler._processSlashEmission(lower, slashData(), 1, ledger);
        return {
            credits: db.createCredit.getCalls().map(c => String(c.args[2])),
            escrows: db.createEscrow.getCalls().map(c => String(c.args[2]))
        };
    }

    it('ACTIVE: two spellings of one token share a bucket, so the totals are 30 and -30', async function () {
        const out = await mixedCaseSlashes('regtest');
        assert.deepStrictEqual(out.credits, ['10', '30'],
            'both spellings resolve to one tick_id, so the second write must carry the whole total');
        assert.deepStrictEqual(out.escrows, ['-10', '-30'],
            'and the escrow releases for one owner merge across spellings too');
    });

    it('LEGACY (inert gate): two spellings of one token still lose the first write', async function () {
        const out = await mixedCaseSlashes('testnet');
        assert.deepStrictEqual(out.credits, ['10', '20']);
        assert.deepStrictEqual(out.escrows, ['-10', '-20']);
    });

    it('ACTIVE: a single slash is byte-identical to the legacy write', async function () {
        const one = async (network) => {
            const { handler, db } = makeHandler(network);
            db.slashContractStake = sinon.stub().resolves({ total: '100', releases: [{ address: 'ownerX', amount: '100' }] });
            await handler._processSlashEmission(slashEmission(PUBKEY_A), slashData(), 0, { credits: new Map(), escrows: new Map() });
            const out = {
                credit: String(db.createCredit.firstCall.args[2]),
                escrow: String(db.createEscrow.firstCall.args[2])
            };
            sinon.restore();
            return out;
        };
        assert.deepStrictEqual(await one('regtest'), await one('testnet'));
    });

    it('a caller that passes no ledger keeps the legacy per-emission write', async function () {
        const { handler, db } = makeHandler('regtest');
        db.slashContractStake = sinon.stub()
            .onFirstCall().resolves({ total: '10', releases: [{ address: 'ownerX', amount: '10' }] })
            .onSecondCall().resolves({ total: '20', releases: [{ address: 'ownerY', amount: '20' }] });
        await handler._processSlashEmission(slashEmission(PUBKEY_A), slashData(), 0);
        await handler._processSlashEmission(slashEmission(PUBKEY_B), slashData(), 1);
        assert.deepStrictEqual(db.createCredit.getCalls().map(c => String(c.args[2])), ['10', '20']);
    });
});
