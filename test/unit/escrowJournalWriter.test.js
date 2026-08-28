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
 * escrow_leaf_journal writer conformance (SPV sub-tree spec §3 Stage B,
 * stage B1, ledger-attribution design).
 *
 * THE ATTRIBUTION VECTORS ARE THE IMPORTANT TESTS HERE. The writer's totals are
 * the ledger's own rows re-keyed to their locker, so per-tick sums are conserved
 * BY CONSTRUCTION and no runtime check can see a row attributed to the wrong
 * locker within a tick. These vectors are the only guard on that: one per
 * recipient-keyed site family, asserting the exact locker each row resolves to,
 * with the ORDER_MATCH/SWAP_MATCH give/get orientation pinned in BOTH directions
 * (the two tables store opposite perspectives, which is precisely the mistake a
 * future edit would make).
 *
 * STUB HONESTY, as in the Stage A suites: the db stub honours the shape of each
 * query the writer issues; it cannot prove the SQL runs on MariaDB, only that
 * the attribution rules, accumulation, change-log semantics and fail-closed
 * throws behave as frozen.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const M = require('../../src/merkle.js');
const W = require('../../src/escrowJournalWriter.js');

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
    const db = {
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
        async doQuery(sql, args){
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
            throw new Error('stub: unrecognized query: ' + sql.slice(0, 80));
        }
    };
    return db;
}

function esc(action_index, action_name, address, tick, tick_id, amount, block_index){
    return { action_index, action_name, address, tick, tick_id, amount, block_index };
}

describe('escrow journal writer: attribution exhaustiveness @regression', function(){

    // Action names an escrow-pushing handler can mint, DERIVED from the handler
    // rather than assumed. The earlier version of this guard mapped one action
    // name per file and passed while three real ones were unclassified
    // (DISPENSER_EDIT, ORDER_CANCEL, SWAP_CANCEL): handlers RENAME their action
    // after the fact via db.updateActionIndex, so a single file mints several
    // names and the escrow row carries the renamed one. A live-venue replay
    // found that; this now finds it statically.
    function mintedActions(src, file){
        // The action the file is named for, which is the one its escrows.push
        // sites run under...
        const names = new Set([file.replace(/\.js$/, '').toUpperCase()]);
        // ...plus every name it RENAMES that same action row to. This is the
        // mechanism the old guard missed. A synthetic sub-action minted inside a
        // handler (sweep.js mints an ISSUE row) is deliberately NOT collected:
        // it is a different action row, and if it ever carried an escrow it
        // would do so through its own handler.
        for(const m of src.matchAll(/updateActionIndex\([^)]*'([A-Z_]+)'/g)) names.add(m[1]);
        return names;
    }

    it('every action an escrow-pushing handler can mint has a frozen attribution rule', function(){
        const dir = path.resolve(__dirname, '../../src/actions');
        const all = new Set();
        for(const f of fs.readdirSync(dir)){
            if(!f.endsWith('.js')) continue;
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            // Two ways a handler writes an escrow row: the escrows[] array it hands to
            // processTransactionLedgerChanges, and a direct db.createEscrow under its own
            // action_index (execute.js's contract-slash release does the latter). Scanning
            // only the first left the EXECUTE site invisible to this guard.
            if(src.indexOf('escrows.push(') === -1 && src.indexOf('createEscrow(') === -1) continue;
            for(const a of mintedActions(src, f)){
                all.add(a);
                assert.ok(W.SELF_ATTRIBUTING.has(a) || W.RESOLVERS[a],
                    'action ' + a + ' (minted by ' + f + ', which pushes escrow rows) has no attribution rule; ' +
                    'classify it in escrowJournalWriter.js before any chain containing it is armed');
            }
        }
        // Sanity that the derivation itself still sees the family it must: if a
        // refactor breaks the regexes, every assertion above passes vacuously.
        for(const expected of ['ORDER', 'ORDER_CANCEL', 'SWAP_CANCEL', 'DISPENSER_EDIT', 'BET', 'SWEEP',
                               'STAKE', 'SLASH', 'EXECUTE'])
            assert.ok(all.has(expected), 'the action-name derivation no longer finds ' + expected +
                '; the guard would pass vacuously');
        // The two sets must not overlap: a type resolving two ways is a fork.
        for(const a of Object.keys(W.RESOLVERS))
            assert.ok(!W.SELF_ATTRIBUTING.has(a), a + ' is classified both self-attributing and resolved');
    });

    it('the whole DISPENSER family resolves through the dispenser row, never the row address', function(){
        // dispenser.js:350 admits a format-2 refill from the owner OR the
        // dispenser's GET_ADDRESS, so a DISPENSER_EDIT escrow row can carry an
        // address that is not the lock's owner, while every release pays out
        // against the dispenser's own SOURCE. Self-attributing any of them would
        // strand a positive on the refiller and drive the owner negative at
        // expiry: a fail-loud halt at the arming block.
        for(const a of Object.keys(W.DISPENSER_FAMILY)){
            assert.ok(W.RESOLVERS[a], a + ' must be resolved, not self-attributed');
            assert.ok(!W.SELF_ATTRIBUTING.has(a), a + ' must not be self-attributing');
        }
        // And the authority gate that forces this is still what it was.
        const disp = fs.readFileSync(path.resolve(__dirname, '../../src/actions/dispenser.js'), 'utf8');
        assert.ok(/data\['SOURCE'\]!=dispenserInfo\['SOURCE'\] && data\['SOURCE'\]!=dispenserInfo\['GET_ADDRESS'\]/.test(disp),
            'dispenser edit authority changed; re-derive whether the family still needs row-resolution');
    });

    it('an UNKNOWN action type with an escrow row throws instead of guessing', async function(){
        const db = makeDb({ escrows: [esc(9, 'XFUTURE', RC, T1, 1, '5', 100)] });
        await assert.rejects(() => W.writeEscrowJournal(db, 100), /no attribution rule/);
    });

    it('a row whose refs do not survive the joins throws instead of vanishing', async function(){
        // The INNER JOINs drop rows with NULL/dangling address or tick refs; the
        // count cross-check turns that silent drop into a halt.
        const db = makeDb({ escrows: [esc(9, 'ORDER', SO, T1, 1, '5', 100)], phantomRows: 1 });
        await assert.rejects(() => W.writeEscrowJournal(db, 100), /unresolvable address\/tick\/action refs/);
    });
});

describe('escrow journal writer: attribution vectors @regression', function(){

    it('self-attributing rows resolve to the row address with no lookups', async function(){
        for(const name of ['ORDER', 'COINPAY', 'COINPAY_EXPIRE', 'BET', 'SWEEP']){
            const locker = await W.attributeRow(makeDb({}), { action_index: 1, action_name: name, address: SO, tick: T1, tick_id: 1, amount: '5' });
            assert.strictEqual(locker, SO, name + ' must attribute to the row address');
        }
    });

    // The one self-attributing family where row address and action SOURCE genuinely differ:
    // attributing to the source would drive the bounty submitter's key negative and strand a
    // permanent positive on the staker's.
    it('SLASH attributes its bond release to the STAKER on the row, not the bounty submitter', async function(){
        const STAKER = '1StakerDddddddddddddddddddddddddd';
        const locker = await W.attributeRow(makeDb({}),
            { action_index: 700, action_name: 'SLASH', address: STAKER, tick: T1, tick_id: 1, amount: '-1000' });
        assert.strictEqual(locker, STAKER);
    });

    // Verified rather than trusted: a blanket self-attribution on the VM's generic entry
    // point would absorb any future escrow site it grows.
    it('EXECUTE attributes a contract-slash release to the staker it debited', async function(){
        const STAKER = '1StakerDddddddddddddddddddddddddd';
        const db = makeDb({ slashes: [{ execution_index: 800, address: STAKER, tick_id: 1 }] });
        assert.strictEqual(
            await W.attributeRow(db, { action_index: 800, action_name: 'EXECUTE', address: STAKER, tick: T1, tick_id: 1, amount: '-40' }),
            STAKER);
    });

    it('an EXECUTE escrow row that is NOT a contract-slash release throws instead of self-attributing', async function(){
        const STAKER = '1StakerDddddddddddddddddddddddddd';
        // Right execution, wrong owner: the slash debited someone else, so this row is a
        // site nobody has classified.
        const db = makeDb({ slashes: [{ execution_index: 800, address: SO, tick_id: 1 }] });
        await assert.rejects(
            () => W.attributeRow(db, { action_index: 800, action_name: 'EXECUTE', address: STAKER, tick: T1, tick_id: 1, amount: '-40' }),
            /is not a contract-slash release/);
        // Right owner, wrong tick: same halt.
        await assert.rejects(
            () => W.attributeRow(makeDb({ slashes: [{ execution_index: 800, address: STAKER, tick_id: 1 }] }),
                { action_index: 800, action_name: 'EXECUTE', address: STAKER, tick: T2, tick_id: 2, amount: '-40' }),
            /is not a contract-slash release/);
        // No slash on the execution at all: same halt.
        await assert.rejects(
            () => W.attributeRow(makeDb({}),
                { action_index: 800, action_name: 'EXECUTE', address: STAKER, tick: T1, tick_id: 1, amount: '-40' }),
            /is not a contract-slash release/);
    });

    it('ORDER_MATCH is CROSSED: give-tick row -> get side locker, get-tick row -> give side locker', async function(){
        // createOrderMatch stores ticks from the STANDING ORDER's perspective and
        // give_action_index = the INCOMING MATCH. The release in the order's give
        // tick therefore belongs to the get_action_index side. Pinning both
        // directions is the point: the swap table stores the opposite.
        const db = makeDb({
            matches: { 500: { give_action_index: 900, get_action_index: 800, give_tick_id: 1, get_tick_id: 2 } },
            sources: { 800: SO, 900: SM }
        });
        assert.strictEqual(await W.attributeRow(db, { action_index: 500, action_name: 'ORDER_MATCH', address: RC, tick: T1, tick_id: 1, amount: '-5' }), SO);
        assert.strictEqual(await W.attributeRow(db, { action_index: 500, action_name: 'ORDER_MATCH', address: RC, tick: T2, tick_id: 2, amount: '-7' }), SM);
    });

    it('SWAP_MATCH is STRAIGHT: give-tick row -> give side locker, get-tick row -> get side locker', async function(){
        // createSwapMatch stores ticks from the INCOMING MATCH's perspective, so
        // the same-looking rule maps the other way around than order_matches.
        const db = makeDb({
            swapm:   { 500: { give_action_index: 900, get_action_index: 800, give_tick_id: 2, get_tick_id: 1 } },
            sources: { 800: SO, 900: SM }
        });
        assert.strictEqual(await W.attributeRow(db, { action_index: 500, action_name: 'SWAP_MATCH', address: RC, tick: T1, tick_id: 1, amount: '-5' }), SO);
        assert.strictEqual(await W.attributeRow(db, { action_index: 500, action_name: 'SWAP_MATCH', address: RC, tick: T2, tick_id: 2, amount: '-7' }), SM);
    });

    it('a same-tick match is ambiguous and throws rather than guesses', async function(){
        const db = makeDb({ matches: { 500: { give_action_index: 900, get_action_index: 800, give_tick_id: 1, get_tick_id: 1 } } });
        await assert.rejects(
            () => W.attributeRow(db, { action_index: 500, action_name: 'ORDER_MATCH', address: RC, tick: T1, tick_id: 1, amount: '-5' }),
            /ambiguous ORDER_MATCH/);
    });

    it('DISPENSE and DISPENSER_CLOSE resolve through the dispenser to its creator', async function(){
        const db = makeDb({
            dispenses: { 500: { dispenser_action_index: 300 } },
            closes:    { 501: { dispenser_action_index: 300 } },
            sources:   { 300: SO }
        });
        assert.strictEqual(await W.attributeRow(db, { action_index: 500, action_name: 'DISPENSE',        address: RC, tick: T1, tick_id: 1, amount: '-5' }), SO);
        assert.strictEqual(await W.attributeRow(db, { action_index: 501, action_name: 'DISPENSER_CLOSE', address: RC, tick: T1, tick_id: 1, amount: '-3' }), SO);
    });

    it('a DISPENSER_EDIT refill by the GET_ADDRESS attributes to the OWNER, not the refiller', async function(){
        // The live-venue conformance run is what surfaced this: dispenser.js
        // admits a format-2 refill from the dispenser's GET_ADDRESS, and its
        // escrow row is keyed to that refiller. Attributing it there would leave
        // the refiller permanently positive and drive the owner negative on
        // expiry, halting the arming block.
        const REFILLER = '1RefillerGetAddrDddddddddddddddddd';
        const db = makeDb({
            edits:   { 502: { dispenser_action_index: 300 } },
            sources: { 300: SO }
        });
        assert.strictEqual(
            await W.attributeRow(db, { action_index: 502, action_name: 'DISPENSER_EDIT', address: REFILLER, tick: T1, tick_id: 1, amount: '9' }),
            SO, 'the locked position belongs to whoever gets it back');
    });

    it('a dispenser lock and its release land on ONE key even when a third party refilled', async function(){
        // End to end: create (owner) + refill (GET_ADDRESS) + expire (owner)
        // nets to zero on the owner's key and never touches the refiller's.
        const REFILLER = '1RefillerGetAddrDddddddddddddddddd';
        const db = makeDb({
            escrows: [
                esc(300, 'DISPENSER',        SO,       T1, 1, '10', 100),
                esc(302, 'DISPENSER_EDIT',   REFILLER, T1, 1, '5',  101),
                esc(303, 'DISPENSER_EXPIRE', SO,       T1, 1, '-15', 102)
            ],
            dispensers: { 300: { dispenser_action_index: 300 } },
            edits:      { 302: { dispenser_action_index: 300 } },
            expires:    { 303: { dispenser_action_index: 300 } },
            sources:    { 300: SO }
        });
        await W.writeEscrowJournal(db, 100);
        await W.writeEscrowJournal(db, 101);
        assert.strictEqual(db.inserted[db.inserted.length - 1].locked_amount, M.canonicalAmount('15'),
            'the refill must raise the OWNER key, not open a refiller key');
        assert.ok(!db.inserted.some(r => r.address === REFILLER), 'the refiller must never get a key');
        await W.writeEscrowJournal(db, 102);
        assert.strictEqual(db.inserted[db.inserted.length - 1].locked_amount, null, 'expiry releases the whole position');
    });

    it('CROSS_SETTLE resolves through cross_chain_settlements.local_action_index', async function(){
        // Covers both swap legs and partial ORDER fills: the order_matches row a
        // cross fill writes carries the SETTLEMENT as give_action_index and never
        // enters the ORDER_MATCH rule, because attribution keys on action type.
        const db = makeDb({
            settles: { 500: { local_action_index: 400 } },
            sources: { 400: SO }
        });
        assert.strictEqual(await W.attributeRow(db, { action_index: 500, action_name: 'CROSS_SETTLE', address: RC, tick: T1, tick_id: 1, amount: '-5' }), SO);
    });

    it('a resolver with no backing record throws (no guessing on missing joins)', async function(){
        await assert.rejects(
            () => W.attributeRow(makeDb({}), { action_index: 500, action_name: 'ORDER_MATCH', address: RC, tick: T1, tick_id: 1, amount: '-5' }),
            /without an order_matches record/);
    });
});

describe('escrow journal writer: the COINPAY lifecycle, both directions @regression', function(){

    // THE vector this design exists for. A native-coin order match deducts the
    // order's remaining but releases nothing; the escrow moves only at COINPAY
    // (buyer pays) or COINPAY_EXPIRE (buyer flakes: refund). The journal must
    // show the full lock across the pending window and step down only when the
    // ledger does. A remaining-based writer showed 60 during the window.

    it('lock 100 -> pending match (no rows) -> fulfill releases 40: totals 100, 100, 60', async function(){
        const db = makeDb({ escrows: [
            esc(10, 'ORDER',   SO, T1, 1, '100', 100),
            // block 101: ORDER_MATCH pending_coinpay writes NO escrow rows
            esc(30, 'COINPAY', SO, T1, 1, '-40', 102)
        ]});
        assert.strictEqual(await W.writeEscrowJournal(db, 100), 1);
        assert.strictEqual(db.inserted[0].locked_amount, M.canonicalAmount('100'));
        assert.strictEqual(await W.writeEscrowJournal(db, 101), 0, 'the pending window must not move the journal');
        assert.strictEqual(await W.writeEscrowJournal(db, 102), 1);
        assert.strictEqual(db.inserted[1].locked_amount, M.canonicalAmount('60'));
    });

    it('the expire direction is identical: the refund row steps the total down', async function(){
        const db = makeDb({ escrows: [
            esc(10, 'ORDER',          SO, T1, 1, '100', 100),
            esc(31, 'COINPAY_EXPIRE', SO, T1, 1, '-40', 102)
        ]});
        await W.writeEscrowJournal(db, 100);
        assert.strictEqual(await W.writeEscrowJournal(db, 102), 1);
        assert.strictEqual(db.inserted[1].locked_amount, M.canonicalAmount('60'));
    });

    it('a cancelling/expiring order holds its escrow: no rows, no movement', async function(){
        // The two-phase cancel writes only a status row. Under ledger attribution
        // the journal is untouched by construction, where a status='open'
        // predicate dropped the key to zero while the tokens were still locked.
        const db = makeDb({ escrows: [esc(10, 'ORDER', SO, T1, 1, '100', 100)] });
        await W.writeEscrowJournal(db, 100);
        assert.strictEqual(await W.writeEscrowJournal(db, 101), 0);
        for(let i = db.journal.length - 1; i >= 0; i--)
            if(db.journal[i].address === SO) { assert.strictEqual(db.journal[i].locked_amount, M.canonicalAmount('100')); break; }
    });
});

describe('escrow journal writer: change-log semantics @regression', function(){

    it('a lock fully released in the SAME block nets to zero and writes nothing', async function(){
        const db = makeDb({
            escrows: [
                esc(10, 'ORDER',       SO, T1, 1, '5',  100),
                esc(11, 'ORDER_MATCH', RC, T1, 1, '-5', 100)
            ],
            matches: { 11: { give_action_index: 900, get_action_index: 10, give_tick_id: 1, get_tick_id: 2 } },
            sources: { 10: SO, 900: SM }
        });
        assert.strictEqual(await W.writeEscrowJournal(db, 100), 0, 'never-locked-and-still-not writes no tombstone');
    });

    it('a release to exactly zero writes the NULL tombstone, not "0"', async function(){
        const db = makeDb({ escrows: [
            esc(10, 'SWAP',        SO, T1, 1, '5',  100),
            esc(20, 'SWAP_EXPIRE', SO, T1, 1, '-5', 101)
        ]});
        await W.writeEscrowJournal(db, 100);
        assert.strictEqual(await W.writeEscrowJournal(db, 101), 1);
        assert.strictEqual(db.inserted[1].locked_amount, null);
    });

    it('several rows for one key in one block fold into ONE journal row', async function(){
        // A dispenser edit tops up escrow while a dispense pays out: one net row.
        const db = makeDb({
            escrows: [
                esc(10, 'DISPENSER', SO, T1, 1, '7',  100),
                esc(11, 'DISPENSE',  RC, T1, 1, '-2', 100)
            ],
            dispensers: { 10: { dispenser_action_index: 10 } },
            dispenses:  { 11: { dispenser_action_index: 10 } },
            sources:    { 10: SO }
        });
        assert.strictEqual(await W.writeEscrowJournal(db, 100), 1);
        assert.strictEqual(db.inserted[0].locked_amount, M.canonicalAmount('5'));
    });

    // The batched INSERT is why this is a test rather than a column
    // constraint. The per-key form bound address_id as a sub-select and let the NOT NULL
    // column throw on an unresolvable key; a MULTI-row INSERT on a server without
    // STRICT_ALL_TABLES turns that same NULL into a warning and writes id 0, which
    // misattributes a consensus journal row instead of refusing it. The writer must
    // therefore refuse in JS, before any row is emitted.
    it('a key with no index row throws by name and writes nothing', async function(){
        const db = makeDb({
            escrows:   [ esc(10, 'ORDER', SO, T1, 1, '5', 100) ],
            unindexed: [ SO ]
        });
        await assert.rejects(() => W.writeEscrowJournal(db, 100), /no index row for address/);
        assert.strictEqual(db.inserted.length, 0, 'an unresolvable key must not reach the INSERT');
    });

    it('a tick with no index row throws by name too', async function(){
        const db = makeDb({
            escrows:   [ esc(10, 'ORDER', SO, T1, 1, '5', 100) ],
            unindexed: [ T1 ]
        });
        await assert.rejects(() => W.writeEscrowJournal(db, 100), /no index row for tick/);
        assert.strictEqual(db.inserted.length, 0);
    });

    it('a key netting NEGATIVE throws: the ledger released more than it locked', async function(){
        const db = makeDb({ escrows: [
            esc(10, 'ORDER',   SO, T1, 1, '5',  100),
            esc(30, 'COINPAY', SO, T1, 1, '-9', 101)
        ]});
        await W.writeEscrowJournal(db, 100);
        await assert.rejects(() => W.writeEscrowJournal(db, 101), /nets negative/);
    });
});

describe('escrow journal writer: the arming replay @regression', function(){

    const HISTORY = [
        esc(10, 'ORDER',       SO, T1, 1, '100', 90),
        esc(20, 'SWAP',        SM, T2, 2, '30',  95),
        esc(30, 'COINPAY',     SO, T1, 1, '-40', 97),
        esc(40, 'SWAP_EXPIRE', SM, T2, 2, '-30', 99)   // SM fully released
    ];

    it('replay equals incremental accumulation over the same history', async function(){
        const inc = makeDb({ escrows: HISTORY });
        for(const b of [90, 95, 97, 99]) await W.writeEscrowJournal(inc, b);
        const arm = makeDb({ escrows: HISTORY });
        await W.writeEscrowJournal(arm, 500, { full: true });
        const latest = (db, addr, tick) => {
            for(let i = db.journal.length - 1; i >= 0; i--)
                if(db.journal[i].address === addr && db.journal[i].tick === tick) return db.journal[i].locked_amount;
            return undefined;
        };
        assert.strictEqual(latest(arm, SO, T1), latest(inc, SO, T1));
        assert.strictEqual(latest(arm, SO, T1), M.canonicalAmount('60'));
        // A fully released key nets zero in the replay: no leaf, and no row
        // either, because there is no prior journal value to correct.
        assert.strictEqual(latest(arm, SM, T2), undefined);
    });

    it('a long-open position IS recorded even though the arming block touched nothing', async function(){
        const db = makeDb({ escrows: [esc(10, 'ORDER', SO, T1, 1, '100', 90)] });
        assert.strictEqual(await W.writeEscrowJournal(db, 500), 0, 'incremental pass sees nothing at block 500');
        assert.strictEqual(await W.writeEscrowJournal(db, 500, { full: true }), 1);
        assert.strictEqual(db.inserted[0].locked_amount, M.canonicalAmount('100'));
        assert.strictEqual(db.inserted[0].block_index, 500);
    });

    it('the replay is a change log: a re-run writes nothing, a drifted shadow is corrected', async function(){
        const db = makeDb({ escrows: [esc(10, 'ORDER', SO, T1, 1, '100', 90)] });
        await W.writeEscrowJournal(db, 500, { full: true });
        assert.strictEqual(await W.writeEscrowJournal(db, 501, { full: true }), 0);
        // Doctor a drifted shadow value under the replay: ARMED WINS, by writing
        // a correction row rather than trusting what a warm-up wrote.
        db.journal.push({ address: SO, tick: T1, locked_amount: M.canonicalAmount('99'), block_index: 495 });
        assert.strictEqual(await W.writeEscrowJournal(db, 502, { full: true }), 1);
        assert.strictEqual(db.inserted[db.inserted.length - 1].locked_amount, M.canonicalAmount('100'));
    });

    it('the replay cross-checks per-tick totals against SUM(escrows) and throws on mismatch', async function(){
        const db = makeDb({ escrows: [esc(10, 'ORDER', SO, T1, 1, '100', 90)] });
        // Sabotage the SQL side of the comparison: the stub's GROUP BY branch
        // sums the same rows, so doctor its output through a wrapper.
        const orig = db.doQuery.bind(db);
        db.doQuery = async function(sql, args){
            const rows = await orig(sql, args);
            if(sql.indexOf('GROUP BY e.tick_id') !== -1) rows[0].total = '101';
            return rows;
        };
        await assert.rejects(() => W.writeEscrowJournal(db, 500, { full: true }), /disagrees with SUM\(escrows\)/);
    });
});

describe('escrow journal writer: exclusions hold end to end @regression', function(){

    it('ownership locks and native-coin give write NO ledger rows, so the journal never moves', async function(){
        // The exclusions live in the HANDLERS (every ownership path branches
        // before the push; native give creates its obligation at match time), so
        // under ledger attribution there is nothing to exclude here: a block
        // containing only such actions has zero escrow rows. This pins the
        // structural fact the invariant depends on.
        const db = makeDb({ escrows: [] });
        assert.strictEqual(await W.writeEscrowJournal(db, 100), 0);
        assert.strictEqual(db.inserted.length, 0);
    });
});

describe('escrow journal writer: block-path wiring @regression', function(){

    it('the SOURCE calls the writer, full:true exactly at the arming block and the shadow window start', function(){
        // Pinned at source level because both full-pass sites are one-shots: if
        // the flag is wrong at the arming block, nothing later notices and the
        // chain has already committed the wrong balances_root; if it is wrong at
        // the window start, the whole dry run shadows a journal missing every
        // position opened before the window.
        const sc = fs.readFileSync(path.resolve(__dirname, '../../src/stateCommitment.js'), 'utf8');
        assert.ok(/EJW\.writeEscrowJournal\(db, blockIndex, \{ full: armingBlock \|\| windowStart \}\)/.test(sc),
            'computeAndStoreRoots must call the writer with the arming-or-window-start flag');
        // The TRUE arming block must full-replay even when a shadow ran right up
        // to it (armed-wins correction of a drifted shadow journal), so its
        // trigger is the ARMED map alone, never the shadow one.
        assert.ok(/armingBlock = escArmed && !SUB\.isEscrowLockedLeafActive\(blockIndex - 1/.test(sc),
            'the arming block is the first ARMED height, regardless of any preceding shadow window');
        assert.ok(/windowStart = escShadow && !SUB\.isEscrowLockedLeafShadowActive\(blockIndex - 1/.test(sc),
            'the window start is the first SHADOW height');
        const idx = sc.indexOf('EJW.writeEscrowJournal');
        const gate = sc.lastIndexOf('if(escArmed || escShadow)', idx);
        assert.ok(gate !== -1 && idx - gate < 800, 'the writer call must be gated on the escrow leaf being armed or shadowing');
    });

    it('the FOLLOWER never writes the journal (it replicates)', function(){
        const follower = fs.readFileSync(
            path.resolve(__dirname, '../../../xchain-sync/src/stateCommitment.js'), 'utf8');
        assert.ok(!/writeEscrowJournal/.test(follower),
            'xchain-sync must not write escrow_leaf_journal; it replicates the source\'s rows');
    });

    it('the writer never consults family aggregates, status predicates, or a clock', function(){
        // The failure mode this design retired: recomputing what "locked" means.
        // Comments are stripped so prose about the old design cannot trip it.
        const src  = fs.readFileSync(path.resolve(__dirname, '../../src/escrowJournalWriter.js'), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for(const banned of ['getOrderAmountsRemaining', 'getDispenserAmountRemaining', 'getDispenserInfo',
                             'getAddressEscrows', "status = 'open'", 'bet_status'])
            assert.ok(code.indexOf(banned) === -1, 'writer must not use ' + banned + '; totals derive from the ledger rows');
    });
});
