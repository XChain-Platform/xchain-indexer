/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/rollback-coverage.test.js
 *
 * Rollback coverage guard.
 *
 * Every table the indexer owns is defined by a file in src/sql/ — that is the
 * exact set verifyTables() creates (table name = filename minus ".sql"). On a
 * chain reorg, Rollback.rollback() must do *something* deliberate with each of
 * those tables, or rows written in the orphaned block range survive and the
 * indexer DB silently diverges from chain truth (and from other validators).
 *
 * Historically tables shipped before they were wired into the rollback set —
 * e.g. gated_files (table 2026-05-22, rollback 2026-05-28, a 6-day window) and
 * slash_events (2-day window). Invisible on regtest; silent corruption on
 * mainnet. This test closes the *class*: a new src/sql/<table>.sql that nobody
 * classifies fails here instead of shipping.
 *
 * To satisfy this test, a new table must land in exactly one of these buckets:
 *   - dataTables   — deleted by `action_index >= ?`  (per-action rows)
 *   - blockTables  — deleted by `block_index >= ?`   (per-block rows)
 *   - RECOMPUTED   — not deleted by index; fully rebuilt during rollback()
 *   - SPECIAL_CASE — deleted by bespoke logic in rollback() (cascades, etc.)
 *   - ROLLBACK_EXEMPT — intentionally never rolled back (must carry a reason)
 *   - the `index_` prefix — append-only, id-keyed dedup lookups; orphaned rows
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
// inside rollback() (updateBalances / updateTokens / updateMarkets /
// updateContractBalances; attest_validator_stats via
// _recomputeAttestationValidatorStats — drops rows last touched in the orphaned
// range, then rebuilds them from surviving signatures + expired requests).
// `tokens` is ALSO in dataTables — listing it here is harmless; coverage is a
// union, not a partition.
const RECOMPUTED = ['balances', 'tokens', 'markets', 'contract_balances', 'attest_validator_stats'];

// Tables deleted by bespoke logic in rollback() rather than the generic loops.
// contract_emissions is cascade-deleted via its contract_executions parent.
// price_snapshots anchors rounds via reference_block (not block_index), so it
// gets its own delete (`reference_block >= ?`) outside the blockTables loop.
// icons is a token_id-keyed metadata cache with no action_index/block_index and
// no enforced FK, so after the dataTables loop deletes a token it gets a bespoke
// orphan sweep (`token_id NOT IN (SELECT id FROM tokens)`).
const SPECIAL_CASE = ['contract_emissions', 'price_snapshots', 'icons'];

// Tables intentionally never rolled back. Every entry MUST state why, and is
// asserted below to actually exist (so this list can't rot with stale names).
const ROLLBACK_EXEMPT = {
    events:
        'Append-only operational audit log — it records the REORG event itself. ' +
        'Rolling it back would erase the evidence of the rollback.',
    pubkeys:
        'Idempotent address_id → pubkey registry (createPubkey: INSERT IGNORE, ' +
        'address_id PRIMARY KEY). Content-addressed — a given address always has ' +
        'the same pubkey — and keyed on the append-only address registry (stable ' +
        'ids), so a row surviving a reorg is harmless: re-applying the same blocks ' +
        're-inserts it as a no-op. Never block-height state, so nothing to undo.',
    cross_chain_matches:
        'Hub-mirrored cross-chain DEX state (CROSS_CHAIN_TABLES in hub_db_sync.js), ' +
        'NOT produced by local block/action processing — the indexer only SELECTs it. ' +
        'It is synced from the hub via a monotonic `id` cursor and retracted on the ' +
        'mirror side by hub_db_sync._applyRetraction (DELETE … WHERE a_/b_action_index ' +
        '>= the orphaned point, two-sided). Block replay does not re-pull it, so the ' +
        'chain-reorg path must leave its lifecycle to the hub mirror, not delete by index.',
    capability_snapshots:
        'Hub-mirrored, immutable block-boundary capability snapshots (CROSS_CHAIN_TABLES ' +
        'in hub_db_sync.js): one row per pubkey that qualified for a capability at a ' +
        'BTC-anchored snapshot_block, synced from the hub via an `id` cursor and never ' +
        'retracted (immutable history). The indexer only SELECTs it to verify match ' +
        'signatures; block replay does not recreate it, so the chain-reorg path must ' +
        'not delete it.',
    state_checkpoints:
        'Hub-mirrored, quorum-signed state checkpoints (hub_db_sync.js), NOT produced ' +
        'by local block/action processing — the indexer only SELECTs it for the ' +
        'explorer/SDK verification APIs. Synced from the hub via an `id` cursor and ' +
        'never retracted (a reorged height is superseded by a re-broadcast row with a ' +
        'higher checkpoint_seq). Block replay does not recreate it, so the chain-reorg ' +
        'path must not delete it. (The on-chain ANCHOR record, anchor_actions, IS ' +
        'action-indexed and rolls back normally as a dataTable.)',
};

// Convention: append-only, id-keyed dedup lookups. Orphaned rows are inert
// because data tables reference them only by id.
const isLookupTable = (t) => t.startsWith('index_');

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
        const dangling = [...rollback.dataTables, ...rollback.blockTables]
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
                  `Pick one — a row has one or the other, and a double delete signals a modelling mistake.`
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
});
