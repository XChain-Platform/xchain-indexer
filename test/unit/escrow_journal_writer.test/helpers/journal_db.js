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
 * The escrow_leaf_journal writer's db stub and its row builder, shared by the
 * escrow_journal_writer suites. The entry file escrow_journal_writer.test.js
 * carries what the stub can and cannot prove.
 *
 ********************************************************************/

'use strict';

const escrowJournalMixin = require('../../../../src/db/escrow_journal/index.js');

// The writer reaches the ledger through the db/escrow_journal methods, so the stub below
// carries the REAL ones bound over its own doQuery. Every SQL branch it matches on is
// therefore the statement that ships, including the fail-loud id resolution.
function bindEscrowJournalReads(db){
    for(const m of Reflect.ownKeys(escrowJournalMixin))
        db[m] = escrowJournalMixin[m].bind(db);
    return db;
}

// Minimal honest stand-ins for the two util behaviours the writer leans on.
const mathjs = require('mathjs');
const UTIL = {
    bcnum(n){ const s = String(n).trim(); return /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(s) ? mathjs.bignumber(s) : mathjs.bignumber(0); },
    bcstr(n){ return this.bcnum(n).toFixed(); },
    bcadd(a, b, d){ return this.bcnum(mathjs.format(mathjs.add(this.bcnum(a), this.bcnum(b)), { notation: 'fixed', precision: parseInt(d) })); },
    bclt(a, b){ return this.bcnum(a).lt(this.bcnum(b)); }
};

const SO = '1LockerOrderAaaaaaaaaaaaaaaaaaaaaa';   // standing-order / swap locker
const SM = '1LockerMatchBbbbbbbbbbbbbbbbbbbbbb';   // incoming-match locker
const RC = '1RecipientCccccccccccccccccccccccc';   // recipient the ledger rows key to
const T1 = 'ALPHA';
const T2 = 'BRAVO';

// A db stub whose tables are plain arrays. Queries are matched on the exact
// fragments the writer builds; anything unrecognized throws so a new query
// cannot silently return [].
function makeDb(state){
    state = state || {};
    const unindexed = new Set(state.unindexed || []);
    const db = bindEscrowJournalReads({
        util: UTIL,
        escrows:  state.escrows  || [],   // {action_index, action_name, address, tick, tick_id, amount, block_index}
        matches:  state.matches  || {},   // action_index -> {give_action_index, get_action_index, give_tick_id, get_tick_id}
        swapm:    state.swapm    || {},
        dispenses:state.dispenses|| {},   // action_index -> {dispenser_action_index}
        dispensers:state.dispensers|| {},
        edits:    state.edits    || {},
        expires:  state.expires  || {},
        closes:   state.closes   || {},
        settles:  state.settles  || {},   // action_index -> {local_action_index}
        // Contract-slash escrow releases, the one escrow site an EXECUTE writes:
        // [{execution_index, address, tick_id}], one per (owner, tick) the slash debited.
        slashes:  state.slashes  || [],
        sources:  state.sources  || {},   // action_index -> address
        journal:  [],
        inserted: [],
        doQuery:  stubQuery(state, unindexed)
    });
    return db;
}

// The stub's doQuery, called as a method of the db it belongs to. Every branch
// answers an array (possibly empty), so a null from both families means the
// statement is one the stub was never taught, and that throws.
function stubQuery(state, unindexed){
    return async function doQuery(sql, args){
        const rows = journalRows.call(this, sql, args, unindexed) || tableRows.call(this, sql, args, state);
        if(rows) return rows;
        throw new Error('stub: unrecognized query: ' + sql.slice(0, 80));
    };
}

// The journal's own statements: the batched INSERT, the index-id resolution and
// the grouped prior-total read. Null for any other statement.
function journalRows(sql, args, unindexed){
    // Multi-row INSERT: four bound args per row, in VALUES-list order.
    if(sql.indexOf('INSERT INTO escrow_leaf_journal') === 0){
        for(let i = 0; i < args.length; i += 4){
            const row = { address: args[i], tick: args[i+1], locked_amount: args[i+2], block_index: args[i+3] };
            this.inserted.push(row); this.journal.push(row);
        }
        return [];
    }
    // The writer resolves its string keys to index ids before the grouped
    // prior-total read AND before the INSERT; this stub hands back the strings
    // as their own ids. `unindexed` names keys the index tables do not carry,
    // which is how the fail-loud path is driven.
    if(sql.indexOf('FROM index_addresses a WHERE a.address IN') !== -1)
        return args.filter(a => !unindexed.has(a)).map(a => ({ id: a, address: a }));
    if(sql.indexOf('FROM index_tickers t WHERE t.tick IN') !== -1)
        return args.filter(t => !unindexed.has(t)).map(t => ({ id: t, tick: t }));
    // Grouped latest-per-key prior totals: the newest journal row per
    // (address, tick), which is what MAX(id) picks on the real append-only
    // table. args is the address id chunk concatenated with the tick id
    // chunk; one membership set covers both because no fixture address
    // collides with a fixture tick.
    if(sql.indexOf('FROM escrow_leaf_journal') !== -1){
        const asked = new Set(args);
        const seen  = new Set();
        const out   = [];
        for(let i = this.journal.length - 1; i >= 0; i--){
            const j = this.journal[i];
            const k = j.address + '\t' + j.tick;
            if(seen.has(k)) continue;
            if(!asked.has(j.address) || !asked.has(j.tick)) continue;
            seen.add(k);
            out.push({ address_id: j.address, tick_id: j.tick, locked_amount: j.locked_amount });
        }
        return out;
    }
    return null;
}

// The escrow ledger reads and the tables the attribution resolvers join through.
// Null for any other statement.
function tableRows(sql, args, state){
    if(sql.indexOf('SELECT COUNT(*) AS n FROM escrows') === 0){
        const rows = (args.length ? this.escrows.filter(e => e.block_index === args[0]) : this.escrows);
        return [{ n: rows.length + (state.phantomRows || 0) }];
    }
    if(sql.indexOf('FROM escrows e') !== -1 && sql.indexOf('GROUP BY e.tick_id') !== -1){
        const byTick = new Map();
        for(const e of this.escrows)
            byTick.set(e.tick, UTIL.bcstr(UTIL.bcadd(byTick.get(e.tick) || '0', e.amount, 64)));
        return Array.from(byTick, ([tick, total]) => ({ tick, total }));
    }
    if(sql.indexOf('FROM escrows e') !== -1){
        const rows = (args.length ? this.escrows.filter(e => e.block_index === args[0]) : this.escrows);
        return rows.map(e => ({ action_index: e.action_index, action_name: e.action_name,
                                address: e.address, tick: e.tick, tick_id: e.tick_id, amount: e.amount }));
    }
    if(sql.indexOf('FROM order_matches') !== -1)            return this.matches[args[0]]   ? [this.matches[args[0]]]   : [];
    if(sql.indexOf('FROM swap_matches') !== -1)             return this.swapm[args[0]]     ? [this.swapm[args[0]]]     : [];
    if(sql.indexOf('FROM dispenses') !== -1)                return this.dispenses[args[0]] ? [this.dispenses[args[0]]] : [];
    if(sql.indexOf('FROM dispenser_closes') !== -1)         return this.closes[args[0]]    ? [this.closes[args[0]]]    : [];
    if(sql.indexOf('FROM dispenser_edits') !== -1)          return this.edits[args[0]]     ? [this.edits[args[0]]]     : [];
    if(sql.indexOf('FROM dispenser_expires') !== -1)        return this.expires[args[0]]   ? [this.expires[args[0]]]   : [];
    if(sql.indexOf('FROM dispensers') !== -1)               return this.dispensers[args[0]] ? [this.dispensers[args[0]]] : [];
    if(sql.indexOf('FROM cross_chain_settlements') !== -1)  return this.settles[args[0]]   ? [this.settles[args[0]]]   : [];
    // The EXECUTE resolver's verification read: does this execution actually hold a
    // slash debit against this owner and tick? args = [execution_index, address, tick_id].
    if(sql.indexOf('FROM contract_slash_debits d') !== -1)
        return this.slashes.some(s => s.execution_index === args[0] && s.address === args[1] &&
                                      String(s.tick_id) === String(args[2])) ? [{ ok: 1 }] : [];
    if(sql.indexOf('SELECT addr.address AS address FROM actions a') === 0)
        return this.sources[args[0]] ? [{ address: this.sources[args[0]] }] : [];
    return null;
}

function esc(action_index, action_name, address, tick, tick_id, amount, block_index){
    return { action_index, action_name, address, tick, tick_id, amount, block_index };
}

module.exports = { UTIL, SO, SM, RC, T1, T2, makeDb, esc };
