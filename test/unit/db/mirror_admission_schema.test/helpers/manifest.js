/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 **********************************************************************
 * The mirror-admission SCHEMA MANIFEST: the one statement of which admission
 * columns the hub-DB mirror carries, in which tables, with which definition and
 * at which position. It is the seam between the barrier-family rows that meet
 * at the schema: the indexer migration (family row 7), the explorer re-vendor
 * behind the v7 bump (row 8), and the replay witness (row 11).
 *
 * WHY A MANIFEST AND NOT THE HUB DDL ITSELF. The hub DDL is the producer's shape
 * and the byte source, but two of its facts are not visible from the DDL alone:
 * which columns a producer actually WRITES (anchor_reward_attestations carries
 * admit_block_btc in the hub DDL and its JS migration helper, yet db/anchor.js
 * inserts without it and no indexer reader binds on it), and where the indexer
 * twin must place each column so SHOW CREATE TABLE converges on a migrated and a
 * fresh install alike (the column-parity guard checks POSITION, not just shape).
 * The manifest states both, and mirror_admission_schema.test.js pins the manifest
 * against the hub DDL and the hub's migrateAdmissionColumns table map so the two
 * cannot drift apart silently.
 *
 * Derived 2026-09-16 from xchain-hub origin/develop 6d5b7301 (src/sql/*.sql and
 * src/db/schema/columns.js) against xchain-indexer origin/develop aca3678f: every
 * AFTER anchor below exists in the indexer twin. Most blocks land at the hub's own
 * position; three (cross_chain_matches, cross_chain_calls, price_snapshots) do not,
 * because their hub anchor is already claimed there by an earlier indexer-only
 * migration (finalizing_view AFTER effective_time; batch_block_time AFTER
 * push_generation), so those three carry a separate hubAfter for the hub-side
 * comparison while after names the indexer twin's own, later position.
 ********************************************************************/

'use strict';

const path = require('path');

// The one definition every admission column carries. Nullable with no default so a
// legacy row (finalized below the producer activation, or whose map never named this
// chain) reads NULL and binds by effective_time at every height (C28, C33).
const ADMISSION_COLUMN_DDL = 'BIGINT UNSIGNED DEFAULT NULL';

// The dated indexer migration row 7 writes, its mode tag, and where it lives. Dated
// filenames are enforced by the runner; mode=auto because every statement is an
// additive ADD COLUMN IF NOT EXISTS that is a no-op once the boot-time drift healer
// has already converged the column in from src/sql.
const MIGRATION_FILE = '2026-09-16-admission-height.sql';
const MIGRATION_MODE = 'auto';
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'src', 'sql', 'migrations');

// table -> { columns (in DDL order), after (the indexer twin column the block follows),
// hubAfter (the hub DDL column the block follows, only when it differs from after) }.
//
// Seven tables, not the frontier's six: oracle_prices is the unsigned rail of R5 (a)
// and B13 and takes ONE unqualified column keyed on its publishing chain. The five
// mapped rails take the three federation chains in the fixed order btc, ltc, doge;
// attestation_responses is BTC-only by the indexer's own call-site guard.
const MIRROR_ADMISSION_COLUMNS = Object.freeze({
    attestation_responses: Object.freeze({ columns: Object.freeze(['admit_block_btc']),                                       after: 'effective_time' }),
    cross_chain_matches:   Object.freeze({ columns: Object.freeze(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']), after: 'finalizing_view',  hubAfter: 'effective_time' }),
    cross_chain_calls:     Object.freeze({ columns: Object.freeze(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']), after: 'finalizing_view',  hubAfter: 'effective_time' }),
    bridge_transfers:      Object.freeze({ columns: Object.freeze(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']), after: 'effective_time' }),
    policy_snapshots:      Object.freeze({ columns: Object.freeze(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']), after: 'network' }),
    price_snapshots:       Object.freeze({ columns: Object.freeze(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']), after: 'batch_block_time', hubAfter: 'push_generation' }),
    oracle_prices:         Object.freeze({ columns: Object.freeze(['admit_block']),                                           after: 'push_generation' }),
});

// Admission columns the HUB DDL declares that the mirror contract does NOT carry to the
// indexer, each with the measured reason. Declared rather than omitted so the hub-DDL
// comparison in the test is exact: a hub column that gains a writer or a reader later
// has to move OUT of this list into the manifest above, never drift in silence.
const HUB_ONLY_ADMISSION_COLUMNS = Object.freeze({
    // Added by row 2 for uniformity, migrated by migrateAdmissionColumns, but db/anchor.js
    // inserts the row WITHOUT it and the indexer's anchor-attest member keys on the row's
    // own snapshot_block plus ANCHOR_REWARD_MIRROR_MATURITY (144), never on this column
    // (family section 5.7: "its admission height already exists").
    anchor_reward_attestations: Object.freeze(['admit_block_btc']),
});

// Every table name the manifest carries, in the order the migration and the compat gate
// list them, so two consumers that both enumerate the manifest agree on the order.
const MIRROR_ADMISSION_TABLES = Object.freeze(Object.keys(MIRROR_ADMISSION_COLUMNS));

/**
 * The column lines of one CREATE TABLE body, in source order, from comment-stripped
 * DDL text. Keys, indexes and the table tail are skipped. Each entry is
 * { name, definition } with the definition whitespace-collapsed and upper-cased.
 */
function parseColumns(strippedSql){
    const out = [];
    for(const line of String(strippedSql).split('\n')){
        const m = /^\s*`?([a-z_][a-z0-9_]*)`?\s+([A-Za-z][^,\n]*?)\s*,?\s*$/.exec(line);
        if(!m) continue;
        const name = m[1].toLowerCase();
        if(['key', 'unique', 'primary', 'constraint', 'index', 'create', 'engine'].includes(name)) continue;
        out.push({ name, definition: m[2].replace(/\s+/g, ' ').trim().toUpperCase() });
    }
    return out;
}

/** The admission columns (name starts with admit_block) of one parsed column list. */
function admissionColumnsOf(columns){
    return columns.filter(c => c.name.startsWith('admit_block'));
}

/**
 * The ALTER statements the dated indexer migration carries, one per table, generated
 * from the manifest so the file row 7 writes and the contract the tests check are the
 * same bytes. Each column is anchored with AFTER on the previous one so the migrated
 * position equals the definition's (the column-parity guard compares position).
 */
function migrationStatements(manifest){
    const m = manifest || MIRROR_ADMISSION_COLUMNS;
    return Object.keys(m).map(table => {
        let prev = m[table].after;
        const clauses = m[table].columns.map(col => {
            const clause = '  ADD COLUMN IF NOT EXISTS ' + col + ' ' + ADMISSION_COLUMN_DDL + ' AFTER ' + prev;
            prev = col;
            return clause;
        });
        return 'ALTER TABLE ' + table + '\n' + clauses.join(',\n') + ';';
    });
}

/**
 * The tables bin/check-migration-old-code-compat.js must carry an OLD_STATEMENTS entry
 * for once the migration exists: every table the migration writes, because an unlisted
 * affected table fails that gate rather than skipping.
 */
function compatGateTables(manifest){
    return Object.keys(manifest || MIRROR_ADMISSION_COLUMNS);
}

module.exports = {
    ADMISSION_COLUMN_DDL,
    MIGRATION_FILE,
    MIGRATION_MODE,
    MIGRATIONS_DIR,
    MIRROR_ADMISSION_COLUMNS,
    HUB_ONLY_ADMISSION_COLUMNS,
    MIRROR_ADMISSION_TABLES,
    parseColumns,
    admissionColumnsOf,
    migrationStatements,
    compatGateTables,
};
