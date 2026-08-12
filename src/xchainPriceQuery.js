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
 * XCHAIN price derivation - fill SELECTION
 *
 * The companion to xchainPrice.js. That file is the formula and never touches a
 * row; this one decides WHICH rows are trades, and over which block window. The
 * split matters: selection is where a wrong predicate silently prices XCHAIN off
 * an empty set (carry-forward forever, no alarm) or off records that are not
 * trades at all.
 *
 * Design-spec sections referenced throughout this file: §3 covers the trade
 * predicate, §4 the window.
 *
 * VERIFIED AGAINST LIVE ROWS, not schema comments (spec §10 step 1 acceptance
 * criterion). Dumped from a live BTC regtest indexer, 2026-07-25:
 *
 *   dispense  946: give_amount '5'    give_tick 170, get_amount '0.01100000',
 *                  get_tick NULL, get_coin 1 (BTC), status 'valid', block 2018
 *   match     185: give_amount '0.001' give_tick NULL (BTC side),
 *                  get_amount '100'    get_tick 33  (token side), block 776
 *   coinpay   186: obligation 185, coin_amount '0.00100000', block 782, 'valid'
 *
 * Amounts are WHOLE-TOKEN / WHOLE-COIN decimal strings, NOT satoshi base units:
 * a 1,000,000-supply issuance carries balances of '999990', and the coinpay that
 * settled match 185 paid '0.00100000' against the match's own '0.001'. The two
 * strings differ in trailing-zero padding and are equal as bignumbers, which is
 * why every amount is handed to bcmath and never string-compared. A base-unit
 * misread here would price fees off by 1e8.
 *
 * TWO SPEC CORRECTIONS FELL OUT OF THAT DUMP. Both are recorded in the spec; the
 * reasoning lives here because it is the code's reason for its shape:
 *
 * 1. A COINPAY match's OWN status is 'pending_coinpay' FOREVER. order_match.js
 *    stamps it at creation and nothing ever updates it - match 185 still reads
 *    'pending_coinpay' six blocks after it was fully paid. The spec's "row status
 *    is valid" predicate therefore selects ZERO coinpay rows on any chain, which
 *    would have deleted the entire DEX side of the price without failing: an
 *    empty fill set is indistinguishable from a quiet market, so the bootstrap
 *    would carry forward silently. Settlement is judged from the `coinpays` row
 *    (a valid one exists iff the buyer actually paid), never from order_matches.
 *
 * 2. A COINPAY fill is realized in the COINPAY's block, not the match's. Match
 *    185 was created at 776 and paid at 782. Windowing on the match's block is
 *    wrong twice over: it dates the trade before it happened, and it makes a
 *    HISTORICAL window mutable - a validator computing round R while the match is
 *    unpaid and one computing it after payment would see different fill sets for
 *    the same height range, which forks the pair. Keying on the settlement height
 *    makes the window append-only below the confirmation buffer.
 *
 * NO NUMERIC PREDICATES IN SQL, deliberately. Selection filters on ids, NULLs,
 * status strings and block heights only; positivity is decided by the single
 * bcmath implementation in xchainPrice.js. A `CAST(give_amount AS DECIMAL) > 0`
 * would read cleaner and would put a SECOND numeric engine (whatever MariaDB
 * build the validator happens to run) into a consensus path, which is precisely
 * the class of disagreement §4 warns about. SQL drops only the string-degenerate
 * rows (NULL / empty), which every engine agrees on.
 *
 ********************************************************************/

'use strict';

// The venue tag carried on each fill. Not consensus (the formula ignores it); it
// exists so the §10 step 6 observability row can say where the volume came from.
const VENUE_DISPENSE = 'dispense';
const VENUE_DEX      = 'dex';

/**
 * Block window for a round, per spec §4: (max(0, H - K - W), H - K].
 *
 * Exclusive lower / inclusive upper so consecutive rounds tile without double
 * counting a boundary block.
 *
 * @param {number} referenceHeight   H, the round's BTC reference height
 * @param {number} confirmationBuffer K, blocks held back so reorg-mutable fills
 *                                   are never in the window
 * @param {number} windowLength      W
 * @returns {object} { empty, fromBlockExclusive, toBlockInclusive }. `empty` is
 *   true when the chain is younger than the buffer; §4 treats empty-by-youth and
 *   empty-by-no-trades as the same state, so the caller carries forward either way.
 */
function computeWindowBounds(referenceHeight, confirmationBuffer, windowLength) {
    let H = Number(referenceHeight);
    let K = Number(confirmationBuffer);
    let W = Number(windowLength);
    if (!Number.isInteger(H) || H < 0)  return { empty: true, reason: 'reference height invalid' };
    if (!Number.isInteger(K) || K < 0)  return { empty: true, reason: 'confirmation buffer invalid' };
    if (!Number.isInteger(W) || W <= 0) return { empty: true, reason: 'window length invalid' };

    let top = H - K;
    if (top <= 0) return { empty: true, reason: 'chain younger than confirmation buffer' };

    return {
        empty: false,
        fromBlockExclusive: Math.max(0, top - W),
        toBlockInclusive:   top,
    };
}

// Resolve the gas token's ticker id. block_index IS NOT NULL restricts the match
// to the deterministic set, mirroring db.getTickerId's caret path: an id assigned
// out-of-band is not a consensus ticker. index_tickers is utf8mb4_bin with a
// UNIQUE index on tick(200), so this is an exact, case-sensitive, single-row match
// and subtokens (XCHAIN.FOO) never collide with it.
const XCHAIN_TICK_SQL =
    'SELECT id, tick FROM index_tickers WHERE tick = ? AND block_index IS NOT NULL';

// Resolve the native coin's id. Mirrors db.getCoinId's query, spelled here rather
// than called, so this module needs nothing from its caller's db beyond doQuery.
// That is what lets the SAME file run in the indexer and, vendored byte-identically,
// in the hub against a read-only connection to a validator's own indexer database.
const COIN_ID_SQL = 'SELECT id, coin FROM index_coins WHERE `coin` = ?';

/**
 * Pick the coin id out of COIN_ID_SQL's rows.
 *
 * Same exactly-one-row discipline as the ticker below: index_coins is small and
 * operator-populated, and resolving the wrong coin id would silently price the pair
 * off another chain's fills.
 *
 * @returns {object} { ok: true, coinId } or { ok: false, error }
 */
function selectCoinId(rows, expectedCoin) {
    if (!Array.isArray(rows) || rows.length === 0)
        return { ok: false, error: 'coin "' + expectedCoin + '" has no index_coins row' };
    if (rows.length > 1)
        return { ok: false, error: 'coin "' + expectedCoin + '" ambiguous: ' + rows.length + ' rows matched' };
    let row = rows[0];
    if (String(row.coin) !== String(expectedCoin))
        return { ok: false, error: 'coin mismatch: got "' + row.coin + '", expected "' + expectedCoin + '"' };
    let id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0)
        return { ok: false, error: 'coin id invalid: ' + row.id };
    return { ok: true, coinId: id };
}

/**
 * Pick the XCHAIN ticker id out of XCHAIN_TICK_SQL's rows.
 *
 * Spec §3: anything other than exactly one exactly-named row is a LOCAL failure -
 * abstain and alert, never guess. Zero rows is the pre-mint state (the ticker does
 * not exist yet on this chain); more than one, or a row whose tick is not
 * byte-identical to the expected name, means the collation or the index is not
 * what this code assumes, and deriving a fee input on that assumption is worse
 * than publishing nothing.
 *
 * @returns {object} { ok: true, tickId } or { ok: false, error }
 */
function selectXchainTickId(rows, expectedTick) {
    if (!Array.isArray(rows) || rows.length === 0)
        return { ok: false, error: 'XCHAIN ticker not found (token not yet issued on this chain)' };
    if (rows.length > 1)
        return { ok: false, error: 'XCHAIN ticker ambiguous: ' + rows.length + ' rows matched' };
    let row = rows[0];
    if (String(row.tick) !== String(expectedTick))
        return { ok: false, error: 'XCHAIN ticker mismatch: got "' + row.tick + '", expected "' + expectedTick + '"' };
    let id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0)
        return { ok: false, error: 'XCHAIN ticker id invalid: ' + row.id };
    return { ok: true, tickId: id };
}

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

/**
 * Map a DISPENSE_FILLS_SQL row to a fill. The SQL already pinned the orientation
 * (XCHAIN is always the give side of a dispense), so this is a rename.
 */
function mapDispenseRow(row) {
    if (!row) return null;
    return {
        venue:         VENUE_DISPENSE,
        actionIndex:   Number(row.action_index),
        blockIndex:    Number(row.block_index),
        xchainAmount:  String(row.xchain_amount),
        coinAmount:    String(row.coin_amount),
    };
}

/**
 * Map a DEX_FILLS_SQL row to a fill, reading the amounts by which side carries the
 * XCHAIN tick id rather than from fixed columns.
 *
 * Returns null on a shape the SQL should already have excluded (neither side is
 * XCHAIN, or both are). That is defensive rather than dead: this predicate is a
 * consensus input, and a row that reaches here in an unexpected shape must drop
 * out rather than be guessed at.
 */
function mapDexRow(row, xchainTickId) {
    if (!row) return null;
    let tick     = Number(xchainTickId);
    let giveTick = (row.give_tick_id === null || row.give_tick_id === undefined) ? null : Number(row.give_tick_id);
    let getTick  = (row.get_tick_id  === null || row.get_tick_id  === undefined) ? null : Number(row.get_tick_id);

    let xchainAmount, coinAmount;
    if (giveTick === tick && getTick === null) {
        xchainAmount = row.give_amount;    // XCHAIN sold, coin received
        coinAmount   = row.get_amount;
    } else if (getTick === tick && giveTick === null) {
        xchainAmount = row.get_amount;     // coin paid, XCHAIN received
        coinAmount   = row.give_amount;
    } else {
        return null;
    }
    if (xchainAmount === null || xchainAmount === undefined) return null;
    if (coinAmount   === null || coinAmount   === undefined) return null;

    return {
        venue:        VENUE_DEX,
        actionIndex:  Number(row.action_index),
        blockIndex:   Number(row.block_index),
        xchainAmount: String(xchainAmount),
        coinAmount:   String(coinAmount),
    };
}

// Canonical fill order. The formula sums a bignumber chain, so a differing order
// across nodes is a differing (if near-identical) result, and near-identical is a
// fork on a consensus input. Block, then action index, then venue: action indexes
// are unique per chain so the venue tiebreak never fires in practice and exists so
// the comparator is total by construction rather than by assumption.
function compareFills(a, b) {
    if (a.blockIndex !== b.blockIndex)   return a.blockIndex - b.blockIndex;
    if (a.actionIndex !== b.actionIndex) return a.actionIndex - b.actionIndex;
    return a.venue < b.venue ? -1 : (a.venue > b.venue ? 1 : 0);
}

/**
 * Select every realized XCHAIN/<coin> fill in a round's window.
 *
 * @param {object} db     a Database instance (only `doQuery` is used)
 * @param {object} opts
 *   @param {number} opts.referenceHeight    H, the round's coin reference height
 *   @param {number} opts.confirmationBuffer K
 *   @param {number} opts.windowLength       W
 *   @param {string} opts.gasTick            the reserved gas ticker (config.GAS_TICK)
 *   @param {string} opts.coin               'BTC' / 'LTC' / 'DOGE' (this chain)
 * @returns {object} { ok, fills, window, tickId, coinId } on success, or
 *   { ok: false, error, window } on a LOCAL failure. An EMPTY window is `ok` with
 *   `fills: []` - it is a defined state (§4), not a failure. A failure is the
 *   caller's signal to abstain from the pair for this round, never to publish.
 */
async function getWindowFills(db, opts = {}) {
    let window = computeWindowBounds(opts.referenceHeight, opts.confirmationBuffer, opts.windowLength);
    if (window.empty) return { ok: true, fills: [], window, tickId: null, coinId: null };

    let coin = selectCoinId(await db.doQuery(COIN_ID_SQL, [opts.coin]), opts.coin);
    if (!coin.ok) return { ok: false, error: coin.error, window };
    let coinId = coin.coinId;

    let tick     = selectXchainTickId(await db.doQuery(XCHAIN_TICK_SQL, [opts.gasTick]), opts.gasTick);
    if (!tick.ok) return { ok: false, error: tick.error, window };

    let dispenseRows = await db.doQuery(DISPENSE_FILLS_SQL, [
        tick.tickId, coinId, coinId, window.fromBlockExclusive, window.toBlockInclusive,
    ]);
    let dexRows = await db.doQuery(DEX_FILLS_SQL, [
        coinId, coinId, tick.tickId, tick.tickId, window.fromBlockExclusive, window.toBlockInclusive,
    ]);

    let fills = []
        .concat((dispenseRows || []).map(mapDispenseRow))
        .concat((dexRows      || []).map((r) => mapDexRow(r, tick.tickId)))
        .filter(Boolean)
        .sort(compareFills);

    return { ok: true, fills, window, tickId: tick.tickId, coinId };
}

module.exports = {
    VENUE_DISPENSE,
    VENUE_DEX,
    XCHAIN_TICK_SQL,
    COIN_ID_SQL,
    DISPENSE_FILLS_SQL,
    DEX_FILLS_SQL,
    computeWindowBounds,
    selectCoinId,
    selectXchainTickId,
    mapDispenseRow,
    mapDexRow,
    compareFills,
    getWindowFills,
};
