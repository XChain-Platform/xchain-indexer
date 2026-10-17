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
 * XChain Indexer - Hub DB Sync Client: relay margins
 *
 * The hub's relay margin floors, which the match barrier's content shortcut needs
 * to turn a mirrored effective_time back into the second the hub stamped it at.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js). Vendored byte-identical
 * into xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

// The relay margin floor per chain, xchain-hub src/lib/relay_margin.js relayMarginFloorS:
// four blocks of the chain's nominal interval (BTC 600 s, LTC 150 s, DOGE 60 s). The DEX
// engine stamps a match at its finalization second plus the LARGER floor of its two legs
// (xchain-hub src/cross_chain/dex/finalize.js), so matches touching one chain carry
// different margins depending on the other leg. A hub change to these floors moves this
// table with it.
const RELAY_MARGIN_FLOOR_S = Object.freeze({ BTC: 2400, LTC: 600, DOGE: 240 });
// The hub caps every relay margin at RELAY_MARGIN_MAX_S, so a leg on a chain this table
// does not name is never stamped further ahead than this. Used only as an UPPER bound.
const RELAY_MARGIN_MAX_S = 3000;
// The window every co-signing follower holds a row's effective_time to, against its OWN clock
// at the moment it signs (xchain-hub src/cross_chain/bridge/validate.js): at least
// RELAY_MIN_FUTURE_S (xchain-hub src/lib/relay_margin.js) and at most RELAY_MAX_FUTURE_S ahead.
// The stamp itself is the proposing leader's clock plus its margin, so this window, not the
// margin table, is the only bound on a stamp that every honest row meets.
const RELAY_MIN_FUTURE_S = 60;
const RELAY_MAX_FUTURE_S = 3600;

// One leg's margin as SQL, built from the constants above and a column name only.
function legMarginSql(column) {
    return 'CASE ' + column +
        Object.keys(RELAY_MARGIN_FLOOR_S).map(c => " WHEN '" + c + "' THEN " + RELAY_MARGIN_FLOOR_S[c]).join('') +
        ' ELSE ' + RELAY_MARGIN_MAX_S + ' END';
}

// effective_time minus the match's own margin: the hub clock second the match was stamped
// at, never overstated, because every margin above is the floor the hub stamps or the cap
// above it. MAX of it over the local rows is how far the hub's finalization order is known
// to be local, whichever pair each row belongs to.
const MATCH_FINALIZED_AT_SQL =
    'MAX(effective_time - GREATEST(' + legMarginSql('a_chain') + ', ' + legMarginSql('b_chain') + ')) AS finalized_ts';

module.exports = { RELAY_MARGIN_FLOOR_S, RELAY_MARGIN_MAX_S, RELAY_MIN_FUTURE_S, RELAY_MAX_FUTURE_S, MATCH_FINALIZED_AT_SQL };
