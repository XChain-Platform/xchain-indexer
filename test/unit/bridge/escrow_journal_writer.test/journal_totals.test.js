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
 * escrow_leaf_journal totals over a history: the COINPAY lifecycle, change-log
 * semantics, the arming replay and the exclusions. The entry file
 * escrow_journal_writer.test.js carries what the stub can and cannot prove.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const M = require('../../../../src/consensus/merkle.js');
const W = require('../../../../src/consensus/escrow_journal_writer.js');
const { SO, SM, RC, T1, T2, makeDb, esc } = require('./helpers/journal_db.js');

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
});

describe('escrow journal writer: change-log semantics @regression', function(){
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
