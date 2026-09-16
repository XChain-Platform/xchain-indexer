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
 * XChain Indexer - Hub DB Sync Client: per-table upserts
 *
 * The statement applyRow runs for one mirrored row: a plain INSERT IGNORE for
 * the append-only tables, and for the five tables the hub mutates in place, the
 * ON DUPLICATE KEY UPDATE body whose gate and assignment order carry the
 * convergence rule each comment below states. Pure string builders: nothing here
 * touches a connection, so the SQL is testable as text.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js). Vendored byte-identical
 * into xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { priceUpsertSql } = require('./mirror_write.js');

// cross_chain_calls needs the same in-place upgrade path as price_snapshots,
// not plain INSERT IGNORE. It carries UNIQUE (call_id, phase). A replica can
// already hold an older row for that key (an earlier-stream survivor). Note a
// source-chain reorg does NOT leave a status='retracted' row: applyRetraction
// DELETEs the mirrored row outright on the deletion event, so a retracted key is
// simply absent locally, never locally queryable with a retracted status. When
// the hub later re-finalizes the re-mined call (CrossChainCallEngine.writeFinalizedRow
// upserts the current quorum's content via ON DUPLICATE KEY UPDATE and rebroadcasts),
// a plain INSERT IGNORE here would drop the upgrade and strand the replica on the
// stale row. Because effective_time is in the signed canonical and
// gates the injection block, a divergent copy would inject at a different block.
// Upgrade only when the INCOMING row is finalized AND carries a generation at or
// above the local row's (keyed on VALUES(status) / VALUES(push_generation), both
// read from the delivered row, so the verdict is stable regardless of ODKU
// assignment order), so an already-finalized local row is never clobbered and
// re-delivery stays idempotent.
//
// The generation half of that gate is what keeps content and fence moving TOGETHER.
// A status-only gate let a STALE finalized page (lower push_generation, fetched
// before a re-publish and landing after the live re-published row) overwrite
// effective_time, parameters, snapshot and signatures while GREATEST held the newer
// fence in place. A later fenced retraction naming the OLD generation then could not
// match the row and the stale terms stuck: effective_time gates the injection block,
// so the mirror dispatches different terms, or at a different block, from its peers
// and from archive recovery. The gate is the same shape oracle_prices uses, `>=` for
// the same reason (re-delivery of one generation stays idempotent). It is applied
// only when the delivered row actually carries push_generation; a pre-migration
// mirror or an older hub keeps the status-only behaviour rather than having every
// content upgrade compared against a column that is not on the wire.
//
// The gate deliberately stops at the generation and does NOT tiebreak on
// effective_time within one generation: nothing in this repo pins the hub to a
// non-decreasing effective_time across re-finalizations at a fixed generation, and a
// gate resting on that would silently refuse legitimate content forever.
//
// push_generation is the item-5308 reorg FENCE, not ordinary content, so it is held
// OUT of the status gate and only ever moves UP, the same rule cross_chain_matches
// applies to a_/b_push_generation. Assigned inside the gate a finalized row carrying a LOWER
// generation lowered it, and the fenced retraction (DELETE ... WHERE push_generation
// <= gen) then matched a row re-published ABOVE that fence and blew a permanent hole
// in the mirror. The lowering is reachable because cross_chain_calls live rows apply
// DURING the REST bootstrap drain (only price_snapshots buffers, #2422), so a page
// fetched before a re-publish can land after the live re-published row.
function crossChainCallUpsertSql(cols, placeholders) {
    let fence     = cols.includes('push_generation');
    let updatable = cols.filter(c => c !== 'id' && c !== 'call_id' && c !== 'phase' && c !== 'status'
                                     && c !== 'push_generation');
    // Both halves read VALUES(...) or the row's ORIGINAL push_generation, and the
    // fence is assigned LAST, so every content column and `status` is judged against
    // the local row's pre-update generation (the #3211 ODKU ordering trap).
    let gate = fence
             ? "VALUES(status) = 'finalized' AND COALESCE(VALUES(`push_generation`), 0) >= COALESCE(`push_generation`, 0)"
             : "VALUES(status) = 'finalized'";
    let sets = updatable.map(c => '`' + c + '` = IF(' + gate + ', VALUES(`' + c + '`), `' + c + '`)');
    sets.push('status = IF(' + gate + ", 'finalized', status)");
    if (fence)
        sets.push('`push_generation` = GREATEST(COALESCE(`push_generation`, 0), COALESCE(VALUES(`push_generation`), 0))');
    return 'INSERT INTO cross_chain_calls (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
        + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
}

// oracle_prices needs the same in-place upgrade path, but keyed on its
// push_generation rather than a status column (it has no skipped->finalized
// lifecycle). It carries UNIQUE (source_chain, action_index). After a
// source-chain reorg a PRICE is re-mined at a RECYCLED action_index
// (getNextActionIndex assigns MAX+1 over survivors, not an immutable counter)
// and re-published with a BUMPED push_generation. If the replica still holds
// the stale lower-generation row at that key, a plain INSERT IGNORE no-ops and
// leaves push_generation at the old value; the deferred generation-fenced
// retraction (push_generation <= pre-bump) then deletes the freshly re-published
// row, and the hub never re-sends the deduped row, so the oracle price is
// permanently absent on this replica until a full bootstrap. Upgrade in place
// when the incoming generation is >= the local one, lifting push_generation so
// the fenced delete is a no-op against it (the same ordering-independent
// convergence price_snapshots and cross_chain_calls get via their status upgrade).
// >= (not >) keeps re-delivery of the same generation idempotent.
function oraclePriceUpsertSql(cols, placeholders) {
    let updatable = cols.filter(c => c !== 'id' && c !== 'source_chain' && c !== 'action_index' && c !== 'push_generation');
    let sets = updatable.map(c => '`' + c + '` = IF(VALUES(`push_generation`) >= `push_generation`, VALUES(`' + c + '`), `' + c + '`)');
    // push_generation is BOTH the gate and an assignment target, and MariaDB reads the
    // already-updated value in a later ODKU assignment, so it must stay LAST: lifting
    // it earlier would make every following column compare the incoming generation
    // against itself (the cross_chain_matches ordering trap, #3211).
    sets.push('push_generation = IF(VALUES(`push_generation`) >= `push_generation`, VALUES(`push_generation`), `push_generation`)');
    return 'INSERT INTO oracle_prices (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
        + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
}

// cross_chain_matches needs an in-place upgrade path, not plain INSERT IGNORE.
// TWO distinct mutations reach a match after it was first mirrored:
//
//   1. anchor_txid is stamped LATER (StateAnchorPublisher.backfillBatch, first-
//      stamp-wins COALESCE) when the ANCHOR v1 archive publishes, and the hub
//      re-broadcasts the stamped row. A plain INSERT IGNORE would no-op against
//      the already-mirrored row and leave anchor_txid NULL on streamed mirrors
//      forever, while a fresh REST bootstrap serves the stamp (divergent mirrors).
//
//   2. RETRACT -> REVIVE. Match content is NOT immutable per match_id. A source-
//      chain reorg retracts the crossing (the hub UPDATEs status='retracted' and
//      broadcasts a deletion event this mirror applies as a DELETE); when the SAME
//      crossing re-forms at the same BTC snapshot_block, _deriveMatchId yields the
//      IDENTICAL match_id and CrossChainDexEngine._insertMatchRow revives the row
//      with THIS round's effective_time / finalizing_view / validator_signatures,
//      then re-broadcasts it. A mirror that missed either half - disconnected over
//      the deletion, or the receive-side guards legitimately refused
//      an unfenced/unsigned retraction - kept the pre-reorg row, and an anchor_txid-
//      only ODKU could NEVER converge it: neither the live re-broadcast nor the
//      FULL_REPAGE bootstrap (which re-delivers the row through this same path)
//      moved the stale effective_time, which GATES the settlement block
//      (db.getEffectiveUnsettledMatches), or the stale signature set. That is a
//      permanent money-bearing divergence from a mirror-fed peer, the same class
//      the price_snapshots / cross_chain_calls / oracle_prices paths already close
//      (#3211).
//
// Convergence is ORDERING-INDEPENDENT: each delivery is judged against the local
// row's own version, so a late/duplicate/out-of-order event is a no-op rather than a
// regression. The version order is the hub's own (effective_time, status-rank) with
// rank finalized=0 < anything-else=1: a revive always carries a strictly greater
// effective_time (the proposing leader stamps _nowSeconds(), and followers refuse a
// value more than an hour off), while a retraction leaves effective_time untouched -
// so at EQUAL effective_time the retracted version is the later one and wins,
// converging a missed retraction to a status consensus reads skip. `>=` on the tie
// keeps re-delivery of the identical row idempotent.
//
// This is transport convergence, not trust: the settlement pass re-verifies every
// match's 2f+1 signatures against the local capability_snapshots before applying it,
// and a hostile hub could already replace content with a delete+insert.
function crossChainMatchUpsertSql(cols, placeholders) {
    if (cols.includes('effective_time') && cols.includes('status')) {
        let wins = '(VALUES(`effective_time`) > `effective_time` OR (VALUES(`effective_time`) = `effective_time`'
                 + " AND IF(VALUES(`status`) = 'finalized', 0, 1) >= IF(`status` = 'finalized', 0, 1)))";
        // The per-leg reorg fences are monotonic, independent of which version wins:
        // LOWERING a_push_generation / b_push_generation would let a stale fenced
        // retraction (DELETE ... WHERE gen <= fence) match this row and blow a
        // permanent hole in the mirror, so they only ever move up.
        let fences    = ['a_push_generation', 'b_push_generation'].filter(c => cols.includes(c));
        let pinned    = new Set(['id', 'match_id', 'anchor_txid'].concat(fences));
        let updatable = cols.filter(c => !pinned.has(c));
        // ASSIGNMENT ORDER IS LOAD-BEARING. MariaDB evaluates ON DUPLICATE KEY UPDATE
        // assignments left to right and later expressions read the ALREADY-UPDATED
        // value, so the two columns the gate reads must be assigned LAST, `status`
        // then `effective_time`:
        //   - every other column then compares against the row's ORIGINAL version;
        //   - `status` likewise (effective_time is still original when it runs);
        //   - `effective_time` runs with status already settled, which re-evaluates
        //     the gate to the SAME verdict (if the incoming row won, status now
        //     equals VALUES(status), so the tie branch holds; if it lost, nothing
        //     moved), so it lands consistently with the rest of the row.
        // Assigned in the naive column order instead, a strictly-newer REVIVE lifted
        // effective_time first and every later column then saw a tie against itself,
        // leaving status stuck at 'retracted' with the new content: a half-applied
        // row. Verified against MariaDB on the regtest stack, not just by reading.
        let gated = updatable.filter(c => c !== 'status' && c !== 'effective_time');
        let sets  = gated.map(c => '`' + c + '` = IF(' + wins + ', VALUES(`' + c + '`), `' + c + '`)');
        for (let c of ['status', 'effective_time'])
            sets.push('`' + c + '` = IF(' + wins + ', VALUES(`' + c + '`), `' + c + '`)');
        for (let f of fences)
            sets.push('`' + f + '` = GREATEST(COALESCE(`' + f + '`, 0), COALESCE(VALUES(`' + f + '`), 0))');
        sets.push('anchor_txid = COALESCE(anchor_txid, VALUES(anchor_txid))');
        return 'INSERT INTO cross_chain_matches (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
            + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
    }
    // Older hub (or a mirror whose local table lacks effective_time/status): no
    // version to compare, so keep the narrow anchor-stamp upgrade and never guess.
    return 'INSERT INTO cross_chain_matches (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
        + ' ON DUPLICATE KEY UPDATE anchor_txid = COALESCE(anchor_txid, VALUES(anchor_txid))';
}

// attestation_responses is insert-only in every column the responsible set signed,
// and upsertable in exactly ONE that it did not: batch_action_index, the link to the
// ATTEST v5/v6 batch that carries this response's body on chain. That batch lands on
// DOGE long after the row was mirrored, so the hub stamps the column and re-broadcasts
// the row; a plain INSERT IGNORE would drop the stamp and leave the link NULL on every
// streamed mirror forever while a fresh bootstrap served it, the divergent-mirror shape
// the cross_chain_matches anchor_txid path above closes.
//
// COALESCE, so the FIRST stamp wins and no other column is assignable at all. Row
// identity here is the natural key, not the payload, so an assignable signed column
// would let a re-delivery of one hub's copy silently replace a body this node already
// verified and applied. The link is safe to move because nothing consensus reads it:
// no state-hash preimage carries it and the applier never reads it.
function attestationResponseUpsertSql(cols, placeholders) {
    return 'INSERT INTO attestation_responses (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
        + ' ON DUPLICATE KEY UPDATE batch_action_index = COALESCE(batch_action_index, VALUES(batch_action_index))';
}
// The statement for one mirrored row of `table` over the columns the local schema
// accepts. The five upgrade paths above are keyed on the table AND on the presence of
// the column their gate reads, so an older hub (or a mirror whose local table lacks
// that column) falls through to the plain INSERT IGNORE rather than guessing.
function mirrorUpsertSql(table, cols, placeholders) {
    // price_snapshots needs an in-place upgrade path, not plain INSERT IGNORE.
    // It carries UNIQUE (round_number, coin_pair). The hub writes a 'skipped'
    // placeholder when a BTC round had no local submissions, and the bootstrap
    // endpoint serves it, so a replica can already hold the skipped row. When
    // the hub later finalizes that round from a peer-chain validated round
    // (PriceAggregator.receiveValidatedRound upserts skipped→finalized and
    // broadcasts it), a plain INSERT IGNORE here would drop the upgrade and
    // strand the replica at price=NULL while the master shows finalized;
    // exactly the ledger divergence the price-sync barrier guards against.
    // Upgrade only when the INCOMING row is finalized (keyed on VALUES(status),
    // stable regardless of ODKU assignment order), so an already-finalized
    // local row is never clobbered and re-delivery stays idempotent.
    if (table === 'price_snapshots' && cols.includes('status')) {
        // priceUpsertSql(cols, 1) is this branch's original statement, moved out so the
        // bootstrap's multi-row batch emits the same ODKU body by construction.
        return priceUpsertSql(cols, 1);
    }
    if (table === 'cross_chain_calls' && cols.includes('status')) return crossChainCallUpsertSql(cols, placeholders);
    if (table === 'oracle_prices' && cols.includes('push_generation')) return oraclePriceUpsertSql(cols, placeholders);
    if (table === 'cross_chain_matches' && cols.includes('anchor_txid')) return crossChainMatchUpsertSql(cols, placeholders);
    if (table === 'attestation_responses' && cols.includes('batch_action_index')) return attestationResponseUpsertSql(cols, placeholders);
    return 'INSERT IGNORE INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
}

module.exports = { mirrorUpsertSql };
