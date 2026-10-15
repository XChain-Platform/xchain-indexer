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
 * XChain Indexer - Hub DB Sync Client: mirror table probe
 *
 * Whether the connected schema carries a mirror table, asked once and remembered, and the
 * one log line a failed watermark read is worth. The bridge, policy and list-share barriers
 * read their tables only after asking, so a consumer whose hub DB predates them does not fail
 * one statement per refresh forever, silently, with its barrier shut either way.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js). Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../../observability/index.js');
const { strictHubRead } = require('../mirror_write.js');

// How long a NEGATIVE table probe is trusted. A positive answer is kept for the life
// of the process (a mirror table cannot vanish from under a running client), a
// negative one expires so that creating the table heals the barrier by itself rather
// than needing the consumer restarted.
const MIRROR_TABLE_PROBE_TTL_MS = 60000;

// MariaDB error 1146 (ER_NO_SUCH_TABLE), matched on the numeric errno as well as the
// name because the two spellings come from different layers of the driver and only
// the number is stable.
function isMissingTableError(err) {
    const cause = (err && err.cause) ? err.cause : err;
    return Number(cause && cause.errno) === 1146 || (cause && cause.code) === 'ER_NO_SUCH_TABLE';
}

// Report a mirror table the consumer's schema does not carry, and remember it, so the
// next refresh skips a statement that cannot work. Reported, not swallowed: a barrier
// held shut by a table nobody created is indistinguishable from a mirror that is merely
// behind, and only this line separates them.
function noteMirrorTableAbsent(sync, table) {
    if (!sync._mirrorTableMemo) sync._mirrorTableMemo = {};
    sync._mirrorTableMemo[table] = { present: false, at: Date.now() };
    getLogger().warn('HubDbSync: this schema has no ' + table + ' table, so its sync barrier stays ' +
                     'closed and every block needing it will defer; create the bridge mirror tables ' +
                     'in the hub DB this consumer reads');
}

// Whether the connected schema carries `table`, memoized on the instance rather than
// asked per refresh: the refreshes run on every mirrored row, and the answer only
// changes when somebody creates the table. DATABASE() rather than a configured name,
// so the answer is about the schema the read itself lands in.
//
// A probe that ITSELF fails answers true, which is the behaviour before this guard
// existed: the caller's catch below is the net, so a broken probe costs one failed
// statement and never a barrier that opens on a watermark it did not read.
async function mirrorTablePresent(sync, table) {
    if (!sync._mirrorTableMemo) sync._mirrorTableMemo = {};
    let memo = sync._mirrorTableMemo[table];
    if (memo && (memo.present || (Date.now() - memo.at) < MIRROR_TABLE_PROBE_TTL_MS)) return memo.present;
    let rows;
    try {
        rows = await strictHubRead(sync.hubDb,
            "SELECT TABLE_NAME FROM information_schema.TABLES " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table]);
    } catch (e) {
        return true;
    }
    if (rows.length > 0) {
        sync._mirrorTableMemo[table] = { present: true, at: Date.now() };
        return true;
    }
    noteMirrorTableAbsent(sync, table);
    return false;
}

// Why a watermark read failed, said out loud. A missing table is the pre-migration
// schema, and the memo makes the next refresh skip the statement; anything else is a
// real fault, and a barrier held shut by a broken connection or a lost grant is worth
// exactly one log line per refresh rather than silence.
function noteWatermarkReadFailure(sync, table, err) {
    if (isMissingTableError(err)) { noteMirrorTableAbsent(sync, table); return; }
    getLogger().warn('HubDbSync: could not read the ' + table + ' watermark, so its sync barrier ' +
                     'stays closed: ' + (err && err.message));
}

module.exports = { mirrorTablePresent, noteWatermarkReadFailure };
