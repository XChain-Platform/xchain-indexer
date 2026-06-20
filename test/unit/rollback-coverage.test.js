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
 * test/unit/rollback-coverage.test.js
 *
 * Rollback coverage guard.
 *
 * Every table the indexer owns is defined by a file in src/sql/ (that is the
 * exact set verifyTables() creates (table name = filename minus ".sql"). On a
 * chain reorg, Rollback.rollback() must do *something* deliberate with each of
 * those tables, or rows written in the orphaned block range survive and the
 * indexer DB silently diverges from chain truth (and from other validators).
 *
 * Historically tables shipped before they were wired into the rollback set.
 * e.g. gated_files (table 2026-05-22, rollback 2026-05-28, a 6-day window) and
 * slash_events (2-day window). Invisible on regtest; silent corruption on
 * mainnet. This test closes the *class*: a new src/sql/<table>.sql that nobody
 * classifies fails here instead of shipping.
 *
 * To satisfy this test, a new table must land in exactly one of these buckets:
 *   - dataTables   - deleted by `action_index >= ?`  (per-action rows)
 *   - blockTables  - deleted by `block_index >= ?`   (per-block rows)
 *   - RECOMPUTED   - not deleted by index; fully rebuilt during rollback()
 *   - SPECIAL_CASE - deleted by bespoke logic in rollback() (cascades, etc.)
 *   - ROLLBACK_EXEMPT - intentionally never rolled back (must carry a reason)
 *   - the `index_` prefix - append-only, id-keyed dedup lookups; orphaned rows
 *     are harmless because they are only ever referenced by id.
 *
 * Pick the bucket by understanding the table, not by silencing the test.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const Rollback              = require('../../src/rollback.js');

// ---------------------------------------------------------------------------
// The universe: every table the indexer creates, straight from src/sql/.
// Mirrors db.js verifyTables() exactly (all *.sql, name = filename minus .sql).
// ---------------------------------------------------------------------------
const SQL_DIR = path.join(__dirname, '../../src/sql');
const UNIVERSE = fs.readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => f.slice(0, -'.sql'.length))
    .sort();

// ---------------------------------------------------------------------------
// Coverage buckets that live outside rollback.js's two table arrays.
// ---------------------------------------------------------------------------

// Tables not deleted by index but fully recomputed from surviving ledger rows
// inside rollback() (updateBalances / updateTokens / updateMarkets;
// attest_validator_stats via
// _recomputeAttestationValidatorStats: drops rows last touched in the orphaned
// range, then rebuilds them from surviving signatures + expired requests).
// `tokens` is ALSO in dataTables; listing it here is harmless, as coverage is a
// union, not a partition.
const RECOMPUTED = ['balances', 'tokens', 'markets', 'attest_validator_stats'];

// Tables deleted by bespoke logic in rollback() rather than the generic loops.
// contract_emissions is cascade-deleted via its contract_executions parent.
// price_snapshots anchors rounds via reference_block (not block_index), so it
// gets its own delete (`reference_block >= ?`) outside the blockTables loop.
//
// Orphan sweeps (icons, balances, markets, pubkeys): derived/cache tables keyed
// by a rolled-back index id (index_addresses / index_tickers / tokens) but NOT
// removed by the action_index / block_index delete loops. After the index-table
// delete, an entity seen ONLY in the orphaned range leaves a dangling-ref row;
// each gets a bespoke `<fk> NOT IN (SELECT id FROM <index>)` sweep so the reorged
// node matches a from-genesis one. balances/markets are ALSO recomputed (surviving
// rows) but the recompute cannot reach an orphaned-only row, so the sweep is the
// orphan handler; pubkeys is sweep-only. The sweep DELETEs are asserted to exist
// below so this classification cannot rot away from the source.
const SPECIAL_CASE = ['contract_emissions', 'price_snapshots',
    'icons', 'balances', 'markets', 'pubkeys'];

// The orphan-sweep tables and the index they dangle against (asserted present in
// rollback.js source below). icons keys on tokens; the rest on the two rolled-back
// index_* tables. Mirrors xchain-indexer/src/rollback.js (and xchain-sync's
// ClientRollback for markets/pubkeys).
const ORPHAN_SWEEPS = [
    { table: 'icons',    index: 'tokens' },
    { table: 'balances', index: 'index_addresses' },
    { table: 'balances', index: 'index_tickers' },
    { table: 'markets',  index: 'index_tickers' },
    { table: 'pubkeys',  index: 'index_addresses' },
];

// Tables intentionally never rolled back. Every entry MUST state why, and is
// asserted below to actually exist (so this list can't rot with stale names).
const ROLLBACK_EXEMPT = {
    events:
        'Append-only operational audit log; it records the REORG event itself. ' +
        'Rolling it back would erase the evidence of the rollback.',
    // NOTE: pubkeys was here ("a row surviving a reorg is harmless") until the wire
    // ^<id> work made index_addresses ids reorg-reproducible. A reclaimed address_id
    // then re-points the surviving pubkeys row at a DIFFERENT address (INSERT IGNORE
    // keeps the old pubkey), so it is no longer harmless: it is now orphan-swept (see
    // SPECIAL_CASE / ORPHAN_SWEEPS).
    cross_chain_matches:
        'Hub-mirrored cross-chain DEX state (CROSS_CHAIN_TABLES in hub_db_sync.js), ' +
        'NOT produced by local block/action processing; the indexer only SELECTs it. ' +
        'It is synced from the hub via a monotonic `id` cursor and retracted on the ' +
        'mirror side by hub_db_sync._applyRetraction (DELETE … WHERE a_/b_action_index ' +
        '>= the orphaned point, two-sided). Block replay does not re-pull it, so the ' +
        'chain-reorg path must leave its lifecycle to the hub mirror, not delete by index.',
    cross_chain_calls:
        'Hub-mirrored cross-chain contract call relay rows (CROSS_CHAIN_TABLES in ' +
        'hub_db_sync.js), NOT produced by local block/action processing; the indexer ' +
        'only SELECTs it (XEXEC injection / result-callback passes). Synced from the ' +
        'hub via a monotonic `id` cursor (also the deterministic injection-order key); ' +
        'source-chain reorgs are handled mirror-side by hub_db_sync._applyRetraction ' +
        '(DELETE … WHERE source_action_index >= the orphaned point). The LOCAL side ' +
        'effects (xcalls, cross_chain_call_executions, cross_chain_call_callbacks) ARE ' +
        'dataTables and roll back normally.',
    oracle_prices:
        'Hub-mirrored user-published PRICE v1 oracle rows (hub_db_sync.js), NOT produced ' +
        'by local block/action processing; the indexer only SELECTs it (fee/oracle price ' +
        'reads). action_index in this table refers to the row\'s SOURCE chain, which is ' +
        'usually a DIFFERENT chain from the one this indexer reorgs, so deleting by local ' +
        'block height would corrupt the mirror. Synced from the hub via an `id` cursor; ' +
        'source-chain reorgs are handled mirror-side by hub_db_sync (pushpricereorg rail).',
    capability_snapshots:
        'Hub-mirrored, immutable block-boundary capability snapshots (CROSS_CHAIN_TABLES ' +
        'in hub_db_sync.js): one row per pubkey that qualified for a capability at a ' +
        'BTC-anchored snapshot_block, synced from the hub via an `id` cursor and never ' +
        'retracted (immutable history). The indexer only SELECTs it to verify match ' +
        'signatures; block replay does not recreate it, so the chain-reorg path must ' +
        'not delete it.',
    state_checkpoints:
        'Hub-mirrored, quorum-signed state checkpoints (hub_db_sync.js), NOT produced ' +
        'by local block/action processing; the indexer only SELECTs it for the ' +
        'explorer/SDK verification APIs. Synced from the hub via an `id` cursor and ' +
        'never retracted (a reorged height is superseded by a re-broadcast row with a ' +
        'higher checkpoint_seq). Block replay does not recreate it, so the chain-reorg ' +
        'path must not delete it. (The on-chain ANCHOR record, anchor_actions, IS ' +
        'action-indexed and rolls back normally as a dataTable.)',
    state_tree_nodes:
        'Content-addressed, copy-on-write SMT node store for the light-client state ' +
        'commitment (SPV spec §4.3). Nodes are keyed by their own hash, so a node that ' +
        'survives a reorg is harmless: re-applying the new chain INSERT-IGNOREs the same ' +
        'hashes (no-op) and the surviving fork-point root in state_tree_roots (which IS ' +
        'block-indexed and rolls back) anchors the correct tree. Orphaned nodes become ' +
        'unreferenced garbage that a later mark-and-sweep pruner reclaims; deleting them ' +
        'by block height is both unnecessary and impossible (a node carries no block_index, ' +
        'and the same node may be shared by surviving blocks).',
};

// Convention: append-only, id-keyed dedup lookups. Orphaned rows are inert
// because data tables reference them only by id. EXCEPTION: index_addresses and
// index_tickers can be named by a wire ^<id> reference, so their ids ARE
// consensus-relevant and they are rolled back (rollback.indexTables); they must be
// asserted as covered, not silently exempted as inert lookups.
const ROLLED_BACK_INDEX = ['index_addresses', 'index_tickers'];
const isLookupTable = (t) => t.startsWith('index_') && !ROLLED_BACK_INDEX.includes(t);

// ---------------------------------------------------------------------------

describe('Rollback coverage guard @regression', function () {
    let rollback;

    before(function () {
        const indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
    });

    it('sanity: src/sql contains a meaningful number of tables', function () {
        // Guards against a path/glob regression silently emptying the universe
        // and making every coverage assertion below vacuously pass.
        assert.ok(UNIVERSE.length > 50, `expected >50 tables in src/sql, found ${UNIVERSE.length}`);
    });

    it('every table the indexer owns is covered by the rollback strategy', function () {
        const covered = new Set([
            ...rollback.dataTables,
            ...rollback.blockTables,
            ...rollback.indexTables,
            ...RECOMPUTED,
            ...SPECIAL_CASE,
            ...Object.keys(ROLLBACK_EXEMPT),
        ]);

        const uncovered = UNIVERSE.filter(t => !covered.has(t) && !isLookupTable(t));

        assert.deepStrictEqual(
            uncovered,
            [],
            uncovered.length
                ? `\n\nThese src/sql tables are written by the indexer but NOT handled on reorg:\n` +
                  uncovered.map(t => `    - ${t}`).join('\n') +
                  `\n\nRows in these tables would survive a rollback and silently diverge from\n` +
                  `chain truth. Classify each into one of: dataTables / blockTables (rollback.js),\n` +
                  `RECOMPUTED / SPECIAL_CASE / ROLLBACK_EXEMPT (rollback-coverage.test.js).\n` +
                  `See the header of this file for what each bucket means.\n`
                : undefined
        );
    });

    it('every rollback.js table reference points at a real src/sql table (no stale/renamed names)', function () {
        const universeSet = new Set(UNIVERSE);
        const dangling = [...rollback.dataTables, ...rollback.blockTables, ...rollback.indexTables]
            .filter(t => !universeSet.has(t));

        assert.deepStrictEqual(
            dangling,
            [],
            dangling.length
                ? `rollback.js deletes from tables with no src/sql definition (typo or dropped table): ${dangling.join(', ')}. ` +
                  `A DELETE against a nonexistent table will throw and abort the whole rollback.`
                : undefined
        );
    });

    it('a table is never in both dataTables and blockTables', function () {
        const inBoth = rollback.dataTables.filter(t => rollback.blockTables.includes(t));
        assert.deepStrictEqual(
            inBoth,
            [],
            inBoth.length
                ? `Tables keyed by BOTH action_index and block_index deletes: ${inBoth.join(', ')}. ` +
                  `Pick one: a row has one or the other, and a double delete signals a modelling mistake.`
                : undefined
        );
    });

    it('every ROLLBACK_EXEMPT entry names a real table (the exempt list cannot rot)', function () {
        const universeSet = new Set(UNIVERSE);
        const stale = Object.keys(ROLLBACK_EXEMPT).filter(t => !universeSet.has(t));
        assert.deepStrictEqual(
            stale,
            [],
            stale.length
                ? `ROLLBACK_EXEMPT names tables that no longer exist in src/sql: ${stale.join(', ')}. Remove them.`
                : undefined
        );
    });

    it('every orphan-sweep DELETE classified in SPECIAL_CASE actually exists in rollback.js', function () {
        // A derived/cache table that dangles after the index-table delete is only
        // covered if rollback.js actually sweeps it. Without this, the SPECIAL_CASE
        // classification could silently outlive a removed sweep (the very failure
        // that re-opened the orphaned-only-address zombie balance), so assert the
        // `DELETE FROM <table> ... NOT IN (SELECT id FROM <index>)` is present in source.
        const src = fs.readFileSync(path.join(__dirname, '../../src/rollback.js'), 'utf8');
        const missing = ORPHAN_SWEEPS.filter(({ table, index }) => {
            const re = new RegExp(`DELETE\\s+FROM\\s+${table}\\b[\\s\\S]{0,400}?SELECT\\s+id\\s+FROM\\s+${index}\\b`, 'i');
            return !re.test(src);
        }).map(({ table, index }) => `${table} (NOT IN ${index})`);

        assert.deepStrictEqual(
            missing,
            [],
            missing.length
                ? `rollback.js is missing orphan-sweep DELETE(s): ${missing.join(', ')}. ` +
                  `These tables reference a rolled-back index id but are not action/block deleted, ` +
                  `so without the sweep an orphaned-only entity leaves a dangling-ref row that ` +
                  `diverges from a from-genesis node (zombie balance -> sanityCheck halt; ` +
                  `markets/pubkeys mis-association on id reuse). Restore the sweep or re-justify ` +
                  `the SPECIAL_CASE entry.`
                : undefined
        );
    });
});
