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
 * XChain Indexer - Hub DB Sync Client: mirror writes
 *
 * How a hub-served value reaches the local mirror: the DATETIME coercion every
 * parameterized insert runs, the price_snapshots upsert both the per-row applier
 * and the bootstrap batch build from, and the one fail-loud write primitive.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

// Coerce a hub-served value for a parameterized INSERT into the local mirror.
// The hub serves rows as JSON, so DATETIME columns arrive as ISO-8601 strings
// (e.g. price_snapshots.created_at = '2026-06-16T10:33:01.000Z'). MariaDB in
// strict mode rejects that 'T'/'Z' form for a DATETIME column with
// ER_TRUNCATED_WRONG_VALUE (22007), which silently kills the mirror (fleet
// incident 2026-06-16): BTC indexers stalled at 'price mirror at 0' once the
// oracle resumed finalizing rounds and fresh price_snapshots began streaming.
// Reformat any ISO-8601 datetime string to MySQL 'YYYY-MM-DD HH:MM:SS' (UTC,
// matching how the hub stores it); leave every other value untouched.
//
// columnType is the LOCAL column's SHOW COLUMNS Type, lowercased (see
// cachedColumnType). The rewrite is keyed on that TYPE rather than on the
// value's shape, because a shape-keyed rewrite also hits free-text columns:
// oracle_prices.memo is unvalidated operator input (PRICE v1 validates
// VALUE/FEE but never MEMO), so a memo that is literally an ISO timestamp was
// rewritten in every distributed mirror while a deployment pointing hubDb
// straight at the hub's own MariaDB kept the hub's bytes - topology-dependent
// mirror content, against the verbatim-parity contract the mirror SQL twins
// state (src/sql/oracle_prices.sql). An empty/unknown columnType falls back to
// the shape rewrite, so a cache miss (or a driver that serves no Type) can
// never regress the 22007 mirror-kill described above.
function coerceMirrorValue(v, columnType) {
    if (typeof v !== 'string') return v;
    if (columnType && !/^(datetime|timestamp)/.test(columnType)) return v;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) return v;
    // An offset-less ISO string is parsed as LOCAL time by ECMA-262, which would
    // shift the mirrored value by the node's timezone (per-node mirror drift).
    // The hub stores UTC, so treat a Z-less/offset-less match as UTC explicitly.
    let iso = /(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : v + 'Z';
    let d = new Date(iso);
    if (isNaN(d.getTime())) return v;
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

// The price_snapshots upsert, for `rowCount` rows at once. ONE builder for both
// the per-row applier and the bootstrap's batch, because the ODKU body is the
// consensus-relevant part (skipped -> finalized upgrades only, keyed on
// VALUES(status) so it is independent of assignment order) and two copies of it
// would be two chances to diverge. At rowCount 1 it emits exactly the statement
// applyRow emitted before this batching existed.
function priceUpsertSql(cols, rowCount) {
    let updatable = cols.filter(c => c !== 'id' && c !== 'round_number' && c !== 'coin_pair' && c !== 'status');
    let sets = updatable.map(c => '`' + c + "` = IF(VALUES(status) = 'finalized', VALUES(`" + c + '`), `' + c + '`)');
    sets.push("status = IF(VALUES(status) = 'finalized', 'finalized', status)");
    let tuple = '(' + cols.map(() => '?').join(', ') + ')';
    let tuples = [];
    for (let i = 0; i < rowCount; i++) tuples.push(tuple);
    return 'INSERT INTO price_snapshots (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES ' + tuples.join(', ')
         + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
}

// Run ONE mirror WRITE through a query primitive that FAILS LOUDLY.
//
// The indexer's hubDb is the shared Db wrapper, whose doQuery swallows a
// non-transactional query error and returns its `[]` default (src/db/index.js doQuery, the M-17
// fork hazard). A swallowed write is then indistinguishable from a landed one
// at the call site: the row is dropped, the caller returns normally, and the
// next heartbeat certifies the stream as caught up over data this mirror never
// wrote, which the VM oracle reads and the settlement barriers trust.
// doQueryStrict is that same query with the swallow removed, and it already
// carries every consensus-input read for this reason; writes belong on it too.
// Reads deliberately stay on doQuery: an empty result is a legitimate answer
// there and must not become a throw.
//
// Resolved per call rather than hard-coded because this module is vendored
// byte-identical into xchain-explorer, where hubDb is HubMirrorPool: a minimal
// pool with doQuery only, which already lets a query error propagate. Either
// surface therefore gives a write the same fail-loud shape, and a test double
// that provides neither keeps its own semantics instead of throwing on absence.
async function applyMirrorWrite(hubDb, query, args) {
    if (typeof hubDb.doQueryStrict === 'function')
        return await hubDb.doQueryStrict(query, args);
    return await hubDb.doQuery(query, args);
}

module.exports = { coerceMirrorValue, priceUpsertSql, applyMirrorWrite };
