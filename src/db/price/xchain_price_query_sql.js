/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XCHAIN price derivation - the fill-selection SQL
 *
 * The four statements xchain_price_query.js runs, and nothing else: that module
 * decides WHICH rows are trades and this one spells the queries that fetch them.
 * They live under src/db/ because SQL belongs beside the schema it reads, and
 * they live apart from the predicate logic so a schema-shaped change (a renamed
 * column, a new status table) is a one-file edit that the selection tests still
 * pin. The design notes on the trade predicate (spec §3) and the window (§4),
 * and the live-row evidence the predicates were verified against, are in the
 * header of src/consensus/xchain_price_query.js; this file carries only what
 * each statement itself needs to say.
 *
 * VENDORED BYTE-IDENTICALLY INTO xchain-hub beside the query module (the hub
 * derives the same price from a read-only connection to a validator's own
 * indexer database), and the query module resolves it by walking up to the
 * package.json above it rather than by a fixed relative path, because the two
 * repos file the query module at different depths (src/consensus/ here, flat
 * src/ in the hub) while both keep this SQL at src/db/price/. Rename or move it
 * only with the hub copy and the reconcile-twins.sh row that pairs them.
 *
 * NO NUMERIC PREDICATES, deliberately. Every statement filters on ids, NULLs,
 * status strings and block heights only; positivity is decided by the single
 * bcmath implementation in xchain_price.js. A `CAST(give_amount AS DECIMAL) > 0`
 * would put a SECOND numeric engine (whatever MariaDB build the validator runs)
 * into a consensus path, which is precisely the class of disagreement §4 warns
 * about. SQL drops only the string-degenerate rows (NULL / empty), which every
 * engine agrees on.
 *
 ********************************************************************/

'use strict';

// Resolve the gas token's ticker id. block_index IS NOT NULL restricts the match
// to the deterministic set, mirroring db.getTickerId's caret path: an id assigned
// out-of-band is not a consensus ticker. index_tickers is utf8mb4_bin with a
// UNIQUE index on tick(200), so this is an exact, case-sensitive, single-row match
// and subtokens (XCHAIN.FOO) never collide with it.
const XCHAIN_TICK_SQL =
    'SELECT id, tick FROM index_tickers WHERE tick = ? AND block_index IS NOT NULL';

// Resolve the native coin's id. Mirrors db.getCoinId's query, spelled here rather
// than called, so the query module needs nothing from its caller's db beyond doQuery.
// That is what lets the SAME files run in the indexer and, vendored byte-identically,
// in the hub against a read-only connection to a validator's own indexer database.
const COIN_ID_SQL = 'SELECT id, coin FROM index_coins WHERE `coin` = ?';


// Realized dispenses of XCHAIN paid for in native coin.
//
// get_tick_id IS NULL is the token-for-token exclusion: a dispense priced in
// another token is a real trade but not an XCHAIN/BTC one, and its get_amount is
// denominated in that token. give_coin_id = get_coin_id = <BTC> is the
// cross-chain exclusion (§11) - both sides must sit on this chain.
//
// The dispense's own status is the whole story here, unlike the DEX side: a
// dispense either happened or it did not. The regtest dump shows 43 'valid' and
// 14 'invalid: no matching oracle price' out of 57, so this filter is load-bearing.
// Status is judged on the dispense row alone; a dispenser that later closes or
// expires does not retroactively un-execute its past dispenses (§3).
const DISPENSE_FILLS_SQL =
    `SELECT 'dispense' AS venue, d.action_index, a.block_index,
            d.give_amount AS xchain_amount, d.get_amount AS coin_amount
     FROM dispenses d
     JOIN actions a        ON a.action_index = d.action_index
     JOIN index_statuses s ON s.id = d.status_id
     WHERE d.give_tick_id = ?
       AND d.get_tick_id IS NULL
       AND d.give_coin_id = ?
       AND d.get_coin_id  = ?
       AND s.status = 'valid'
       AND a.block_index >  ?
       AND a.block_index <= ?
       AND d.give_amount IS NOT NULL AND d.give_amount <> ''
       AND d.get_amount  IS NOT NULL AND d.get_amount  <> ''`;

// Realized DEX fills of XCHAIN against native coin.
//
// Anchored on `coinpays`, not on order_matches.status_id - see correction 1 in the
// header. The JOIN is the settlement proof and the block_index comes from the
// payment, not the match (correction 2). coinpays.block_index is written from the
// COINPAY action's own block, and rollback.js deletes coinpays alongside
// order_matches, so the two never disagree after a reorg.
//
// BOTH orientations are selected. An order book carries XCHAIN-for-BTC and
// BTC-for-XCHAIN as separate rows and the token side lands in whichever column the
// matcher put it in; the mapper below reads the amounts by which side holds the
// tick id, never by fixed columns. Requiring the OTHER side's tick_id to be NULL
// is what pins it to the native-coin side rather than a second token.
//
// A row can only be selected once: coinpay.js early-exits unless the obligation is
// still 'pending_coinpay', so at most one valid coinpays row exists per match.
const DEX_FILLS_SQL =
    `SELECT 'dex' AS venue, m.action_index, cp.block_index,
            m.give_tick_id, m.give_amount, m.get_tick_id, m.get_amount,
            cp.action_index AS coinpay_action_index
     FROM order_matches m
     JOIN coinpays cp       ON cp.obligation_action_index = m.action_index
     JOIN index_statuses cs ON cs.id = cp.status_id
     WHERE m.settlement_type = 'coinpay'
       AND m.give_coin_id = ?
       AND m.get_coin_id  = ?
       AND cs.status = 'valid'
       AND ( (m.give_tick_id = ? AND m.get_tick_id  IS NULL)
          OR (m.get_tick_id  = ? AND m.give_tick_id IS NULL) )
       AND cp.block_index >  ?
       AND cp.block_index <= ?
       AND m.give_amount IS NOT NULL AND m.give_amount <> ''
       AND m.get_amount  IS NOT NULL AND m.get_amount  <> ''`;

module.exports = {
    XCHAIN_TICK_SQL,
    COIN_ID_SQL,
    DISPENSE_FILLS_SQL,
    DEX_FILLS_SQL,
};
