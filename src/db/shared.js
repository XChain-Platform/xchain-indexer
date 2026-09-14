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
 * XChain Indexer - Database module state
 * 
 * The constants and pure helpers db/index.js and the table mixins share. They live
 * in one module so a value that must exist exactly once (the transaction-epoch
 * store, the auto-dedupe allowlist) cannot become one copy per file.
 *
 ********************************************************************/

const path    = require('path');
const { AsyncLocalStorage } = require('async_hooks');
// The ATTEST batch wire versions, taken from the codec rather than written as literals
// here, so the chunk read and the parser cannot disagree about which versions are chunks.
const abw = require('../actions/attest/attest_batch_wire.js');

// Row limit on ONE publisher's chunk set for ONE ATTEST batch key, the archive rail's
// ANCHOR_ROW_LIMIT / ARCHIVE_ANCHOR_ROW_LIMIT applied to the batch rail. Only ever
// applied to an author-scoped read (getAttestBatchChunks explains why the unscoped one
// cannot carry a limit at all).
//
// DERIVED FROM THE PARSER'S OWN CEILING, not from the encoder's habits, so it cannot
// truncate a batch the WIRE CONTRACT accepts. It once read a bare 256 justified by what
// the codec would produce (about 175 wires for the largest body), but the split a
// publisher chooses carries no consensus weight, so a batch of smaller slices was
// accepted by the parser and then truncated here: the coverage check saw 256 of 258 rows,
// returned `chunk-coverage`, and a complete on-chain batch never absorbed.
// ATTEST_BATCH_MAX_CHUNKS is now the one number both sides read, so the two cannot drift.
//
// The bound is safe AFTER the author partition and only there (getAttestBatchChunks
// explains why the unscoped read cannot carry a limit at all): one publisher's valid rows
// under one key are their head plus at most one row per slot, because this read returns
// only 'valid' rows and a second head or a refilled slot is stamped invalid at parse. So
// the row count cannot exceed the declared chunk count, which the parser now bounds.
const ATTEST_BATCH_CHUNK_ROW_LIMIT = abw.ATTEST_BATCH_MAX_CHUNKS;

// A stake weight, as stake_weighted_quorum.bcnum accepts one (plain decimal string).
// Kept identical to that predicate's pattern so this producer can never emit a row the
// predicate then has to fail closed on.
const STAKE_WEIGHT_NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/;

// Fail CLOSED on a weightless stake-weight row. Every source-keyed weight
// producer routes through here instead of resolving a missing weight to '0'. The '0'
// looks harmless and is not: the source stays in the quorum's dedupe map carrying no
// stake, so the denominator S shrinks while a signer keeps the full numerator, and a
// smaller real stake clears 3*tally > 2*S. stake_weighted_quorum already rejects such a
// row, but it never sees one - every consumer re-maps the set through
// `String(v.weight != null ? v.weight : '0')`, which launders the missing weight into a
// well-formed zero before the predicate runs. The weight columns behind these queries
// (stakes.amount, capability_snapshots.amount) are NOT NULL and the source-aggregate is
// HAVING-filtered, so a null here is a corrupt read, not a stakeless source; a live
// regtest sweep over BTC/LTC/DOGE (all capabilities, several block boundaries) found
// zero weightless rows. Throwing surfaces to the hub as an RPC error, which every
// consensus caller already treats as "decline the round" - the same posture the hub
// takes when CHECKPOINT_COMMITMENT is unarmed: refuse to sign rather than emit a
// degraded row. A legitimate '0' still passes.
function requireStakeWeight(weight, label){
    if(weight === null || weight === undefined)
        throw new Error((label || 'stake weights') + ': missing validator weight would silently lower the stake-quorum denominator S');
    let w = String(weight).trim();
    if(w === '' || !STAKE_WEIGHT_NUMERIC.test(w))
        throw new Error((label || 'stake weights') + ': nonnumeric validator weight "' + w.slice(0, 32) + '" would silently lower the stake-quorum denominator S');
    // Return the value UNTRIMMED: the accepted set is unchanged from the old
    // String(r.weight) coercion for every weight a live producer emits, so the
    // stakes_root leaves this feeds keep hashing byte-for-byte what they did before.
    return String(weight);
}

// Compare form for two stake amounts that came from DIFFERENT producers (this node's own
// SUM() and a hub's serialization of its own SUM()). Used ONLY by
// verifyCapabilitySnapshotRow, never on a canonical/hashing path, where the byte form is
// the value. A refusal has to mean "these are different numbers", not "these are the same
// number spelled differently": '100' and '100.00' and '0100' are one weight, and refusing
// a mirrored row over a trailing zero would blow a hole in the mirror for a formatting
// difference. Returns null for anything non-numeric, which never equals anything (a
// garbage amount is therefore a contradiction, not an accidental match).
function normalizeStakeAmount(v){
    if(v === null || v === undefined) return null;
    let s = String(v).trim();
    if(s === '' || !STAKE_WEIGHT_NUMERIC.test(s)) return null;
    let neg = s[0] === '-';
    if(s[0] === '+' || s[0] === '-') s = s.slice(1);
    let dot  = s.indexOf('.');
    let int  = dot === -1 ? s : s.slice(0, dot);
    let frac = dot === -1 ? '' : s.slice(dot + 1);
    int  = int.replace(/^0+/, '');
    frac = frac.replace(/0+$/, '');
    if(int === '') int = '0';
    let out = int + (frac === '' ? '' : '.' + frac);
    // -0 and 0 are the same weight.
    return (neg && out !== '0') ? '-' + out : out;
}

// Tables whose highest-`id`-survivor dedupe rule is validated and safe to auto-apply at
// startup (see dedupeForUniqueIndex: an upsert that degraded to plain INSERT appended a
// fresh row per change, so the highest id is the live value). reconcileTableIndexes will
// only DELETE rows to force a UNIQUE index for a table on this allow-list; any other table
// with blocking duplicates is left intact with a loud warning for a manual migration, so a
// mis-declared UNIQUE index can never silently destroy rows on an unvalidated table.
const AUTO_DEDUP_TABLES = new Set(['balances']);

// Accumulate one undeclared-shape finding for the verifyTables summary. `store` is the
// Map verifyTables hangs off the instance for the length of a run; it is absent outside
// one (unit harnesses call the reconcilers directly), and then this is a no-op, so the
// per-table warnings never depend on a collector existing.
function recordShapeDrift(store, table, kind, items){
    if(!store || !items || !items.length) return;
    const entry = store.get(table) || { columns: [], indexes: [] };
    entry[kind] = entry[kind].concat(items);
    store.set(table, entry);
}

// Watchdog-fence context (M-16). The block loop runs each block's processing inside
// txEpochStore.run(epoch, ...) so every DB call it makes carries the transaction epoch
// it was issued under. If the block watchdog fires, the outer catch rolls back and the
// abandoned (zombie) block-processing promise can still resume and try to write on the
// SHARED transactionConnection, which by then belongs to a LATER block's transaction.
// The epoch a write carries is compared against the db's current epoch (_txEpoch); the
// epoch is bumped on every transaction teardown, so a zombie write carries a stale epoch
// and is rejected before it reaches the driver. AsyncLocalStorage propagates the epoch
// across every await inside the block promise (including the zombie continuation) without
// threading it through every call site, and is absent for non-block-loop callers (RPC
// reads, health checks), which are therefore never fenced.
const txEpochStore = new AsyncLocalStorage();

// Consensus block-hash scheme version. Folded into the preimage of every per-block
// ledger/actions/contract hash (see getBlockHashes), so changing it changes every hash.
// The scheme hashes the RESOLVED canonical strings (address/tick/action/status) rather
// than the raw AUTO_INCREMENT lookup ids (address_id/tick_id/action_id/source_id/
// caller_id/status_id). Hashing raw ids was considered and rejected: ids are assigned on
// first reference and survive reorgs, so a shallow reorg containing a first-seen address/
// ticker/etc. would permanently fork id assignment between nodes and diverge the hashes.
// Resolving to canonical strings makes the hashes depend only on the canonical chain
// (id-independent). The resolved-string scheme is the only one that has ever shipped, so
// it is version 1; the id-based design never carried a version number.
// Bumping this is a consensus break requiring a coordinated all-validator re-baseline of
// checkpoints from an agreed height (already-anchored hashes stay on their original scheme).
// MUST stay identical to xchain-sync/src/client/block_hasher.js BLOCK_HASH_VERSION; the two hashers
// are a byte-for-byte conformance pair (guarded by the xchain-e2e-test conformance scenario
// and the xchain-sync block-hash-vectors golden). This is a fixed protocol constant, never
// env-overridable.
const BLOCK_HASH_VERSION = 1;

// Canonical form of a wire `^<id>` index reference: a caret followed by decimal digits
// with no leading zero (ids start at 1, so `^0` is invalid too). This is the ONE accepted
// byte-form, so a given entity has exactly one wire id form. Tested against the substring
// AFTER the '^'. Non-canonical caret strings (`^007`, `^1.5`, `^-1`, `^0x10`, `^1e3`,
// `^ 1`, `^`) are rejected so they cannot alias to a canonical id or coerce onto an
// integer FK column; the digit string is handed to SQL verbatim (never via Number()) so a
// large id keeps full precision. See xchain-documentation/protocol/Index_Id_References.md.
const CANONICAL_CARET_ID = /^[1-9][0-9]*$/;

// Whether this indexer resolves `capability` from the hub-mirrored capability_snapshots
// rather than from local stake rows. Capability staking is BTC-only at the protocol level,
// so every non-BTC indexer has an empty local set and would otherwise compute a quorum
// against zero stake.
//
// Deliberately a module-level function rather than a method: every resolver is invoked by
// tier-1 regression tests against a partial object, so a `this`-dependent predicate would
// make their behaviour depend on how they were called rather than on the config.
//
// `price` redirects unconditionally, exactly like cross_chain and oracle_publish. Off BTC
// the local `stakes` path is empty for every capability, so without the redirect a PRICE
// round on LTC/DOGE sums to zero stake and records 'invalid: insufficient signer stake'
// with signatures that all verify.
//
// `attestation` joins them for the ATTEST v5/v6 response batch, which rides the DOGE rail
// and must resolve its BATCH quorum against the capability snapshot at the signed BTC
// anchor. Without the redirect that quorum sums to zero stake on every DOGE node, which is
// the identical shape PRICE batching already hit.
//
// It widens ONLY who is capable, never who is responsible. The per-row responsible set is
// resolved by actions/attest.js _computeResponsibleSet, which returns [] off BTC before it
// reads anything, and that filter stays the binding gate on the on-chain v1 path: an ATTEST
// v1 landing off BTC is refused for the same reason after this change as before it. That is
// deliberate, and it is why per-row responsible-set verification happens on the BTC indexer
// after the hub re-serves the row, never on the batch's landing chain.
//
// ONE predicate for ALL FOUR capability reads (validator set, stake weights, active count,
// per-pubkey membership). If any one of them consulted a different source, a node would
// tally signatures against one validator set and divide by a quorum denominator computed
// from another, reaching a verdict no other node reaches.
function usesCapabilitySnapshot(config, capability){
    if(!config || config['COIN'] === 'BTC') return false;
    return capability === 'cross_chain' || capability === 'oracle_publish' ||
           capability === 'price' || capability === 'attestation';
}

// True when str[i] opens a backslash escape inside the currently open quoted span.
//
// MariaDB/MySQL honour `\<char>` inside `'` and `"` string literals by default, so a
// `\'` does NOT close the literal. Every quote walker below must consult this helper
// instead of closing a span on the next matching quote, or the scan desyncs from the
// statements the server would run: `INSERT ... VALUES ('it\'s fine'); DROP TABLE
// balances;` closes at the `\'`, re-opens at the literal's real closing quote, and
// swallows the `;` and the DROP into one chunk whose first keyword is INSERT,
// invisible to the ^-anchored destructive checks in _destructiveAutoStatement, which
// then score the file auto-eligible.
//
// Backtick spans are excluded: a backslash inside an identifier quote is a literal
// character there, so consuming the next char would desync in the other direction.
// A trailing lone backslash opens nothing, so no walker indexes past end-of-input.
//
// Module-level, not a method: hasUnquotedHash is deliberately a local closure because
// runMigrations' callers build partial `this` objects, and a prototype hop would break
// the guard on those (see the comment at that closure).
//
// Holds only while sql_mode omits NO_BACKSLASH_ESCAPES. Nothing in this tree sets
// sql_mode and the pool params below set none; if that ever changes, every caller of
// this helper must be revisited.
function opensBackslashEscape(str, i, quote){
    return str[i] === '\\' && quote !== '`' && i + 1 < str.length;
}

module.exports = {
    ATTEST_BATCH_CHUNK_ROW_LIMIT,
    STAKE_WEIGHT_NUMERIC,
    requireStakeWeight,
    normalizeStakeAmount,
    AUTO_DEDUP_TABLES,
    recordShapeDrift,
    txEpochStore,
    BLOCK_HASH_VERSION,
    CANONICAL_CARET_ID,
    usesCapabilitySnapshot,
    opensBackslashEscape,
};
