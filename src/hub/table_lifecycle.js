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
 *
 * XChain Indexer - Table Lifecycle Registry
 *
 * Single source of truth for what happens to every indexer-DB table across
 * the three consensus-critical lifecycle artifacts that were previously
 * maintained by hand in separate places (and drifted, e.g. the VOTE tables
 * shipping unreplicated and unrolled-back):
 *
 *   1. REPLICATION  - how (and whether) xchain-sync delivers the table to
 *                     followers. Generates the per-block stream topology
 *                     (xchain-sync/src/schema/replicated_tables.js TOPOLOGY.indexer).
 *   2. ROLLBACK     - how a chain reorg unwinds the table, on the source
 *                     indexer (src/rollback/index.js) and on every replica
 *                     (xchain-sync/src/client/rollback.js). Generates both
 *                     sets of generic delete lists.
 *   3. HASH COVERAGE- which integrity hash (if any) would catch a divergence
 *                     in the table. Declarative: guards in
 *                     test/unit/hub/hash_coverage.test.js bind the declarations
 *                     to the actual hashing code.
 *
 * A fourth artifact, the advisory TABLE_CONTENT_PARITY_CHECK coverage set,
 * is DERIVED from those three rather than declared per entry: see
 * the CONTENT_PARITY_* block below the registry.
 *
 * Adding a table: create src/sql/<table>.sql, then add ONE entry to the
 * registry parts under table_lifecycle/ declaring all three dimensions.
 * test/unit/rollback/rollback_coverage.test.js fails until the entry exists, and the
 * per-dimension guards fail until the entry matches reality. Classify by
 * understanding the table, not by silencing the tests.
 *
 * BYTE-ALIGNED TWIN: copied verbatim, with its table_lifecycle/ parts, into
 * xchain-sync/src/table_lifecycle.js (sync has no dependency on this package
 * by design; same convention as state_hash.js / merkle.js). Edit here, then
 * `cp` to the twin; the sync rollback-coverage suite asserts byte-identity.
 *
 * Entry fields:
 *   table       table name (src/sql/<table>.sql for owner 'indexer')
 *   owner       'indexer' (schema in this repo) | 'sync' (schema in
 *               xchain-sync/src/sql; participates in replication artifacts)
 *   replication how rows reach a follower:
 *                 'stream:action'  per-block stream, action_index scoped
 *                 'stream:block'   per-block stream, block_index scoped
 *                 'stream:index'   per-block stream, append-only lookup
 *                 'stream:special' in the /status completeness count but not
 *                                  extracted by ServerPoller's scope loops
 *                 'snapshot'       full/incremental snapshot ride-along only
 *                 'hub-mirror'     mirrored from the hub (hub_db_sync); never
 *                                  carried by xchain-sync in any channel
 *                 'local'          never leaves the node (OPERATOR_LOCAL)
 *                 'follower-derived' recomputed by the follower, not carried
 *   blockKey    the column a 'stream:block' entry is really scoped by; absent
 *               means 'block_index'. Declared because the class name is not the
 *               column name (rollcalls/rollcall_absences key on close_block) and
 *               a reader assuming the default raises errno 1054, which every
 *               forward channel swallows as an older source schema: silent
 *               non-delivery, never an error.
 *               xchain-sync test/unit/stream_scope_columns.test.js binds this
 *               field to the owning DDL, so a scope column the schema does not
 *               have fails the build instead of shipping un-replicated.
 *   rollback    source-indexer reorg handling (src/rollback/index.js):
 *                 'action'      generic DELETE by action_index (dataTables)
 *                 'block'       generic DELETE by block_index (blockTables)
 *                 'index'       block-scoped lookup delete (indexTables)
 *                 'recomputed'  rebuilt from surviving rows during rollback()
 *                 'special'     bespoke logic in rollback() (cascade/sweep)
 *                 'exempt'      intentionally never rolled back (note = why)
 *                 'lookup'      append-only id-keyed dedup lookup; orphaned
 *                               rows are inert (only ever referenced by id)
 *               null for owner 'sync' (not a source-indexer table)
 *   replicaRollback  replica-side reorg handling (xchain-sync/src/client/rollback.js):
 *                 'mirror'      same generic list as the source
 *                 'recomputed' | 'special' | 'exempt' | 'lookup'  as above
 *                 'local'       indexer-local; table never exists on replicas
 *   alsoRecomputed  true when a generically-deleted table is ADDITIONALLY
 *               refreshed by the recompute pass (coverage is a union)
 *   hashed      { classes: [...], note }. classes from:
 *                 'ledger' | 'actions' | 'contracts'  the three consensus
 *                     block hashes (src/db/actions.js getBlockHashes)
 *                 'state_hash'   replication-integrity 4th hash over in-place
 *                     mutations + backdated credits (src/consensus/state_hash.js)
 *                 'state_commitment'  light-client SMT roots
 *                     (src/state_commitment/: balances + BTC stakes)
 *                 'index_map'    id->string delta class of state_hash
 *                     (armed per-chain; src/consensus/state_hash.js)
 *                 'quorum'       not block-hashed, but every row carries (or
 *                     is derived under) federation quorum signatures
 *               classes may be empty; the note must then say why no hash is
 *               needed (typically: a deterministic projection of hashed
 *               actions, where any divergence surfaces through the ledger/
 *               actions/contracts hashes of the affected blocks on replay).
 *   note        rationale worth keeping next to the classification
 *
 ********************************************************************/

'use strict';

// The registry rows live in two parts under table_lifecycle/, split only to
// keep each file readable. The concatenation order below IS the registry order
// (action-scoped rows first, which is the rollback dataTables order), so the
// two lists must be joined in exactly this order.
const { TABLES: ACTION_TABLES } = require('./table_lifecycle/action_tables.js');
const { TABLES: BLOCK_AND_SPECIAL_TABLES } = require('./table_lifecycle/block_and_special_tables.js');

const TABLES = [...ACTION_TABLES, ...BLOCK_AND_SPECIAL_TABLES];

// The derived/cache tables swept when their referenced index id no longer
// resolves, and the index each dangles against. rollback-coverage suites in
// both repos assert the corresponding DELETE ... NOT IN (SELECT id FROM ...)
// exists in the rollback source, so this classification cannot outlive a
// removed sweep.
//
// `replica: true` means the sweep is MIRRORED on the replica: the sync-side
// rollback-coverage guard derives its assertion set from
// ORPHAN_SWEEPS.filter(s => s.replica) and requires a matching
// DELETE ... NOT IN (SELECT id FROM ...) in ClientRollback, so flipping the
// flag without shipping (or removing) the replica sweep fails CI.
// balances stays replica:false on both rows: the replica recomputes it
// wholesale (rebuildBalances), so no mirrored sweep exists there; only the
// source orphan-sweeps balances.
const ORPHAN_SWEEPS = [
    { table: 'icons',    index: 'tokens',          replica: true  },
    { table: 'balances', index: 'index_addresses', replica: false },
    { table: 'balances', index: 'index_tickers',   replica: false },
    { table: 'markets',  index: 'index_tickers',   replica: true  },
    { table: 'pubkeys',  index: 'index_addresses', replica: true  },
];

// ── Advisory content-parity coverage ──────────────────────────
//
// What was missing. The three consensus block hashes commit the ledger /
// actions / contract projections, the light-client STATE_SUBTREES commit
// balances and stakes, state_hash commits the in-place mutation classes and
// the id->address map, and the /status per-table row counts commit cardinality
// and nothing else. The large majority of the per-block replicated tables were
// therefore covered by NO content commitment at all: an equal-COUNT content
// substitution in one of them passed every check a follower runs.
//
// What closes it. TABLE_CONTENT_PARITY_CHECK, an advisory, never-halting
// per-table content checksum over a bounded block window: xchain-sync computes
// it in BlockHasher.computeTableContentChecksums, the source publishes it on
// /status (api.js) and a follower at the same height recomputes and compares in
// ClientSync.verifyTableContentParity. Because both sides run the SAME method over
// the SAME published bound, equal count + different checksum means content
// divergence, which is exactly the class the row counts cannot see.
//
// This block is the coverage contract. The guards bind it to the code:
// xchain-sync test/unit/table_content_parity.test.js (every replicated table is
// committed by something) and this repo's test/unit/hub/hash_coverage.test.js (the
// carve-outs stay pinned to the operator ruling).
//
// There are exactly TWO exclusion classes, and a table outside both is covered:
//
//   1. OPERATOR CARVE-OUTS, decided 2026-08-11. markets is a derived
//      full-snapshot OHLCV aggregate keyed by tick pair, and the decoder
//      dispensers table soft-expires (UPDATE expired_block_index) with its hard
//      purge deferred out of band. Neither has a block bound a source and a
//      follower can agree on, so a checksum over them would false-alarm rather
//      than detect. Both keep the convergence channel they already have (the
//      snapshot upsert; ClientSync.reconcileDispensers' periodic replace).
//
//   2. IN-PLACE MUTATED tables: exactly the tables declaring the 'state_hash'
//      class above. A row of theirs written in block N is edited again in a
//      later block M, so "the content of blocks [a..b]" is not a stable
//      quantity: a source one block ahead of the follower legitimately carries
//      the later edit inside the same window and would read as a divergence.
//      They are excluded here because they are ALREADY committed, by the
//      enforced (halting) state_hash fourth hash that exists for precisely this
//      mutation class. So the exclusion narrows coverage by nothing: every
//      replicated table is committed by one mechanism or the other.
const CONTENT_PARITY_CARVE_OUTS = Object.freeze([
    Object.freeze({ table: 'markets', dbType: 'indexer',
        reason: 'Derived full-snapshot OHLCV aggregate with no clean block bound (operator ruling 2026-08-11); converges through the snapshot upsert.' }),
    Object.freeze({ table: 'dispensers', dbType: 'decoder',
        reason: 'Decoder soft-expire UPDATE plus deferred hard purge ride no per-block channel (operator ruling 2026-08-11); converges through the periodic full-table reconcile.' }),
]);

// Columns dropped from the content-parity preimage because the follower is not
// expected to hold the source's value for them. Keep this in step with
// xchain-sync ClientApplier: `blocks.id` is the local AUTO_INCREMENT surrogate
// the applier strips before insert (localSurrogateIdTables), so the two sides
// legitimately disagree on it, and `contract_state.state_key_bin` is a
// database-GENERATED column the applier never names (generatedColumns.js).
// `sync_meta.id` and `sync_meta.logged_at` are the same class: ServerPoller
// builds the streamed sync_meta row by hand from the block hashes and omits
// both, so the follower auto-assigns its own id and stamps its own insert
// wall-clock, and the two id counters drift further apart after any reorg
// because both sides delete and re-insert while InnoDB never reuses ids. The
// replicated columns block_index/block_time/ledger_hash/actions_hash/
// contract_hash stay in the preimage, so parity still covers every column the
// two sides must agree on.
// `contract_emissions.id` is the same class again: the per-block stream selects
// only execution_index/emitted_action/action_index/position
// (db.getEmissionRowsForBlock, "not em.*, which would carry the AUTO_INCREMENT
// id"), so every block a follower takes live gets a locally assigned id while
// the parity read takes every column of em. Those four replicated columns stay in the
// preimage, so the check still covers everything the two sides must agree on.
// `validator_rewards.id` reaches the same place by a different route: the row
// normally streams with every column, carrying the source id, but the RB-ANCHOR
// reorg restore (xchain-indexer/src/rollback/index.js and its mirror in
// xchain-sync/src/client/rollback.js) re-INSERTs a deleted loser naming only
// source_id/signing_pubkey_id/reward_type/round_reference/amount/block_index/
// derive_block_index, so each side mints its own AUTO_INCREMENT value off a
// counter the other never sees (the source burns values on every ignored
// createValidatorReward INSERT IGNORE). The difference is permanent, because
// validator_rewards is in ClientApplier.ignoreTables: a later re-stream carrying
// the source id is IGNOREd on the reward_unique key and the replica keeps its
// own forever. The seven restored columns stay in the preimage and reward_unique
// still identifies the row, so nothing the two sides must agree on drops out.
// Hashing any of these would turn a by-design difference into a permanent alarm.
const CONTENT_PARITY_EXCLUDED_COLUMNS = Object.freeze({
    blocks:             Object.freeze(['id']),
    contract_emissions: Object.freeze(['id']),
    contract_state:     Object.freeze(['state_key_bin']),
    sync_meta:          Object.freeze(['id', 'logged_at']),
    validator_rewards:  Object.freeze(['id']),
});

// ── Derivation helpers ──────────────────────────────────────────────────

function allTables(){
    return TABLES.slice();
}

function entry(table){
    return TABLES.find(t => t.table === table) || null;
}

function tablesWhere(fn){
    return TABLES.filter(fn).map(t => t.table);
}

// Source-indexer generic rollback lists (xchain-indexer/src/rollback/index.js).
function rollbackTables(){
    return {
        dataTables:  tablesWhere(t => t.rollback === 'action'),
        blockTables: tablesWhere(t => t.rollback === 'block'),
        indexTables: tablesWhere(t => t.rollback === 'index'),
    };
}

// Replica generic rollback lists (xchain-sync/src/client/rollback.js): the
// source lists minus indexer-local tables that never exist on a replica.
function replicaRollbackTables(){
    return {
        dataTables:  tablesWhere(t => t.rollback === 'action' && t.replicaRollback === 'mirror'),
        blockTables: tablesWhere(t => t.rollback === 'block'  && t.replicaRollback === 'mirror'),
        indexTables: tablesWhere(t => t.rollback === 'index'  && t.replicaRollback === 'mirror'),
    };
}

// Per-block stream topology for the indexer DB (xchain-sync/src/schema/
// replicated_tables.js TOPOLOGY.indexer). The decoder DB topology is NOT
// generated from this registry: that schema is owned by xchain-decoder and
// stays declared literally in replicated_tables.js.
function streamTopology(){
    let scoped = (scope) => tablesWhere(t => t.replication === 'stream:' + scope);
    return {
        blockScoped:  scoped('block'),
        txScoped:     [],   // the indexer joins via actions, never directly via tx_index
        actionScoped: scoped('action'),
        index:        scoped('index'),
        special:      scoped('special'),
    };
}

// The column a block-scoped table is really scoped by: the live per-block
// payload, the incremental catch-up range and the content-parity window all
// read it. Defaults to 'block_index', so it is a no-op for every table the
// class name describes correctly. Declared because the wrong answer is SILENT
// (errno 1054, which every forward channel swallows as an older source schema).
function blockKey(table){
    let e = entry(table);
    return (e && e.blockKey) ? e.blockKey : 'block_index';
}

// Source-side coverage buckets for the rollback-coverage guard.
function rollbackBuckets(){
    let sweepTables = [...new Set(ORPHAN_SWEEPS.map(s => s.table))];
    let RECOMPUTED = tablesWhere(t => t.rollback === 'recomputed' || t.alsoRecomputed);
    let SPECIAL_CASE = [...new Set([...tablesWhere(t => t.rollback === 'special'), ...sweepTables])];
    let ROLLBACK_EXEMPT = {};
    for(let t of TABLES){
        if(t.rollback === 'exempt') ROLLBACK_EXEMPT[t.table] = t.note || '';
    }
    return { RECOMPUTED, SPECIAL_CASE, ROLLBACK_EXEMPT };
}

// Replica-side coverage buckets (xchain-sync rollback-coverage guard).
function replicaRollbackBuckets(){
    let RECOMPUTED = tablesWhere(t => t.replicaRollback === 'recomputed');
    let SPECIAL_CASE = tablesWhere(t => t.replicaRollback === 'special');
    let ROLLBACK_EXEMPT = {};
    let INDEXER_LOCAL = {};
    for(let t of TABLES){
        if(t.replicaRollback === 'exempt') ROLLBACK_EXEMPT[t.table] = t.note || '';
        if(t.replicaRollback === 'local')  INDEXER_LOCAL[t.table]  = t.note || '';
    }
    return { RECOMPUTED, SPECIAL_CASE, ROLLBACK_EXEMPT, INDEXER_LOCAL };
}

// Tables declaring a given hash-coverage class.
function hashClassTables(cls){
    return tablesWhere(t => t.hashed && t.hashed.classes.indexOf(cls) !== -1);
}

// ── Content-parity derivation helpers ─────────────────────────

// The operator carve-out reason for a table on a dbType, or null when the table
// is not carved out there. dbType matters: the DECODER dispensers table is the
// carve-out, while the indexer's own action-scoped dispensers table is covered.
function contentParityCarveOut(table, dbType){
    let hit = CONTENT_PARITY_CARVE_OUTS.find(c => c.table === table && c.dbType === (dbType === 'decoder' ? 'decoder' : 'indexer'));
    return hit ? hit.reason : null;
}

// Tables the source mutates in place after the block that wrote them, which is
// the same set that declares the state_hash class (that hash exists to commit
// exactly these mutations). Derived, never hand-listed, so a new mutation class
// joins both the hash and this exclusion in one registry edit.
function contentParityMutableTables(){
    return hashClassTables('state_hash');
}

// Columns excluded from the content-parity preimage for a table (empty for most).
function contentParityExcludedColumns(table){
    return (CONTENT_PARITY_EXCLUDED_COLUMNS[table] || []).slice();
}

// How a stream:index lookup is bounded for content parity: 'block' for the two
// reorg-scoped lookups that carry a block_index stamp (their ids are consensus
// -reproducible), 'id' for the inert append-only lookups, which have no block
// column at all and are bounded by a source-published id ceiling instead.
// Decoder lookups are always 'id': that schema stamps no block on them.
function contentParityLookupBound(table, dbType){
    if(dbType === 'decoder') return 'id';
    let e = entry(table);
    return (e && e.replication === 'stream:index' && e.rollback === 'index') ? 'block' : 'id';
}

module.exports = {
    TABLES, ORPHAN_SWEEPS,
    CONTENT_PARITY_CARVE_OUTS, CONTENT_PARITY_EXCLUDED_COLUMNS,
    allTables, entry, tablesWhere,
    rollbackTables, replicaRollbackTables, streamTopology, blockKey,
    rollbackBuckets, replicaRollbackBuckets, hashClassTables,
    contentParityCarveOut, contentParityMutableTables,
    contentParityExcludedColumns, contentParityLookupBound,
};
