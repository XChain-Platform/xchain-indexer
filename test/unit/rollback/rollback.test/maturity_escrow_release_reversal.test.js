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

const GATE_KEY = 'cooldown_maturity_escrow_reversal_activation.COOLDOWN_MATURITY_ESCROW_REVERSAL_ACTIVATION';

// Far above any chain tip, yet below the sentinel an unarmed row holds.
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

    it('the row is unarmed on mainnet and every testnet chain and active from regtest genesis', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'mainnet', coin, FAR_HEIGHT, null), false);
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', coin, FAR_HEIGHT, null), false);
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
