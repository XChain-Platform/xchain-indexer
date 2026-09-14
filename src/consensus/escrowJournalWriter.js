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

const M = require('./merkle.js');

// bc-arithmetic scale. All handler-side escrow math runs at util.bcsub(0, x, 64);
// the writer sums at the same scale so its totals are byte-consistent with the
// ledger's own arithmetic.
const SCALE = 64;
// NOTE every bcadd result is round-tripped through bcstr (fixed notation):
// bcadd returns a BigNumber, and String() on one goes exponential below 1e-7,
// which bcnum's isNumeric guard silently reads as ZERO on the next pass. The
// handlers never hit this because they feed bc* from strings; an accumulator
// chaining bc results does, so the plain-string discipline is load-bearing.

// Action types whose escrow rows carry the locker as the row address: every lock
// site (debit + escrow on the same address) and the SOURCE-keyed release sites.
// A handler RENAMES its action after the fact (db.updateActionIndex), so one
// file mints several action names and the escrow row carries the RENAMED one.
// ORDER/SWAP cancels and edits are strictly owner-gated (order.js:295,
// swap.js:260 reject any SOURCE that is not the lock's own) and their release
// rows use orderInfo/swapInfo['SOURCE'], so the row address is the locker.
const SELF_ATTRIBUTING = new Set([
    'ORDER', 'ORDER_EXPIRE', 'ORDER_CANCEL', 'ORDER_EDIT',
    'COINPAY', 'COINPAY_EXPIRE',
    'SWAP', 'SWAP_EXPIRE', 'SWAP_CANCEL', 'SWAP_EDIT',
    'BET', 'BET_EXPIRE',
    'SWEEP',
    // A CONTRACT stake locks the staker's own tokens and releases them to the same address:
    // the lock rides the STAKE action and the release rides the synthetic UNSTAKE v2 that
    // utility.js mints at cooldown maturity, and both escrow rows carry the staker's address.
    // Both must be classified BEFORE any block containing one is processed - an unclassified
    // escrow-writing action type halts this writer by design, which on a live indexer means a
    // stop, not a bad row.
    'STAKE', 'UNSTAKE',
    // A capability SLASH keys its bond release to the STAKER, so the row address is the
    // locker here too, even though the staker is NOT the action's SOURCE (the submitter
    // collecting the bounty). Admitted wholesale only because SLASH has one escrow site;
    // EXECUTE, the VM's generic entry point, gets a verifying resolver instead.
    'SLASH'
]);

// The DISPENSER family resolves through the DISPENSER ROW for every action,
// including the ones whose escrow row already carries an address. That is not
// uniformity for its own sake: dispenser.js:350 admits a format-2 refill from
// EITHER the owner OR the dispenser's GET_ADDRESS, so a DISPENSER_EDIT escrow
// row can be keyed to an address that is NOT the lock's owner, while every
// release (dispense, close, expire) still pays out against the dispenser's own
// SOURCE. Attributing that refill to whoever paid it would strand a permanent
// positive on the refiller's key and drive the OWNER's key negative on expiry,
// which is a fail-loud halt at the arming block. The locked position belongs to
// whoever gets it back, so it belongs to the dispenser.
const DISPENSER_FAMILY = {
    DISPENSER:        { table: 'dispensers',        fk: 'action_index' },
    DISPENSER_EDIT:   { table: 'dispenser_edits',   fk: 'dispenser_action_index' },
    DISPENSER_CANCEL: { table: 'dispenser_cancels', fk: 'dispenser_action_index' },
    DISPENSER_EXPIRE: { table: 'dispenser_expires', fk: 'dispenser_action_index' },
    DISPENSE:         { table: 'dispenses',         fk: 'dispenser_action_index' },
    DISPENSER_CLOSE:  { table: 'dispenser_closes',  fk: 'dispenser_action_index' }
};

// Locker address for one recipient-keyed release row. Each resolver returns the
// locker's address string or throws; none may guess.
const RESOLVERS = {

    // CROSSED mapping: see the header. order_matches ticks are the standing
    // order's give/get; give_action_index is the incoming match's action_index.
    ORDER_MATCH: async function(db, row){
        const om = one(await db.getOrderMatchLegs(row.action_index), row.action_index,
            'ORDER_MATCH row without an order_matches record');
        if(String(om.give_tick_id) === String(om.get_tick_id))
            throw new Error('escrowJournal: ambiguous ORDER_MATCH attribution (give and get tick are equal) at action ' + row.action_index);
        if(String(row.tick_id) === String(om.give_tick_id)) return sourceOf(db, om.get_action_index);
        if(String(row.tick_id) === String(om.get_tick_id))  return sourceOf(db, om.give_action_index);
        throw new Error('escrowJournal: ORDER_MATCH escrow row tick matches neither side at action ' + row.action_index);
    },

    // STRAIGHT mapping: swap_matches ticks are the incoming match's give/get.
    SWAP_MATCH: async function(db, row){
        const sm = one(await db.getSwapMatchLegs(row.action_index), row.action_index,
            'SWAP_MATCH row without a swap_matches record');
        if(String(sm.give_tick_id) === String(sm.get_tick_id))
            throw new Error('escrowJournal: ambiguous SWAP_MATCH attribution (give and get tick are equal) at action ' + row.action_index);
        if(String(row.tick_id) === String(sm.give_tick_id)) return sourceOf(db, sm.give_action_index);
        if(String(row.tick_id) === String(sm.get_tick_id))  return sourceOf(db, sm.get_action_index);
        throw new Error('escrowJournal: SWAP_MATCH escrow row tick matches neither side at action ' + row.action_index);
    },

    CROSS_SETTLE: async function(db, row){
        const s = one(await db.getCrossChainSettlementLocalAction(row.action_index), row.action_index,
            'CROSS_SETTLE row without a cross_chain_settlements record');
        return sourceOf(db, s.local_action_index);
    },

    // The one escrow row an EXECUTE writes is the contract-slash release, keyed to the
    // STAKER, who is the locker. A resolver rather than a SELF_ATTRIBUTING entry because
    // EXECUTE is the VM's generic entry point: a blanket permit would absorb a future escrow
    // site silently, so the row is VERIFIED against a debit this same execution wrote (same
    // tick, same owning address) and anything else halts.

    // Emitted ORDER/SWAP/DISPENSER/VOTE actions never reach here: each emission is minted its
    // own action_index under its own action name, so its rows resolve under that name's rule.
    EXECUTE: async function(db, row){
        const rows = await db.getContractSlashReleaseMatch(row.action_index, row.address, row.tick_id);
        if(!rows || rows.length !== 1)
            throw new Error('escrowJournal: EXECUTE escrow row at action ' + row.action_index +
                            ' is not a contract-slash release for ' + row.address + '/' + row.tick +
                            '; classify the site in escrowJournalWriter.js before any block containing it is processed');
        return row.address;
    }
};

// Every DISPENSER-family action resolves the same way: find the dispenser row
// this action points at, then take that dispenser's creating SOURCE.
for(const action of Object.keys(DISPENSER_FAMILY)){
    const spec = DISPENSER_FAMILY[action];
    RESOLVERS[action] = async function(db, row){
        // The create carries the dispenser on its OWN action_index; the rest
        // carry a foreign key to it.
        const d = one(await db.getDispenserFamilyReference(spec.table, spec.fk, row.action_index),
            row.action_index, action + ' row without a ' + spec.table + ' record');
        return sourceOf(db, d.dispenser_action_index);
    };
}

// Exactly one row or halt. The judgement stays here rather than in the db mixin because
// the halt message names the action and the attribution that could not be made, which is
// a fact about the attribution rule, not about the query.
function one(rows, actionIndex, what){
    if(!rows || rows.length !== 1)
        throw new Error('escrowJournal: ' + what + ' (action ' + actionIndex + ', ' + (rows ? rows.length : 0) + ' rows)');
    return rows[0];
}

// SOURCE address of the action that created a lock row. actions.source_id is the
// authoritative source (see actions.sql); a lock whose creating action has none
// is not attributable and halts rather than guesses.
async function sourceOf(db, actionIndex){
    const rows = await db.getActionSourceAddress(actionIndex);
    if(!rows || rows.length !== 1 || rows[0].address == null)
        throw new Error('escrowJournal: no attributable source for lock action ' + actionIndex);
    return rows[0].address;
}

// The escrow ledger rows to attribute: this block's (incremental) or the whole
// table's (arming replay). The INNER JOINs would silently DROP a row whose
// address/tick/action refs do not resolve, so callers must pair this with
// escrowRowCount and treat any difference as a halt, not a curiosity.
async function escrowRows(db, blockIndex){
    return await db.getEscrowLedgerRows(blockIndex);
}

async function escrowRowCount(db, blockIndex){
    return await db.countEscrowLedgerRows(blockIndex);
}

// Locker address for one escrow row (frozen rules above). Exported for the
// per-site golden vectors.
async function attributeRow(db, row){
    if(SELF_ATTRIBUTING.has(row.action_name)){
        if(row.address == null)
            throw new Error('escrowJournal: self-attributing ' + row.action_name + ' row has no address at action ' + row.action_index);
        return row.address;
    }
    const resolver = RESOLVERS[row.action_name];
    if(!resolver)
        throw new Error('escrowJournal: action type ' + row.action_name + ' writes escrow rows but has no attribution rule; ' +
                        'classify it in escrowJournalWriter.js before any block containing it is processed');
    return resolver(db, row);
}

// Split a list into fixed-size chunks, so an IN list or a VALUES list stays inside
// the driver's placeholder limit and max_allowed_packet on the arming replay.
const KEY_CHUNK = 500;
function chunked(list, size){
    const out = [];
    for(let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}
// The placeholder-list builder that pairs with chunked() lives beside the statements it
// fills, in src/db/escrow_journal.js, because every IN and VALUES list is built there.

// Latest journal value for a SET of keys: Map of `address \t tick` -> bc string,
// '0' when the key is absent or tombstoned. The read is unbounded in height
// because the writer runs before this block's rows are inserted, so the latest
// row for a key is necessarily from a prior block. MAX(id) is the same row the
// per-key `ORDER BY j.id DESC LIMIT 1` returned: id is the AUTO_INCREMENT primary
// key, so it orders the append-only journal exactly.
//
// Set-based rather than one SELECT per key: the tail of
// writeEscrowJournal ran 2 serial round-trips per changed key inside the block
// transaction, and the arming replay attributes the WHOLE ledger, so that tail
// scaled with ledger size. The id lookups narrow the grouped scan to the keys in
// play; that filter is an address x tick superset of the real key set, which is
// harmless because every value is read back by exact key and a key the grouped
// result never mentions reads '0' just as an empty single-key JOIN did.
// Resolve a set of address and tick STRINGS to their index-table ids, in two set
// queries rather than one per key. Shared by the prior-total read and the INSERT.
//
// The INSERT needs it for a correctness reason, not a speed one. The
// per-key INSERTs this file used to run bound the ids as `(SELECT id FROM
// index_addresses WHERE address = ?)` sub-selects, and leaned on the NOT NULL column
// to throw when one resolved to nothing. That guarantee does not survive batching:
// on a server without STRICT_ALL_TABLES a MULTI-row INSERT downgrades a NULL into a
// NOT NULL column from an error to a warning and writes the implicit default 0, so a
// consensus journal row would be silently attributed to whichever address holds id 0,
// while the single-row form errored on the identical value. Resolving here and
// throwing by name keeps the writer fail-loud under every sql_mode.
async function indexIds(db, addresses, ticks){
    return await db.resolveEscrowJournalIndexIds(addresses, ticks);
}

async function priorTotals(db, keys){
    const out = new Map();
    if(!keys.length) return out;
    const { addrIds, tickIds } = await indexIds(db, keys.map(k => k.address), keys.map(k => k.tick));
    // id-pair -> the string key the caller reads by; a key whose address or tick has
    // no index row has no journal row either, so it is simply never populated ('0').
    const byIdPair = new Map();
    for(const k of keys){
        const a = addrIds.get(k.address);
        const t = tickIds.get(k.tick);
        if(a === undefined || t === undefined) continue;
        byIdPair.set(a + '\t' + t, k.address + '\t' + k.tick);
    }
    if(!byIdPair.size) return out;
    const aList = Array.from(new Set(Array.from(byIdPair.keys()).map(p => p.split('\t')[0])));
    const tList = Array.from(new Set(Array.from(byIdPair.keys()).map(p => p.split('\t')[1])));
    for(const aChunk of chunked(aList, KEY_CHUNK)){
        for(const tChunk of chunked(tList, KEY_CHUNK)){
            const rows = await db.getLatestEscrowJournalRows(aChunk, tChunk);
            for(const r of (rows || [])){
                const key = byIdPair.get(String(r.address_id) + '\t' + String(r.tick_id));
                if(key === undefined) continue;                // cross-product row for a key we did not ask about
                if(r.locked_amount == null) continue;          // tombstone reads '0', same as an absent row
                out.set(key, String(r.locked_amount));
            }
        }
    }
    return out;
}

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
    const eq   = (a, b) => bc.bcnum(a).eq(bc.bcnum(b));   // utility has bcgt/bclt/bcgte/bclte but no bceq
    const full = !!(opts && opts.full);
    const dry  = !!(opts && opts.dryRun);
    const scope = full ? null : blockIndex;

    const rows = await escrowRows(db, scope);
    const expected = await escrowRowCount(db, scope);
    if(rows.length !== expected)
        throw new Error('escrowJournal: ' + (expected - rows.length) + ' escrow row(s) with unresolvable address/tick/action refs ' +
                        (full ? 'in the arming replay' : 'in block ' + blockIndex));
    if(!rows.length) return 0;

    // Signed per-key sums: the block's deltas, or the replay's absolute totals.
    const sums = new Map();
    for(const row of rows){
        const locker = await attributeRow(db, row);
        const key = locker + '\t' + row.tick;
        const cur = sums.get(key);
        sums.set(key, {
            address: locker, tick: row.tick,
            amount: cur ? bc.bcstr(bc.bcadd(cur.amount, row.amount, SCALE)) : bc.bcstr(bc.bcadd('0', row.amount, SCALE))
        });
    }

    // Arming replay cross-check: per tick, the attributed totals must sum to
    // exactly what SQL says the ledger holds. Attribution never moves a row
    // across ticks, so this catches dropped rows and arithmetic divergence, not
    // misattribution within a tick; the golden vectors carry that part.
    if(full){
        const byTick = new Map();
        for(const s of sums.values())
            byTick.set(s.tick, byTick.get(s.tick) === undefined ? s.amount : bc.bcstr(bc.bcadd(byTick.get(s.tick), s.amount, SCALE)));
        const ledger = await db.getEscrowLedgerTotalsByTick();
        for(const l of (ledger || [])){
            const ours = byTick.get(l.tick);
            if(ours === undefined || !eq(ours, l.total))
                throw new Error('escrowJournal: arming replay disagrees with SUM(escrows) for tick ' + l.tick +
                                ' (' + ours + ' != ' + l.total + ')');
        }
    }

    // Every key's prior value in one set-based read; the keys are distinct by
    // construction (sums is keyed by address+tick), so no key's prior can be
    // affected by another key's write below.
    const priors = await priorTotals(db, Array.from(sums.values()));

    let written = 0;
    const pending = [];
    for(const s of sums.values()){
        const prior = priors.get(s.address + '\t' + s.tick) || '0';
        const next  = full ? s.amount : bc.bcstr(bc.bcadd(prior, s.amount, SCALE));
        if(bc.bclt(next, 0))
            throw new Error('escrowJournal: locked total for ' + s.address + '/' + s.tick + ' nets negative (' + next + ') ' +
                            (full ? 'in the arming replay' : 'at block ' + blockIndex) +
                            '; the ledger released more than this key locked');
        const isZero = eq(next, 0);
        if(eq(prior, next)) continue;                     // unchanged (includes 0 -> 0)
        if(dry){ written++; continue; }                   // read-only conformance pass
        // A released key is recorded as SQL NULL, the reader's tombstone.
        pending.push({ address: s.address, tick: s.tick, locked: isZero ? null : M.canonicalAmount(next) });
        written++;
    }
    // Ids resolved in JS, not by an id sub-select per VALUES row: see indexIds for why
    // the sub-select form stops being fail-loud the moment the INSERT carries more than
    // one row. An unresolvable key throws BY NAME here, before anything is written, and
    // the throw rolls the block transaction back exactly as the NOT NULL violation did.
    if(pending.length){
        const ids = await indexIds(db, pending.map(p => p.address), pending.map(p => p.tick));
        for(const p of pending){
            p.address_id = ids.addrIds.get(p.address);
            p.tick_id    = ids.tickIds.get(p.tick);
            if(p.address_id === undefined || p.tick_id === undefined)
                throw new Error('escrowJournal: no index row for ' +
                                (p.address_id === undefined ? 'address ' + p.address : 'tick ' + p.tick) +
                                ' ' + (full ? 'in the arming replay' : 'at block ' + blockIndex) +
                                '; the journal row it keys would carry a NULL id');
        }
    }
    // One multi-row INSERT per chunk rather than one per key. The VALUES list keeps
    // the loop's order, so the AUTO_INCREMENT ids that idx_latest walks backwards are
    // assigned exactly as the per-key inserts assigned them.
    for(const chunk of chunked(pending, KEY_CHUNK))
        await db.insertEscrowJournalRows(chunk, blockIndex);
    return written;
}

module.exports = {
    SELF_ATTRIBUTING,
    DISPENSER_FAMILY,
    RESOLVERS,
    attributeRow,
    escrowRows,
    escrowRowCount,
    writeEscrowJournal
};
