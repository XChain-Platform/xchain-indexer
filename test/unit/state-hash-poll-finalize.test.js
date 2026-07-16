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
 * VOTE poll-finalization state_hash class (flag-day gated, ARMED 2026-07-07).
 *
 * Promotes the polls finalization flip (an in-place mutation on a SURVIVING
 * row, carried forward by the updated_rows POLL_FINALIZE channel) into the
 * replication-integrity state_hash. Armed mid-chain with per-chain
 * '<COIN>:<network>' heights (regtest from genesis). Asserts: (a) the gate
 * function including the per-chain lookup and the coin-less fail-inert path;
 * (b) below-threshold blocks keep the preimage byte-identical to the
 * pre-feature shape; (c) when active, a divergent finalization outcome (a
 * follower that dropped the flip upsert, or a different winner) yields a
 * DIFFERENT state_hash - i.e. the follower HALTS at the flip block. No DB
 * needed: buildStateHashData is driven with a call-order mock (see the
 * index-map class test, whose harness this mirrors).
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility');
const {
    buildStateHashData, isPollFinalizeStateHashActive, POLL_FINALIZE_STATE_HASH_ACTIVATION,
    TOKEN_SUPPLY_STATE_HASH_ACTIVATION, INDEX_MAP_STATE_HASH_ACTIVATION,
} = require('../../src/stateHash');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];

// db whose doQuery returns canned result-sets in CALL ORDER, getStatusId fixed.
function dbFor(results, completedId){
    let i = 0;
    return { doQuery: async () => results[i++], getStatusId: async () => (completedId === undefined ? null : completedId) };
}

// With activationDelay=null (skips the 4 deactivation queries), completedId=null
// (skips the credits query), and the index-map + token_supply regtest gates
// disarmed for this suite (see before/after), the
// doQuery call order is: slashes x4, request_status x2, cooldown x2,
// anchor_invalid x1. The poll_finalize slot is appended when its gate is active.
function baseResults(){ return [[], [], [], [], [], [], [], [], []]; }

async function build(results){
    const data = await buildStateHashData(dbFor(results || baseResults(), null), 7,
        { activationDelay: null, gasTick: 'XCHAIN', network: 'regtest', coin: 'BTC' });
    return { data, hash: util.getDataHash(data) };
}

// Temporarily set the regtest poll gate around a body, always restoring it.
async function withRegtestHeight(height, fn){
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

describe('state_hash poll-finalize class (VOTE flag-day, armed) @regression', function(){

    // Isolate this suite from the token_supply class (also armed on regtest):
    // its query slot would shift the canned call-order mock.
    let tokenPrev;
    // (index-map likewise: armed on regtest since 2026-07-16, )
    let indexPrev;
    before(function(){
        tokenPrev = TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest; TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest = 999999999;
        indexPrev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;    INDEX_MAP_STATE_HASH_ACTIVATION.regtest    = 999999999;
    });
    after(function(){
        TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest = tokenPrev;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest    = indexPrev;
    });

    it('gate: regtest armed from genesis; mainnet/testnet armed per chain at real heights; coin-less lookup fail-inert', function(){
        assert.strictEqual(isPollFinalizeStateHashActive(0, 'regtest'), true, 'regtest armed at 0 (fresh stacks exercise the class)');
        // Per-chain armed heights exist, are finite, and are real (mid-chain: above 1000).
        for(const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet']){
            const h = POLL_FINALIZE_STATE_HASH_ACTIVATION[key];
            assert.ok(Number.isFinite(h) && h > 1000 && h < 999999999, `${key} must carry a real armed height, got ${h}`);
        }
        // Boundary semantics on a per-chain key.
        const h = POLL_FINALIZE_STATE_HASH_ACTIVATION['BTC:mainnet'];
        assert.strictEqual(isPollFinalizeStateHashActive(h - 1, 'mainnet', 'BTC'), false, 'below threshold');
        assert.strictEqual(isPollFinalizeStateHashActive(h, 'mainnet', 'BTC'), true, 'at threshold');
        // Coin-less lookup on a per-chain-keyed network finds no key -> inert (safe only
        // for coin-less fixture harnesses; both production callers pass coin).
        assert.strictEqual(isPollFinalizeStateHashActive(h + 1, 'mainnet'), false, 'coin-less mainnet lookup stays inert');
        assert.strictEqual(isPollFinalizeStateHashActive(7, 'nonexistent', 'BTC'), false, 'unknown network -> off (safe)');
        assert.strictEqual(isPollFinalizeStateHashActive(7, null, 'BTC'), false);
    });

    it('below threshold: preimage is byte-identical to the pre-feature shape (no poll_finalize key)', async function(){
        await withRegtestHeight(999999999, async () => {
            const { data } = await build();
            assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS,
                'no poll_finalize key below the activation height');
        });
    });

    it('below threshold: state_hash is BLIND to the flip (the polls table is never even queried)', async function(){
        await withRegtestHeight(999999999, async () => {
            const a = await build(baseResults());
            const b = await build(baseResults());
            assert.strictEqual(a.hash, b.hash);
        });
    });

    it('active: the flip is folded in, and a dropped/divergent finalization HALTS (different hash)', async function(){
        const source    = baseResults().concat([[flipRow()]]);
        const dropped   = baseResults().concat([[]]);                                  // follower silently lost the flip upsert
        const divergent = baseResults().concat([[flipRow({ winning_option: 2 })]]);    // follower derived a different winner

        const s = await build(source);
        assert.deepStrictEqual(Object.keys(s.data),
            ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid',
             'poll_finalize', 'block_index', 'state_hash_version'],
            'active preimage inserts poll_finalize before block_index');
        assert.strictEqual(s.data.poll_finalize[0].winning_option, 1);

        const d = await build(dropped);
        const w = await build(divergent);
        assert.notStrictEqual(d.hash, s.hash, 'a dropped finalization flip MUST change state_hash so the follower halts');
        assert.notStrictEqual(w.hash, s.hash, 'a divergent tally outcome MUST change state_hash so the follower halts');
    });

    it('active: an IDENTICAL flip hashes the same (no false halt)', async function(){
        const a = await build(baseResults().concat([[flipRow()]]));
        const b = await build(baseResults().concat([[flipRow()]]));
        assert.strictEqual(a.hash, b.hash);
    });

    it('the poll and token activation maps carry identical heights (the two classes flip together)', function(){
        // This suite disarms the token map's regtest key in before(); compare
        // against the saved original so the isolation shim can't mask real drift.
        const tokenMap = Object.assign({}, TOKEN_SUPPLY_STATE_HASH_ACTIVATION, { regtest: tokenPrev });
        assert.deepStrictEqual(tokenMap, POLL_FINALIZE_STATE_HASH_ACTIVATION,
            'POLL_FINALIZE and TOKEN_SUPPLY activation maps drifted; they were armed as one decision and must flip together');
    });
});
