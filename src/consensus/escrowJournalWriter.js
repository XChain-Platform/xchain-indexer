/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * escrow_leaf_journal WRITER (SPV sub-tree Stage B, the escrow locked leaf).
 *
 * SOURCE-ONLY, and deliberately NOT a twin. xchain-sync REPLICATES the rows this
 * writes (`stream:block`) rather than recomputing them. The follower still
 * recomputes balances_root from the replicated rows and halts on divergence, so
 * the consensus check is unchanged; what is removed is any second implementation
 * of what "locked" means.
 *
 * ---- LEDGER ATTRIBUTION, the design decision this file is built on ---------
 *
 * Each key's locked total is the signed sum of the `escrows` LEDGER rows that
 * belong to that locker. The writer does not recompute any family's
 * open-remaining figure, apply any status predicate, or enumerate touch-source
 * tables; it reads the block's own escrow rows and re-keys the nine
 * recipient-keyed release sites back to their locker. Everything else follows:
 *
 *   - The touched set IS the block's rows. A release the old touch-source list
 *     missed (COINPAY mid-lifecycle, cross-settle partial order fills) cannot be
 *     missed here, because the ledger row is the touch.
 *   - Status warts cost nothing. An order in 'cancelling'/'expiring', or a
 *     dispenser in 'cancelling', still holds escrow; here that is automatic,
 *     because no release row has been written yet. The COINPAY pending window
 *     (match deducts remaining while escrow is still held) commits the ESCROWED
 *     amount, which is the quantity the leaf must commit: the spendable leaf was
 *     already debited, so a remaining-based total would leave the in-flight legs
 *     in no leaf at all.
 *   - Historical protocol gates come for free. coinpay_expire's release amount
 *     is gate-dependent (COINPAY_EXPIRE_TOKEN_AMOUNT: token leg above the
 *     flag-day, the legacy COIN_AMOUNT below). The ledger rows already embed
 *     whatever the gate did, so a from-genesis replay reproduces history without
 *     this file knowing the gate exists.
 *   - Conservation is inherited row-by-row, not checked after the fact. Every
 *     row is attributed to exactly one key or the writer THROWS; nothing is
 *     dropped, scoped, or filtered. What remains checkable at runtime is
 *     checked: totality (an unknown escrow-writing action type halts), join
 *     integrity (a row whose address/tick refs do not resolve halts), and
 *     non-negativity (a key netting below zero halts). What sums cannot check
 *     is misattribution WITHIN a tick, which preserves every per-tick total;
 *     that is pinned by the per-site golden vectors in the test suite.
 *
 * ---- ATTRIBUTION RULES, frozen -----------------------------------------------
 *
 * Lock sites pair a debit and an escrow on the SAME address, and the
 * SOURCE-keyed release sites key to the original locker, so for those rows the
 * row address IS the locker (SELF_ATTRIBUTING below). The nine recipient-keyed
 * release rows span five action types and resolve as follows:
 *
 *   ORDER_MATCH      via order_matches (action_index = the match action).
 *                    createOrderMatch stores ticks from the STANDING ORDER's
 *                    perspective with give_action_index = the incoming match,
 *                    so the mapping is CROSSED: a row in give_tick releases the
 *                    get_action_index side's lock, and vice versa.
 *   SWAP_MATCH       via swap_matches. createSwapMatch stores ticks from the
 *                    INCOMING MATCH's perspective with give_action_index = the
 *                    match, so the mapping is STRAIGHT: a row in give_tick
 *                    releases the give_action_index side's lock.
 *   DISPENSE         via dispenses.dispenser_action_index -> the dispenser.
 *   DISPENSER_CLOSE  via dispenser_closes.dispenser_action_index.
 *   CROSS_SETTLE     via cross_chain_settlements.local_action_index, written in
 *                    the same action (covers both swap legs and partial order
 *                    fills; the order_matches row a cross fill writes has the
 *                    SETTLEMENT as give_action_index and never enters the
 *                    ORDER_MATCH rule, because attribution keys on the causing
 *                    action's type).
 *
 * The give/get tick comparison is exact and fail-closed: a match row whose two
 * ticks are equal (a self-tick trade, which the parsers should never admit) is
 * ambiguous and THROWS rather than guesses.
 *
 *   EXECUTE          returns the row's OWN address, having first verified it is the
 *                    escrow release a contract SLASH writes against the staker it burns.
 *                    A resolver rather than a SELF_ATTRIBUTING entry because a blanket
 *                    permit on the VM's generic entry point would absorb a future escrow
 *                    site silently, and this file's contract is that one halts.
 *
 **********************************************************************/

'use strict';

// The frozen attribution rules (who a row is locked by) and the named pass steps
// writeEscrowJournal runs, in escrowJournalWriter/. Split out because this file
// passed the 400-line readability limit, not because anything about the design
// changed: every rule and every step is the code that stood here, moved whole, and
// the export shape below is unchanged, so every requirer and both text guards read
// the same names. The guards read the entry AND the parts as one text (the idiom
// stake.js already established), so nothing moved out from under them.
const A = require('./escrowJournalWriter/attribution.js');
const P = require('./escrowJournalWriter/journal_pass.js');

// Append one row per key whose total actually CHANGED. Runs on the SOURCE inside
// the block transaction, before the commitment hook, so the derivation in
// escrow_leaf_subtree.js sees this block's rows.
//
// `opts.full` makes this the ARMING PASS: it attributes the ENTIRE escrows
// ledger (a from-genesis replay) instead of this block's rows, and change-logs
// the resulting absolute totals against whatever the journal holds. That is what
// lets the leaf arm with no operational backfill: the replay lands as ordinary
// journal rows, replicates, and both twins full-build from the journal exactly
// as on any other block. A shadow dry-run window that already populated the journal
// below the armed height is corrected rather than trusted (armed wins): a key
// whose shadow value equals the replay writes nothing, a drifted one gets a
// correction row. The replay also cross-checks its per-tick totals against SQL
// SUM(escrows), two independent computations of the same figure, and throws on
// any mismatch, so an arming block cannot commit a set that disagrees with the
// ledger it claims to summarize.
//
// `opts.dryRun` does everything EXCEPT the INSERT, and exists so the attribution
// rules can be exercised against a real venue's ledger before any height is
// armed: an operator (or bin/bench-escrow-arming-replay.js) runs the replay
// read-only, and every fail-loud check still fires. It returns the number of
// rows the real pass WOULD write. This is the only supported way to validate
// attribution on live data, because the alternative (arm a chain and watch)
// finds a misattribution by committing it.
async function writeEscrowJournal(db, blockIndex, opts){
    const bc   = db.util;
    const full = !!(opts && opts.full);
    const dry  = !!(opts && opts.dryRun);
    const scope = full ? null : blockIndex;

    // The steps below run in exactly the order the inline pass ran them in, and each
    // one is that block moved whole into escrowJournalWriter/journal_pass.js: the
    // sequence of db reads and writes is what the escrow call tape pins.
    const rows = await P.gatherEscrowRows(db, scope, full, blockIndex);
    if(!rows.length) return 0;

    const sums = await P.sumByLocker(db, bc, rows);

    if(full) await P.assertReplayMatchesLedger(db, bc, sums);

    // Every key's prior value in one set-based read; the keys are distinct by
    // construction (sums is keyed by address+tick), so no key's prior can be
    // affected by another key's write below.
    const priors = await P.priorTotals(db, Array.from(sums.values()));

    const { pending, written } = P.planJournalRows(bc, sums, priors, full, dry, blockIndex);
    await P.insertJournalRows(db, pending, full, blockIndex);
    return written;
}

// Unchanged export shape: the attribution names are re-exported from the part they
// moved to, so every requirer (stateCommitment.js, the two bin/ replay tools, the
// golden-vector suites) keeps reading them off this module by the same names.
module.exports = {
    SELF_ATTRIBUTING: A.SELF_ATTRIBUTING,
    DISPENSER_FAMILY: A.DISPENSER_FAMILY,
    RESOLVERS:        A.RESOLVERS,
    attributeRow:     A.attributeRow,
    escrowRows:       A.escrowRows,
    escrowRowCount:   A.escrowRowCount,
    writeEscrowJournal
};
