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
 * escrow_leaf_journal attribution vectors: the exact locker each ledger row
 * resolves to, one per recipient-keyed site family, with the ORDER_MATCH and
 * SWAP_MATCH orientation pinned in BOTH directions. The entry file
 * escrow_journal_writer.test.js carries why these vectors are the only guard.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const M = require('../../../../src/consensus/merkle.js');
const W = require('../../../../src/consensus/escrowJournalWriter.js');
const { SO, SM, RC, T1, T2, makeDb, esc } = require('./helpers/journal_db.js');

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
});

describe('escrow journal writer: attribution vectors @regression', function(){
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
});

describe('escrow journal writer: attribution vectors @regression', function(){
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
