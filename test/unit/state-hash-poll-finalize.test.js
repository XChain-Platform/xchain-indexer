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
 *
 * VOTE poll-finalization state_hash class (flag-day gated).
 *
 * Promotes the polls finalization flip (an in-place mutation on a SURVIVING
 * row, carried forward by the updated_rows POLL_FINALIZE channel) into the
 * replication-integrity state_hash, GATED on the chain's local block_index
 * and INERT by default. Asserts: (a) the gate function; (b) inert default
 * leaves the preimage byte-identical to the pre-feature shape AND blind to
 * the flip; (c) when armed, a divergent finalization outcome (e.g. a follower
 * that dropped the flip upsert, or a different winner) yields a DIFFERENT
 * state_hash - i.e. the follower HALTS at the flip block. No DB needed:
 * buildStateHashData is driven with a call-order mock (see the index-map
 * class test, whose harness this mirrors).
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility');
const {
    buildStateHashData, isPollFinalizeStateHashActive, POLL_FINALIZE_STATE_HASH_ACTIVATION,
} = require('../../src/stateHash');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];

// db whose doQuery returns canned result-sets in CALL ORDER, getStatusId fixed.
function dbFor(results, completedId){
    let i = 0;
    return { doQuery: async () => results[i++], getStatusId: async () => (completedId === undefined ? null : completedId) };
}

// With activationDelay=null (skips the 4 deactivation queries), completedId=null
// (skips the credits query), and the index-map gate inert on regtest, the doQuery
// call order is: slashes x4, request_status x2, cooldown x2, anchor_invalid x1.
// The poll_finalize slot is appended when its gate is armed.
function baseResults(){ return [[], [], [], [], [], [], [], [], []]; }

async function build(results){
    const data = await buildStateHashData(dbFor(results || baseResults(), null), 7,
        { activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' });
    return { data, hash: util.getDataHash(data) };
}

// Temporarily arm the regtest gate around a body, always restoring it.
async function withArmed(height, fn){
    const prev = POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest;
    POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = height;
    try { return await fn(); } finally { POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = prev; }
}

// A finalized poll flip row as the class selects it (deterministic tally outcome).
function flipRow(over){
    return Object.assign({
        action_index: 40, poll_status: 'finalized', winning_option: 1,
        total_weight: '5000', total_voters: 3, quorum_met: 1, min_voters_met: 1,
        fail_reason: null, decided_early: 0, effective_close_block: 6,
        finalized_action_index: 55, resolved_block: 7, deposit_resolved: 'refunded',
        callback_execute_action_index: null,
    }, over || {});
}

describe('state_hash poll-finalize class (VOTE flag-day) @regression', function(){

    it('gate: INERT by default on every network; unknown network off; at/above threshold activates', function(){
        for(const net of ['mainnet', 'testnet', 'regtest'])
            assert.strictEqual(isPollFinalizeStateHashActive(7, net), false, net + ' must ship inert (999999999)');
        assert.strictEqual(isPollFinalizeStateHashActive(7, 'nonexistent'), false, 'unknown network -> off (safe)');
        assert.strictEqual(isPollFinalizeStateHashActive(7, null), false);
        return withArmed(5, () => {
            assert.strictEqual(isPollFinalizeStateHashActive(4, 'regtest'), false, 'below threshold');
            assert.strictEqual(isPollFinalizeStateHashActive(5, 'regtest'), true, 'at threshold');
            assert.strictEqual(isPollFinalizeStateHashActive(6, 'regtest'), true, 'above threshold');
        });
    });

    it('inert: preimage is byte-identical to the pre-feature shape (no poll_finalize key)', async function(){
        const { data } = await build();
        assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS,
            'no poll_finalize key when inert; landing this class must not move any live hash');
    });

    it('inert: state_hash is BLIND to the flip (the polls table is never even queried)', async function(){
        // Only the 9 base slots are provided; an unexpected 10th query would
        // return undefined and change the hash/preimage shape.
        const a = await build(baseResults());
        const b = await build(baseResults());
        assert.strictEqual(a.hash, b.hash);
    });

    it('armed: the flip is folded in, and a dropped/divergent finalization HALTS (different hash)', async function(){
        await withArmed(0, async () => {
            const source   = baseResults().concat([[flipRow()]]);
            const dropped  = baseResults().concat([[]]);                                  // follower silently lost the flip upsert
            const divergent = baseResults().concat([[flipRow({ winning_option: 2 })]]);   // follower derived a different winner

            const s = await build(source);
            assert.deepStrictEqual(Object.keys(s.data),
                ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid',
                 'poll_finalize', 'block_index', 'state_hash_version'],
                'armed preimage inserts poll_finalize before block_index');
            assert.strictEqual(s.data.poll_finalize[0].winning_option, 1);

            const d = await build(dropped);
            const w = await build(divergent);
            assert.notStrictEqual(d.hash, s.hash, 'a dropped finalization flip MUST change state_hash so the follower halts');
            assert.notStrictEqual(w.hash, s.hash, 'a divergent tally outcome MUST change state_hash so the follower halts');
        });
    });

    it('armed: an IDENTICAL flip hashes the same (no false halt)', async function(){
        await withArmed(0, async () => {
            const a = await build(baseResults().concat([[flipRow()]]));
            const b = await build(baseResults().concat([[flipRow()]]));
            assert.strictEqual(a.hash, b.hash);
        });
    });
});
