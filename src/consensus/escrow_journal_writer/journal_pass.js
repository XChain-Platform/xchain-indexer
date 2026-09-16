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
 * escrow_leaf_journal WRITER, part: the PASS STEPS.
 *
 * The named steps writeEscrowJournal runs in order: gather the block's (or the
 * whole ledger's) escrow rows with the count cross-check, sum them per locker,
 * cross-check an arming replay against SUM(escrows), read every key's prior
 * total, decide which keys actually changed, and insert them. Each step is the
 * code that stood inline in the entry, moved whole; the ORDER the entry calls
 * them in is the order it ran them in, which is what the call tape pins.
 *
 ********************************************************************/

'use strict';

const M = require('../merkle.js');
// The attribution rules the gather and sum steps run against; same module the entry
// re-exports, so there is one copy of SELF_ATTRIBUTING/RESOLVERS in the process.
const A = require('./attribution.js');

// bc-arithmetic scale. All handler-side escrow math runs at util.bcsub(0, x, 64);
// the writer sums at the same scale so its totals are byte-consistent with the
// ledger's own arithmetic.
const SCALE = 64;
// NOTE every bcadd result is round-tripped through bcstr (fixed notation):
// bcadd returns a BigNumber, and String() on one goes exponential below 1e-7,
// which bcnum's isNumeric guard silently reads as ZERO on the next pass. The
// handlers never hit this because they feed bc* from strings; an accumulator
// chaining bc results does, so the plain-string discipline is load-bearing.
// Split a list into fixed-size chunks, so an IN list or a VALUES list stays inside
// the driver's placeholder limit and max_allowed_packet on the arming replay.
const KEY_CHUNK = 500;
function chunked(list, size){
    const out = [];
    for(let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}
// The placeholder-list builder that pairs with chunked() lives beside the statements it
// fills, in src/db/escrow_journal/index.js, because every IN and VALUES list is built there.

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
// per-key INSERT form binds the ids as `(SELECT id FROM
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

// The escrow rows this pass attributes, with the drop cross-check that makes the
// INNER JOINs in escrowRows safe to read: the count query sees the rows the joins
// dropped, so any difference is a halt rather than a silently shorter list.
async function gatherEscrowRows(db, scope, full, blockIndex){
    const rows = await A.escrowRows(db, scope);
    const expected = await A.escrowRowCount(db, scope);
    if(rows.length !== expected)
        throw new Error('escrowJournal: ' + (expected - rows.length) + ' escrow row(s) with unresolvable address/tick/action refs ' +
                        (full ? 'in the arming replay' : 'in block ' + blockIndex));
    return rows;
}

// Signed per-key sums: the block's deltas, or the replay's absolute totals.
async function sumByLocker(db, bc, rows){
    const sums = new Map();
    for(const row of rows){
        const locker = await A.attributeRow(db, row);
        const key = locker + '\t' + row.tick;
        const cur = sums.get(key);
        sums.set(key, {
            address: locker, tick: row.tick,
            amount: cur ? bc.bcstr(bc.bcadd(cur.amount, row.amount, SCALE)) : bc.bcstr(bc.bcadd('0', row.amount, SCALE))
        });
    }
    return sums;
}

// Arming replay cross-check: per tick, the attributed totals must sum to
// exactly what SQL says the ledger holds. Attribution never moves a row
// across ticks, so this catches dropped rows and arithmetic divergence, not
// misattribution within a tick; the golden vectors carry that part.
async function assertReplayMatchesLedger(db, bc, sums){
    const eq = (a, b) => bc.bcnum(a).eq(bc.bcnum(b));   // utility has bcgt/bclt/bcgte/bclte but no bceq
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

// Which keys actually CHANGED, and what each one's new absolute total is.
// Returns { pending, written }: pending is the rows to insert (empty on a dry
// run, which still counts), written is what the caller reports.
function planJournalRows(bc, sums, priors, full, dry, blockIndex){
    const eq = (a, b) => bc.bcnum(a).eq(bc.bcnum(b));
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
    return { pending, written };
}

// Resolve every pending row's index ids and write the rows.
//
// Ids resolved in JS, not by an id sub-select per VALUES row: see indexIds for why
// the sub-select form stops being fail-loud the moment the INSERT carries more than
// one row. An unresolvable key throws BY NAME here, before anything is written, and
// the throw rolls the block transaction back exactly as the NOT NULL violation did.
async function insertJournalRows(db, pending, full, blockIndex){
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
}

module.exports = {
    SCALE,
    KEY_CHUNK,
    chunked,
    indexIds,
    priorTotals,
    gatherEscrowRows,
    sumByLocker,
    assertReplayMatchesLedger,
    planJournalRows,
    insertJournalRows
};
