/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.slash-capability-stake.test.js
 *
 * SLASH-1: slashCapabilityStake Pass 1 filtered `activation_block <= block`, so an
 * equivocator's pending-activation top-up (debited at STAKE time) escaped the bond
 * burn and could later be UNSTAKEd/refunded. At/after the SLASH_BURNS_PENDING_STAKE
 * flag-day the caller passes burnPending=true and the whole locked bond burns,
 * activated or not. These mock-based tests (doQuery stubbed) lock the query shape in
 * both regimes and confirm a pending row is zeroed when burnPending is set.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb(stakeRows) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
    sinon.stub(db, 'doQuery').callsFake((query, args) => {
        calls.push({ query, args });
        // Only the Pass-1 stakes SELECT returns rows; Pass-2 (unstakes) + the UPDATEs/INSERTs are empty.
        if (/FROM stakes\b/.test(query)) return Promise.resolve(stakeRows || []);
        return Promise.resolve([]);
    });
    db._calls = calls;
    return db;
}

afterEach(() => sinon.restore());

describe('slashCapabilityStake burn-pending gate (SLASH-1) @regression @tier1', function () {

    function stakesSelect(db) {
        return db._calls.find(c => /FROM stakes\b/.test(c.query));
    }

    it('below the flag (burnPending=false) keeps the activation_block filter', async function () {
        const db = makeDb([]);
        await db.slashCapabilityStake(7, 200, 999, false);
        const q = stakesSelect(db);
        assert.match(q.query, /activation_block <= \?/, 'legacy path gates on activation');
        assert.ok(q.args.includes(200), 'blockIndex bound for the activation filter');
        assert.match(q.query, /deactivation_block IS NULL/, 'double-burn guard stays');
    });

    it('at/after the flag (burnPending=true) drops the activation_block filter', async function () {
        const db = makeDb([]);
        await db.slashCapabilityStake(7, 200, 999, true);
        const q = stakesSelect(db);
        assert.doesNotMatch(q.query, /activation_block <= \?/, 'pending stakes are no longer excluded');
        assert.match(q.query, /deactivation_block IS NULL/, 'double-burn guard still stays');
        assert.deepStrictEqual(q.args, [7, 1], 'only pubkeyId + valid_id bound (no blockIndex activation arg)');
    });

    it('burns a pending-activation stake row when burnPending=true', async function () {
        // A pending top-up (activation_block > slash block) is returned by the capped query and zeroed.
        const db = makeDb([{ action_index: 51, amount: '500.00000000' }]);
        const burned = await db.slashCapabilityStake(7, 200, 999, true);
        const updates = db._calls.filter(c => /UPDATE stakes SET amount/.test(c.query));
        assert.strictEqual(updates.length, 1, 'the pending row is zeroed');
        assert.ok(db.util.bcgt(burned, '0'), 'the pending row contributes to the burned total');
    });
});

/*********************************************************************
 * : an equivocating DELEGATED key must burn the stake behind it.
 *
 * A delegated key signs for a staker but owns no stake: the `stakes` rows carry
 * the OWNER's source_id. Burning by signing_pubkey_id therefore matched zero
 * rows and burned NOTHING, while the SLASH still recorded as valid, so
 * equivocating through a delegated key was free. These pin the resolution:
 * target the owning source, resolve the mapping at the EQUIVOCATION height, and
 * burn min(target, remaining) so later stake motion cannot change the outcome.
 ********************************************************************/
describe('slashCapabilityStake delegated-key targeting (#3163) @regression @tier1', function () {

    function selectFor(db, table) {
        return db._calls.find(c => new RegExp('SELECT action_index, amount FROM ' + table).test(c.query));
    }

    it('burns by the OWNING source_id when an ownerSourceId is supplied', async function () {
        const db = makeDb([{ action_index: 11, amount: '500.00000000' }]);
        const burned = await db.slashCapabilityStake(/*pubkeyId*/ 7, 900, 1000, true, /*ownerSourceId*/ 42);

        for (const table of ['stakes', 'unstakes']) {
            const sel = selectFor(db, table);
            assert.ok(sel, table + ' select must run');
            assert.match(sel.query, /WHERE source_id=\?/,
                table + ' must target the owning source, not the delegated pubkey');
            assert.doesNotMatch(sel.query, /signing_pubkey_id=\?/,
                table + ' must not also match the delegated pubkey (double-count risk)');
            assert.strictEqual(sel.args[0], 42, table + ' must be keyed on the owner id');
        }
        assert.strictEqual(String(burned), '500', 'the owner bond must actually burn');
    });

    it('keeps signing_pubkey_id targeting for a key that stakes in its own name', async function () {
        const db = makeDb([{ action_index: 11, amount: '500.00000000' }]);
        const burned = await db.slashCapabilityStake(7, 900, 1000, true, null);

        const sel = selectFor(db, 'stakes');
        assert.match(sel.query, /WHERE signing_pubkey_id=\?/,
            'a self-staking offender keeps the original targeting');
        assert.strictEqual(sel.args[0], 7);
        assert.strictEqual(String(burned), '500');
    });

    // The three stake states the spec pins, all against a delegated offender.
    it('vector: INTACT owner stake burns in full', async function () {
        const db = makeDb([{ action_index: 11, amount: '500.00000000' }]);
        assert.strictEqual(String(await db.slashCapabilityStake(7, 900, 1000, true, 42)), '500');
    });

    it('vector: PARTIALLY unstaked owner stake burns only what remains', async function () {
        // The row still exists but has been drawn down; min(target, remaining) is
        // structural here (each row is zeroed for exactly what it holds).
        const db = makeDb([{ action_index: 11, amount: '120.50000000' }]);
        assert.strictEqual(String(await db.slashCapabilityStake(7, 900, 1000, true, 42)), '120.5');
    });

    it('vector: EMPTIED owner stake burns zero and does NOT throw or reject', async function () {
        const db = makeDb([]);   // fully unstaked and withdrawn: nothing left to burn
        const burned = await db.slashCapabilityStake(7, 900, 1000, true, 42);
        assert.strictEqual(String(burned), '0',
            'a proof against an emptied stake burns zero rather than failing; the outcome ' +
            'must not depend on stake motion after the offence');
    });

    it('zero-amount rows are skipped rather than re-burned', async function () {
        const db = makeDb([{ action_index: 11, amount: '0' }, { action_index: 12, amount: '5.00000000' }]);
        assert.strictEqual(String(await db.slashCapabilityStake(7, 900, 1000, true, 42)), '5');
    });
});

describe('getStakeSourceForDelegatedPubkey (#3163) @regression @tier1', function () {

    function makeResolver(rows) {
        const config = getTestConfig();
        const util   = new Utility();
        sinon.stub(util, 'logError');
        const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
        sinon.stub(db, 'getStatusId').resolves(1);
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve(rows || []); });
        db._calls = calls;
        return db;
    }

    it('resolves the delegation in force AT the equivocation height', async function () {
        const db = makeResolver([{ source_id: 42 }]);
        const src = await db.getStakeSourceForDelegatedPubkey(7, 900);
        assert.strictEqual(src, 42);
        const q = db._calls[0];
        assert.match(q.query, /FROM delegations/);
        assert.match(q.query, /activation_block <= \?/);
        assert.match(q.query, /deactivation_block IS NULL OR deactivation_block > \?/);
        // The height is the EQUIVOCATION block, not the processing block: a delegation
        // revoked after the offence must not orphan the proof.
        assert.deepStrictEqual(q.args, [7, 1, 900, 900]);
    });

    it('returns null for a key that was never delegated', async function () {
        const db = makeResolver([]);
        assert.strictEqual(await db.getStakeSourceForDelegatedPubkey(7, 900), null);
    });

    it('returns null on an unusable pubkey id or height instead of guessing', async function () {
        const db = makeResolver([{ source_id: 42 }]);
        assert.strictEqual(await db.getStakeSourceForDelegatedPubkey(null, 900), null);
        assert.strictEqual(await db.getStakeSourceForDelegatedPubkey(7, undefined), null);
        assert.strictEqual(db._calls.length, 0, 'no query should run on unusable input');
    });
});
