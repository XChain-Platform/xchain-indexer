/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.contractDelegation-materialize.test.js
 *
 * CONSENSUS REGRESSION GUARD for DELEGATE v1 signing-key rotation (#4366).
 *
 * DELEGATE v1 wrote contract_delegations and stopped there, while all three contract-stake
 * lookup surfaces read contract_stakes.signing_pubkey_id: getContractStakeDataForVM (the VM
 * stake snapshot), getActiveContractStakeByPubkey (the UNSTAKE aggregate) and
 * slashContractStake (the SLASH deduction). The rotated key therefore owned nothing: it never
 * appeared in getStakers, and a SLASH against it deducted zero while the contract recorded the
 * punishment.
 *
 * Fix (proposal B, behind CONTRACT_DELEGATION_MATERIALIZE): materialize the rotation ONTO
 * contract_stakes at the delegation's activation block, journaling the previous key in
 * contract_delegation_rotations so a reorg restores it verbatim. These tests pin the sweep's
 * selection, its idempotency, its determinism under competing delegations, the revoke revert,
 * and the fact that the three read surfaces then agree.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const VALID = 1;

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? VALID : (s === 'pending' ? 2 : null)));
    return db;
}

// Route each query the sweep issues to a canned result, and record every write.
// `state` holds the fake tables the sweep reads.
function wire(db, state) {
    const writes = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        writes.push({ sql, args });
        if (/^\s*UPDATE contract_(?:un)?stakes SET signing_pubkey_id/i.test(sql)) return [];
        if (/^\s*INSERT INTO contract_delegation_rotations/i.test(sql)) return [];
        if (/FROM contract_delegations d\b/i.test(sql))          return state.governing || [];
        // Revert pass, one query per rotated table, scoped by the target_table bind.
        if (/FROM contract_delegation_rotations r\b/i.test(sql))
            return (args && args[0] === 'contract_unstakes')
                ? (state.unstakeRotations || [])
                : (state.rotations || []);
        // The two claimed-elsewhere probes lead on signing_pubkey_id=?; check them before the
        // slot-scoped selects, whose predicate lists also mention target_contract_index.
        if (/FROM contract_stakes[\s\S]*WHERE signing_pubkey_id=\?/i.test(sql))      return state.pubkeyHeldByStake || [];
        if (/FROM contract_delegations[\s\S]*WHERE signing_pubkey_id=\?/i.test(sql)) return state.pubkeyHeldByDelegation || [];
        if (/FROM contract_stakes\b[\s\S]*target_contract_index=\?\s*AND source_id/i.test(sql))
            return state.stakeRows || [];
        if (/FROM contract_unstakes\b[\s\S]*target_contract_index=\?\s*AND source_id/i.test(sql))
            return state.unstakeRows || [];
        return [];
    });
    return writes;
}

const rewrites  = (writes) => writes.filter(w => /UPDATE contract_stakes SET signing_pubkey_id/i.test(w.sql));
const unstakeRewrites = (writes) => writes.filter(w => /UPDATE contract_unstakes SET signing_pubkey_id/i.test(w.sql));
const journals  = (writes) => writes.filter(w => /INSERT INTO contract_delegation_rotations/i.test(w.sql));

afterEach(function () { sinon.restore(); });

describe('Database.materializeContractDelegations() @regression @tier1', function () {

    it('rewrites the delegating source stake rows onto the delegated key and journals the old one', async function () {
        const db = makeDb();
        const writes = wire(db, {
            governing: [{ action_index: 900, source_id: 5, signing_pubkey_id: 77, target_contract_index: 42, tick_id: 20 }],
            stakeRows: [{ action_index: 100, signing_pubkey_id: 11 },
                        { action_index: 101, signing_pubkey_id: 11 }]
        });

        const applied = await db.materializeContractDelegations(306);

        assert.strictEqual(applied.length, 2, 'both stake rows on the slot rotate');
        assert.deepStrictEqual(rewrites(writes).map(w => w.args), [[77, 100], [77, 101]]);
        // The journal must carry the PRE-rotation key and the table, or a reorg cannot restore it.
        assert.deepStrictEqual(journals(writes).map(w => w.args), [
            ['contract_stakes', 900, 100, 11, 77, 306],
            ['contract_stakes', 900, 101, 11, 77, 306]
        ]);
    });

    it('rotates the still-slashable cooldown rows too, so a rotation cannot shield locked tokens', async function () {
        // slashContractStake Pass 2 finds cooldown-locked tokens by (target, pubkey, tick).
        // Leaving contract_unstakes on the old key while the contract is shown the new one
        // would let that portion escape every slash.
        const db = makeDb();
        const writes = wire(db, {
            governing:    [{ action_index: 900, source_id: 5, signing_pubkey_id: 77, target_contract_index: 42, tick_id: 20 }],
            stakeRows:    [],
            unstakeRows:  [{ action_index: 200, signing_pubkey_id: 11 }]
        });

        const applied = await db.materializeContractDelegations(306);

        assert.strictEqual(applied.length, 1);
        assert.strictEqual(applied[0].target_table, 'contract_unstakes');
        assert.deepStrictEqual(unstakeRewrites(writes).map(w => w.args), [[77, 200]]);
        assert.deepStrictEqual(journals(writes).map(w => w.args), [['contract_unstakes', 900, 200, 11, 77, 306]]);
        // Only slashable statuses: a 'completed' cooldown row was already refunded.
        const sel = writes.find(w => /FROM contract_unstakes\b[\s\S]*target_contract_index=\?/i.test(w.sql));
        assert.ok(/status_id IN \(\?,\?\)/.test(sel.sql), 'valid + pending, mirroring slash Pass 2');
    });

    it('selects only the LATEST matured un-revoked delegation per slot, so two live rotations cannot flip-flop', async function () {
        const db = makeDb();
        const writes = wire(db, { governing: [], stakeRows: [] });
        await db.materializeContractDelegations(306);

        const gov = writes.find(w => /FROM contract_delegations d\b/i.test(w.sql));
        assert.ok(gov, 'governing-delegation select ran');
        assert.ok(/NOT EXISTS/i.test(gov.sql), 'a later delegation on the same slot must suppress an earlier one');
        assert.ok(/d2\.activation_block > d\.activation_block/.test(gov.sql), 'ordered by activation_block');
        assert.ok(/d2\.action_index > d\.action_index/.test(gov.sql), 'action_index breaks an equal-activation tie');
        assert.ok(!/ORDER BY[\s\S]*\bid\b/i.test(gov.sql), 'never ordered on the AUTO_INCREMENT id');
        // Matured + not-yet-revoked, evaluated at the swept block.
        assert.deepStrictEqual(gov.args, [VALID, 306, 306, VALID, 306, 306]);
    });

    it('includes pending-activation stake rows, so a top-up cannot resurface under the old key', async function () {
        const db = makeDb();
        const writes = wire(db, {
            governing: [{ action_index: 900, source_id: 5, signing_pubkey_id: 77, target_contract_index: 42, tick_id: 20 }],
            stakeRows: []
        });
        await db.materializeContractDelegations(306);

        const sel = writes.find(w => /FROM contract_stakes[\s\S]*target_contract_index=\?\s*AND source_id/i.test(w.sql));
        assert.ok(sel, 'stake-row select ran');
        assert.ok(!/activation_block\s*<=/.test(sel.sql), 'must not skip rows still inside their activation delay');
        assert.ok(/deactivation_block IS NULL/.test(sel.sql), 'a row already unstaking is not rotated');
        assert.ok(/signing_pubkey_id<>\?/.test(sel.sql), 'rows already on the delegated key are skipped (idempotency)');
    });

    it('is a no-op once materialized (no rewrite, no journal row)', async function () {
        const db = makeDb();
        // The DB-side `signing_pubkey_id<>?` filter returns nothing on a second sweep.
        const writes = wire(db, {
            governing: [{ action_index: 900, source_id: 5, signing_pubkey_id: 77, target_contract_index: 42, tick_id: 20 }],
            stakeRows: []
        });

        const applied = await db.materializeContractDelegations(307);

        assert.deepStrictEqual(applied, []);
        assert.strictEqual(rewrites(writes).length, 0);
        assert.strictEqual(journals(writes).length, 0);
    });

    it('reverts a revoked rotation to the original key using the FIRST journal row', async function () {
        const db = makeDb();
        const writes = wire(db, {
            governing: [],                                     // the delegation was revoked
            rotations: [{ stake_action_index: 100, delegation_action_index: 900,
                          original_pubkey_id: 11, current_pubkey_id: 77,
                          target_contract_index: 42, source_id: 5, tick_id: 20 }],
            pubkeyHeldByStake: [], pubkeyHeldByDelegation: []
        });

        const applied = await db.materializeContractDelegations(400);

        assert.strictEqual(applied.length, 1);
        assert.deepStrictEqual(rewrites(writes).map(w => w.args), [[11, 100]]);
        assert.deepStrictEqual(journals(writes).map(w => w.args), [['contract_stakes', 900, 100, 77, 11, 400]]);
    });

    it('does not revert while a delegation still governs the slot', async function () {
        const db = makeDb();
        const writes = wire(db, {
            governing: [{ action_index: 901, source_id: 5, signing_pubkey_id: 88, target_contract_index: 42, tick_id: 20 }],
            stakeRows: [],                                     // already carries 88
            rotations: [{ stake_action_index: 100, delegation_action_index: 900,
                          original_pubkey_id: 11, current_pubkey_id: 88,
                          target_contract_index: 42, source_id: 5, tick_id: 20 }]
        });

        const applied = await db.materializeContractDelegations(400);

        assert.deepStrictEqual(applied, [], 'the governing delegation owns the slot; no revert');
        assert.strictEqual(rewrites(writes).length, 0);
    });

    it('skips the revert when another staker has claimed the original key', async function () {
        const db = makeDb();
        const writes = wire(db, {
            governing: [],
            rotations: [{ stake_action_index: 100, delegation_action_index: 900,
                          original_pubkey_id: 11, current_pubkey_id: 77,
                          target_contract_index: 42, source_id: 5, tick_id: 20 }],
            pubkeyHeldByStake: [{ 1: 1 }]                      // someone else staked pubkey 11
        });

        const applied = await db.materializeContractDelegations(400);

        assert.deepStrictEqual(applied, [], 'merging two owners under one pubkey is worse than a stale key');
        assert.strictEqual(rewrites(writes).length, 0);
    });

    it('picks the earliest journal row deterministically (block_index, then delegation_action_index)', async function () {
        const db = makeDb();
        const writes = wire(db, { governing: [], rotations: [] });
        await db.materializeContractDelegations(400);

        const sel = writes.find(w => /FROM contract_delegation_rotations r\b/i.test(w.sql));
        assert.ok(sel, 'revert select ran');
        assert.ok(/e\.block_index < r\.block_index/.test(sel.sql), 'earliest by block_index');
        assert.ok(/e\.delegation_action_index < r\.delegation_action_index/.test(sel.sql), 'replay-stable tiebreak');
        assert.ok(!/\be\.id\b|\br\.id\b/.test(sel.sql), 'never keyed on the AUTO_INCREMENT id');
    });

    it('does nothing when the valid status id cannot be resolved', async function () {
        const db = makeDb();
        db.getStatusId.restore();
        sinon.stub(db, 'getStatusId').resolves(null);
        const writes = wire(db, {});
        assert.deepStrictEqual(await db.materializeContractDelegations(306), []);
        assert.strictEqual(writes.length, 0);
    });
});

describe('DELEGATE v1 rotation reaches all three lookup surfaces @regression @tier1', function () {

    // The stake row IS the rotation once materialized, so the VM snapshot shows the new
    // pubkey and a SLASH against it debits that row. Both halves of the ledger's verify
    // criterion, driven through the real query paths with the rotated row in place.
    it('getContractStakeDataForVM lists the rotated pubkey as the staker', async function () {
        const db = makeDb();
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        sinon.stub(db, 'doQuery').resolves([
            // post-materialization row: signing_pubkey_id/pubkey are the DELEGATED key
            { signing_pubkey_id: 77, pubkey: 'BB'.repeat(32), tick_id: 20, tick: 'XCHAIN',
              amount: '10', activation_block: 100, deactivation_block: null }
        ]);

        const snap = await db.getContractStakeDataForVM(42, 306);

        const rotated  = 'bb'.repeat(32);
        const original = 'aa'.repeat(32);
        assert.deepStrictEqual(snap.stakersByTick['XCHAIN'].map(s => s.pubkey), [rotated],
            'getStakers must show the rotated key');
        assert.strictEqual(db.util.bcformat(snap.stakeByPubkeyTick[rotated + '|XCHAIN'], 8), '10.00000000');
        assert.strictEqual(snap.stakeByPubkeyTick[original + '|XCHAIN'], undefined,
            'the pre-rotation key must not linger as a phantom staker');
        assert.strictEqual(db.util.bcformat(snap.totalByTick['XCHAIN'], 8), '10.00000000');
    });

    it('slashContractStake debits the rotated row (no zero-slashed no-op)', async function () {
        const db = makeDb();
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        const seen = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            seen.push({ sql, args });
            // The rotated key (77) is what the row now carries, so the Pass 1 select matches.
            if (/SELECT[\s\S]*FROM contract_stakes/i.test(sql) && args && args[1] === 77)
                return [{ action_index: 100, amount: '10', source_address: 'owner1' }];
            return [];
        });

        const slashed = await db.slashContractStake(42, 77, 20, '4', 306);

        assert.strictEqual(db.util.bcformat(slashed.total, 8), '4.00000000', 'the slash must actually deduct');
        const upd = seen.find(c => /UPDATE contract_stakes SET amount/i.test(c.sql));
        assert.ok(upd, 'the stake row was debited');
        assert.strictEqual(db.util.bcformat(upd.args[0], 8), '6.00000000', 'residual written back');
        assert.strictEqual(upd.args[1], 100, 'on the rotated row itself');
        const debit = seen.find(c => /INSERT INTO contract_slash_debits/i.test(c.sql));
        assert.ok(debit, 'the slash is journaled for reorg restore');
    });

    it('getActiveContractStakeByPubkey resolves the stake under the rotated key', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(77);
        sinon.stub(db, 'getTickerId').resolves(20);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        sinon.stub(db, 'doQuery').resolves([
            { source_id: 5, amount: '10', activation_block: 100, block_index: 90,
              signing_pubkey: 'bb'.repeat(32), tick: 'XCHAIN' }
        ]);

        const agg = await db.getActiveContractStakeByPubkey(42, 'bb'.repeat(32), 'XCHAIN', 306, { undeactivatedOnly: true });

        assert.ok(agg, 'the rotated key owns the stake for UNSTAKE');
        assert.strictEqual(agg.signing_pubkey_id, 77);
        assert.strictEqual(agg.amount, '10.00000000');
        assert.strictEqual(agg.source_id, 5, 'UNSTAKE still checks SOURCE ownership against this');
    });
});

describe('Utility.processContractDelegationMaterializations() flag-day gate @regression @tier1', function () {

    function actionsWith(enabled) {
        return { protocolChanges: { isEnabled: sinon.stub().resolves(enabled) } };
    }

    it('does not touch the DB below the flag-day', async function () {
        const util = new Utility();
        const db   = { materializeContractDelegations: sinon.stub().resolves([]) };
        const actions = actionsWith(false);

        const out = await util.processContractDelegationMaterializations(actions, db, 306);

        assert.deepStrictEqual(out, []);
        assert.ok(db.materializeContractDelegations.notCalled, 'history must replay byte-identically');
        assert.ok(actions.protocolChanges.isEnabled.calledWith('CONTRACT_DELEGATION_MATERIALIZE', 306));
    });

    it('sweeps at/after the flag-day', async function () {
        const util = new Utility();
        const applied = [{ stake_action_index: 100 }];
        const db   = { materializeContractDelegations: sinon.stub().resolves(applied) };

        const out = await util.processContractDelegationMaterializations(actionsWith(true), db, 306);

        assert.deepStrictEqual(out, applied);
        assert.ok(db.materializeContractDelegations.calledOnceWith(306));
    });
});
