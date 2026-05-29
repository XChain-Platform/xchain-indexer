/**
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
// updateContractBalances). `tokens` is ALSO in dataTables — listing it here is
// harmless; coverage is a union, not a partition.
const RECOMPUTED = ['balances', 'tokens', 'markets', 'contract_balances'];

// Tables deleted by bespoke logic in rollback() rather than the generic loops.
// contract_emissions is cascade-deleted via its contract_executions parent.
const SPECIAL_CASE = ['contract_emissions'];

// Tables intentionally never rolled back. Every entry MUST state why, and is
// asserted below to actually exist (so this list can't rot with stale names).
const ROLLBACK_EXEMPT = {
    events:
        'Append-only operational audit log — it records the REORG event itself. ' +
        'Rolling it back would erase the evidence of the rollback.',
    attestation_validator_stats:
        'Monotone counter table (fulfilled/missed/slashed counts). A blanket ' +
        'delete would drop earlier increments that should survive; correct ' +
        'rollback needs a recompute pass against attestation_responses. ' +
        'Deliberately deferred — see db.js incrementAttestationValidatorStat(). ' +
        'MUST be resolved before slashed_count/quality_score drive live slashing.',
    icons:
        'TIS icon dedup lookup; not populated on the per-action indexing path.',
    price_snapshots:
        'Price-round cache owned by xchain-hub; the indexer has no write path to it.',
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
