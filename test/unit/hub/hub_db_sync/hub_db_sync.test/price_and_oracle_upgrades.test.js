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

function registerPriceOracleUpgradeGroup1(PS_COLS, makeApplySync, finalizedRow) { it('uses an ON DUPLICATE KEY UPDATE upsert (not INSERT IGNORE) for price_snapshots', async function () {
        const { sync, doQuery } = makeApplySync(PS_COLS);
        await sync._applyRow('price_snapshots', finalizedRow());
        const insert = doQuery.getCalls().find(c => /price_snapshots/.test(c.args[0]) && /INSERT/.test(c.args[0]));
        assert.ok(insert, 'an INSERT must run');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(insert.args[0]), 'must be an upsert');
        assert.ok(!/^INSERT IGNORE/.test(insert.args[0]), 'must NOT be a plain INSERT IGNORE');
    }); }

function registerPriceOracleUpgradeGroup2(PS_COLS, makeApplySync, finalizedRow) { it('guards every column on VALUES(status)=finalized and never reassigns the unique-key columns', async function () {
        const { sync, doQuery } = makeApplySync(PS_COLS);
        await sync._applyRow('price_snapshots', finalizedRow());
        const sql = doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0])).args[0];
        // price upgrades only when the incoming row is finalized
        assert.ok(/`price` = IF\(VALUES\(status\) = 'finalized', VALUES\(`price`\), `price`\)/.test(sql));
        // status flips to finalized only for an incoming finalized row
        assert.ok(/status = IF\(VALUES\(status\) = 'finalized', 'finalized', status\)/.test(sql));
        // the unique key + PK are never reassigned in the UPDATE clause
        const updateClause = sql.split('ON DUPLICATE KEY UPDATE')[1];
        assert.ok(!/`round_number` =/.test(updateClause));
        assert.ok(!/`coin_pair` =/.test(updateClause));
        assert.ok(!/`id` =/.test(updateClause));
    }); }

function registerPriceOracleUpgradeGroup3(PS_COLS, makeApplySync, finalizedRow) { it('still filters hub-only columns the local mirror does not carry', async function () {
        const { sync, doQuery } = makeApplySync(['round_number', 'coin_pair', 'price', 'status']);
        let row = finalizedRow();
        row.hub_only_audit = 'xyz';
        await sync._applyRow('price_snapshots', row);
        const sql = doQuery.getCalls().find(c => /INSERT/.test(c.args[0])).args[0];
        assert.ok(!sql.includes('hub_only_audit'), 'unknown column dropped');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(sql));
    }); }

function registerPriceOracleUpgradeGroup4(PS_COLS, makeApplySync, finalizedRow) { it('falls back to INSERT IGNORE if the row carries no status column', async function () {
        const { sync, doQuery } = makeApplySync(['round_number', 'coin_pair']);
        await sync._applyRow('price_snapshots', { round_number: 5, coin_pair: 'BTC/USD' });
        const insert = doQuery.getCalls().find(c => /INSERT/.test(c.args[0]));
        assert.ok(/^INSERT IGNORE/.test(insert.args[0]), 'no status → plain idempotent insert');
    }); }

describe('HubDbSync _applyRow price_snapshots skipped→finalized upgrade @regression @tier2', function () {

    // The hub upserts a 'skipped' placeholder round to 'finalized' when a peer
    // chain salvages it (PriceAggregator.receiveValidatedRound) and broadcasts the
    // row. A plain INSERT IGNORE on the mirror would drop that upgrade and strand
    // the replica at price=NULL. _applyRow must upgrade in place, keyed on the
    // INCOMING status, and never clobber an already-finalized local row.

    const PS_COLS = ['id', 'round_number', 'coin_pair', 'price', 'reference_block',
                     'reference_chain', 'block_timestamp', 'validator_count',
                     'consensus_round', 'consensus_proof', 'status', 'source_chain',
                     'source_action_index', 'created_at'];

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    function finalizedRow() {
        return { id: 100, round_number: 5, coin_pair: 'BTC/USD', price: '50000',
                 reference_block: 800000, reference_chain: 'BTC', block_timestamp: 1700000000,
                 validator_count: 3, consensus_round: 1, consensus_proof: '[]',
                 status: 'finalized', source_chain: 'DOGE', source_action_index: 42,
                 created_at: '2026-06-14 00:00:00' };
    }

    registerPriceOracleUpgradeGroup1(PS_COLS, makeApplySync, finalizedRow);
    registerPriceOracleUpgradeGroup2(PS_COLS, makeApplySync, finalizedRow);

    registerPriceOracleUpgradeGroup3(PS_COLS, makeApplySync, finalizedRow);
    registerPriceOracleUpgradeGroup4(PS_COLS, makeApplySync, finalizedRow);
});

function registerPriceOracleUpgradeGroup5(OP_COLS, makeApplySync, oracleRow) { it('uses an ON DUPLICATE KEY UPDATE upsert (not INSERT IGNORE) for oracle_prices', async function () {
        const { sync, doQuery } = makeApplySync(OP_COLS);
        await sync._applyRow('oracle_prices', oracleRow(1));
        const insert = doQuery.getCalls().find(c => /oracle_prices/.test(c.args[0]) && /INSERT/.test(c.args[0]));
        assert.ok(insert, 'an INSERT must run');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(insert.args[0]), 'must be an upsert');
        assert.ok(!/^INSERT IGNORE/.test(insert.args[0]), 'must NOT be a plain INSERT IGNORE');
    }); }

function registerPriceOracleUpgradeGroup6(OP_COLS, makeApplySync, oracleRow) { it('guards every column on VALUES(push_generation) >= push_generation and never reassigns the unique-key columns', async function () {
        const { sync, doQuery } = makeApplySync(OP_COLS);
        await sync._applyRow('oracle_prices', oracleRow(1));
        const sql = doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0])).args[0];
        // a payload column upgrades only when the incoming generation wins
        assert.ok(/`value` = IF\(VALUES\(`push_generation`\) >= `push_generation`, VALUES\(`value`\), `value`\)/.test(sql));
        // push_generation itself is lifted on the same condition
        assert.ok(/push_generation = IF\(VALUES\(`push_generation`\) >= `push_generation`, VALUES\(`push_generation`\), `push_generation`\)/.test(sql));
        // the unique key (source_chain, action_index) + PK id are never reassigned
        const updateClause = sql.split('ON DUPLICATE KEY UPDATE')[1];
        assert.ok(!/`source_chain` =/.test(updateClause));
        assert.ok(!/`action_index` =/.test(updateClause));
        assert.ok(!/`id` =/.test(updateClause));
    }); }

function registerPriceOracleUpgradeGroup7(OP_COLS, makeApplySync, oracleRow) { it('still filters hub-only columns the local mirror does not carry', async function () {
        const { sync, doQuery } = makeApplySync(['source_chain', 'action_index', 'value', 'push_generation']);
        let row = oracleRow(2);
        row.hub_only_audit = 'xyz';
        await sync._applyRow('oracle_prices', row);
        const sql = doQuery.getCalls().find(c => /INSERT/.test(c.args[0])).args[0];
        assert.ok(!sql.includes('hub_only_audit'), 'unknown column dropped');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(sql));
    }); }

function registerPriceOracleUpgradeGroup8(OP_COLS, makeApplySync, oracleRow) { it('falls back to INSERT IGNORE if the row carries no push_generation column', async function () {
        const { sync, doQuery } = makeApplySync(['source_chain', 'action_index', 'value']);
        await sync._applyRow('oracle_prices', { source_chain: 'LTC', action_index: 42, value: '1.23' });
        const insert = doQuery.getCalls().find(c => /INSERT/.test(c.args[0]));
        assert.ok(/^INSERT IGNORE/.test(insert.args[0]), 'no push_generation → plain idempotent insert');
    }); }

describe('HubDbSync _applyRow oracle_prices generation upgrade @regression @tier2', function () {

    // A source-chain reorg re-mines a PRICE at a RECYCLED action_index (getNextActionIndex
    // assigns MAX+1 over survivors) and re-publishes it with a BUMPED push_generation. A
    // plain INSERT IGNORE on the mirror would no-op against the stale lower-generation row,
    // leaving push_generation old, so the generation-fenced retraction (push_generation <=
    // pre-bump) then deletes the freshly re-published row and the price goes permanently
    // missing on this replica. _applyRow must upgrade in place keyed on push_generation,
    // mirroring the price_snapshots / cross_chain_calls upgrade paths.

    const OP_COLS = ['id', 'source_chain', 'action_index', 'coin', 'tick', 'fiat',
                     'value', 'push_generation', 'created_at'];

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    function oracleRow(gen) {
        return { id: 7, source_chain: 'LTC', action_index: 42, coin: 'LTC', tick: 'XCP',
                 fiat: 'USD', value: '1.23', push_generation: gen, created_at: '2026-06-25 00:00:00' };
    }

    registerPriceOracleUpgradeGroup5(OP_COLS, makeApplySync, oracleRow);
    registerPriceOracleUpgradeGroup6(OP_COLS, makeApplySync, oracleRow);

    registerPriceOracleUpgradeGroup7(OP_COLS, makeApplySync, oracleRow);
    registerPriceOracleUpgradeGroup8(OP_COLS, makeApplySync, oracleRow);
});
