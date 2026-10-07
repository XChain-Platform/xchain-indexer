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
 * Flag-day gated collectors for the state-hash preimage: index-map delta,
 * VOTE poll finalization, tokens.supply refreshes and BET status flips. Each
 * is included ONLY at/after its per-chain activation height, so below it the
 * keys are omitted and the preimage is byte-identical to the pre-feature
 * shape (no fleet halt). The queries run after every ungated query so the
 * doQuery call order is unchanged when inert.
 *
 ********************************************************************/

const { tolerantQuery } = require('./tolerant_query');

// Index-map delta (id-determinism P4): the (id, string) pairs whose
// deterministic id was first assigned at block B. Deliberately hashes the
// surrogate id (the value under protection); sound only because every
// id-assignment path is now deterministic (compaction + F1a).
async function collectIndexMapDelta(db, B){
    let index_addresses_new = await tolerantQuery(db,
        "SELECT id, address FROM index_addresses WHERE block_index = ? ORDER BY id ASC", [B]);
    let index_tickers_new = await tolerantQuery(db,
        "SELECT id, tick FROM index_tickers WHERE block_index = ? ORDER BY id ASC", [B]);
    return { index_addresses_new, index_tickers_new };
}

// VOTE poll finalization flips: polls rows whose terminal flip landed at
// block B, keyed by resolved_block (the SAME key the forward updated_rows
// POLL_FINALIZE channel selects by and the reverse rollback re-open resets).
// Hashes the full deterministic tally outcome (winner, weights, gates,
// deposit + callback resolution), never a surrogate id; poll identity is
// action_index (unique), so ORDER BY action_index is a total order.
function collectPollFinalize(db, B){
    return tolerantQuery(db,
        "SELECT action_index, poll_status, winning_option, total_weight, total_voters, " +
        "quorum_met, min_voters_met, fail_reason, decided_early, effective_close_block, " +
        "finalized_action_index, resolved_block, deposit_resolved, callback_execute_action_index " +
        "FROM polls WHERE resolved_block BETWEEN ? AND ? ORDER BY action_index ASC",
        [B, B]);
}

// tokens.supply refreshes: (tick, supply) for every tick a ledger row
// touched at block B (supply is functionally derived from credits/debits/
// escrows, so this selection is exactly the set of possibly-moved supplies;
// the same join shape the updated_rows forward class uses, scoped to one
// block). Resolved tick strings with a pinned BINARY sort; supply is the
// minimal-decimal string updateTokens writes, byte-identical on source and
// follower (the follower's row is the source's row, replicated verbatim).
// Per-branch joins (driving from actions) rather than a UNION ALL derived
// table, mirroring the forward class's optimiser note.
function collectTokenSupply(db, B){
    return tolerantQuery(db,
        "SELECT tk.tick AS tick, t.supply AS supply FROM tokens t " +
        "JOIN index_tickers tk ON (tk.id = t.tick_id) " +
        "WHERE t.tick_id IN ( " +
            "SELECT c.tick_id FROM credits c JOIN actions a ON (a.action_index = c.action_index) WHERE a.block_index BETWEEN ? AND ? AND c.tick_id IS NOT NULL " +
            "UNION " +
            "SELECT d.tick_id FROM debits d JOIN actions a ON (a.action_index = d.action_index) WHERE a.block_index BETWEEN ? AND ? AND d.tick_id IS NOT NULL " +
            "UNION " +
            "SELECT e.tick_id FROM escrows e JOIN actions a ON (a.action_index = e.action_index) WHERE a.block_index BETWEEN ? AND ? AND e.tick_id IS NOT NULL " +
        ") ORDER BY tick COLLATE utf8mb4_bin ASC",
        [B, B, B, B, B, B]);
}

// BET status flips: feeds latched or terminal at block B (a feed can do
// BOTH in one pass on a large block-time jump: the latch stamps
// closed_block, then the expiry step flips terminal in the same block)
// and bets settled at block B. Keyed by the stamp columns, the SAME keys
// the forward updated_rows BET classes select by and the reverse
// rollback resets. Status strings resolved via index_statuses (never a
// surrogate id); row identity is action_index (unique), so ORDER BY
// action_index is a total order.
async function collectBetStatus(db, B){
    let bet_feed_status = await tolerantQuery(db,
        "SELECT f.action_index, s.status AS feed_status, f.closed_block, f.terminal_block " +
        "FROM bet_feeds f JOIN index_statuses s ON (s.id = f.feed_status_id) " +
        "WHERE f.closed_block = ? OR f.terminal_block = ? ORDER BY f.action_index ASC",
        [B, B]);
    let bet_status = await tolerantQuery(db,
        "SELECT b.action_index, s.status AS bet_status, b.settled_block " +
        "FROM bets b JOIN index_statuses s ON (s.id = b.bet_status_id) " +
        "WHERE b.settled_block = ? ORDER BY b.action_index ASC",
        [B]);
    return { bet_feed_status, bet_status };
}

module.exports = { collectIndexMapDelta, collectPollFinalize, collectTokenSupply, collectBetStatus };
