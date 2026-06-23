/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.contractStake-refund-precision.test.js
 *
 * PRECISION REGRESSION GUARD for the contract-stake refund (item 5303).
 *
 * getActiveContractStakeByPubkey used to aggregate the refund via
 * SUM(CAST(cs.amount AS DECIMAL(30,8))), truncating contract-staked tokens
 * with more than 8 decimals (STAKE v3 accepts any tick up to 18 dp). The
 * truncated value then flowed un-normalized into contract_unstakes.AMOUNT
 * and the cooldown credit, silently destroying sub-1e-8 token value.
 *
 * Fix: sum the raw VARCHAR cs.amount rows with the bignumber wrapper at the
 * staked tick's own DECIMALS, so XCHAIN(8) output stays byte-identical to the
 * old 8-dp path and an 18-dp token is exact.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// Stub the id lookups + decimal precision, and feed the contract_stakes rows
// the aggregator reads back through doQuery.
function stub(db, decimals, rows) {
    sinon.stub(db, 'getPubkeyId').resolves(10);
    sinon.stub(db, 'getTickerId').resolves(20);
    sinon.stub(db, 'getStatusId').resolves(1);
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(decimals);
    sinon.stub(db, 'doQuery').resolves(rows);
}

afterEach(function () { sinon.restore(); });

describe('getActiveContractStakeByPubkey refund precision @regression @tier1', function () {

    it('sums an 18-dp contract stake exactly (no 8-dp truncation)', async function () {
        const db = makeDb();
        // Two stakes finer than 1e-8; the old DECIMAL(30,8) CAST would floor each to 0.
        stub(db, 18, [
            { source_id: 5, amount: '0.000000000000000001', activation_block: 100, block_index: 90, signing_pubkey: 'PK', tick: 'DEEP' },
            { source_id: 5, amount: '0.000000000000000002', activation_block: 105, block_index: 95, signing_pubkey: 'PK', tick: 'DEEP' }
        ]);

        const agg = await db.getActiveContractStakeByPubkey(7, 'PK', 'DEEP', 300, { undeactivatedOnly: true });

        assert.ok(agg, 'aggregate returned');
        assert.strictEqual(agg.amount, '0.000000000000000003', 'exact 18-dp sum, not truncated to 0');
        // MIN(...) replicated in JS over the rows
        assert.strictEqual(agg.source_id, 5);
        assert.strictEqual(agg.activation_block, 100);
        assert.strictEqual(agg.block_index, 90);
        assert.strictEqual(agg.tick, 'DEEP');
        assert.strictEqual(agg.signing_pubkey, 'PK');
    });

    it('keeps XCHAIN(8) output byte-identical to the old 8-dp path', async function () {
        const db = makeDb();
        // Mixed stored representations ("10", "5.5") must normalize to fixed 8 dp,
        // exactly as SUM(CAST(... AS DECIMAL(30,8))) did before.
        stub(db, 8, [
            { source_id: 3, amount: '10',  activation_block: 200, block_index: 190, signing_pubkey: 'PK', tick: 'XCHAIN' },
            { source_id: 3, amount: '5.5', activation_block: 210, block_index: 195, signing_pubkey: 'PK', tick: 'XCHAIN' }
        ]);

        const agg = await db.getActiveContractStakeByPubkey(7, 'PK', 'XCHAIN', 300, { undeactivatedOnly: true });

        assert.ok(agg, 'aggregate returned');
        assert.strictEqual(agg.amount, '15.50000000', 'fixed 8-dp string, identical to the prior CAST');
    });

    it('returns null when no active contract-stake rows match', async function () {
        const db = makeDb();
        stub(db, 8, []);
        const agg = await db.getActiveContractStakeByPubkey(7, 'PK', 'XCHAIN', 300, { undeactivatedOnly: true });
        assert.strictEqual(agg, null);
    });
});

describe('getContractStakeDataForVM snapshot precision @regression @tier1', function () {

    it('aggregates an 18-dp tick at full precision in the VM-visible snapshot', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(18);
        sinon.stub(db, 'doQuery').resolves([
            { signing_pubkey_id: 1, pubkey: 'PK', tick_id: 20, tick: 'DEEP', amount: '0.000000000000000001', activation_block: 1, deactivation_block: null },
            { signing_pubkey_id: 1, pubkey: 'PK', tick_id: 20, tick: 'DEEP', amount: '0.000000000000000002', activation_block: 1, deactivation_block: null }
        ]);

        const snap = await db.getContractStakeDataForVM(7, 300);

        // Old flat-8dp bcadd would have floored both rows to 0; getStake/getTotalStaked must see 3e-18.
        assert.strictEqual(db.util.bcformat(snap.stakeByPubkeyTick['pk|DEEP'], 18), '0.000000000000000003');
        assert.strictEqual(db.util.bcformat(snap.totalByTick['DEEP'], 18), '0.000000000000000003');
    });
});

describe('slashContractStake precision @regression @tier1', function () {

    it('slashes an 18-dp contract stake without truncating the residual', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(18);
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            calls.push({ sql });
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))
                return [{ action_index: 7, amount: '2.000000000000000009' }];
            return []; // contract_unstakes select, UPDATEs, slash-debit insert
        });

        const slashed = await db.slashContractStake(1, 10, 20, '1.000000000000000005', 306);

        // Old 8-dp math floored the deduction; the residual + slashed total must be exact.
        assert.strictEqual(db.util.bcformat(slashed, 18), '1.000000000000000005');
        const upd = calls.find(c => /UPDATE\s+contract_stakes/i.test(c.sql));
        assert.ok(upd, 'residual write ran');
    });

    it('widens the positivity filter so sub-1e-8 contract stakes stay slashable', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(18);
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql) => { calls.push({ sql }); return []; });

        await db.slashContractStake(1, 10, 20, '0.000000000000000001', 306);

        const pass1 = calls.find(c => /SELECT[\s\S]*FROM\s+contract_stakes/i.test(c.sql));
        assert.ok(pass1, 'Pass 1 select ran');
        assert.ok(/DECIMAL\(60,18\)/.test(pass1.sql), 'positivity filter must not truncate at 8 dp');
    });
});
