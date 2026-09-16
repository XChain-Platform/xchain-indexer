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
 * escrow_leaf_journal WRITER, part: the frozen ATTRIBUTION RULES.
 *
 * Which address a given escrow ledger row is LOCKED BY. Split out of
 * escrow_journal_writer.js so the entry holds the pass and this holds the rules;
 * every rule, table and halt message is carried verbatim, and the entry
 * re-exports all of it, so `require('escrow_journal_writer.js')` is unchanged.
 *
 * The two guards that read this text (test/unit/escrow_journal_writer.test.js
 * banned-identifier scan, test/unit/stake_escrow_conservation.test.js
 * SELF_ATTRIBUTING slice) read the entry AND every part here as one text, in
 * name order, so nothing moved out from under them.
 *
 ********************************************************************/

'use strict';

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
                            '; classify the site in escrow_journal_writer.js before any block containing it is processed');
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
                        'classify it in escrow_journal_writer.js before any block containing it is processed');
    return resolver(db, row);
}

module.exports = {
    SELF_ATTRIBUTING,
    DISPENSER_FAMILY,
    RESOLVERS,
    one,
    sourceOf,
    escrowRows,
    escrowRowCount,
    attributeRow
};
