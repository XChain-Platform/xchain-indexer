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
 * tokens.supply state_hash class (F-1 closure; flag-day gated, ARMED 2026-07-07).
 *
 * The hash twin of the updated_rows tokens-supply replication class: supply is
 * mutated IN PLACE on a surviving token row, so before this class a follower
 * silently dropping the supply upsert served a stale supply with no halt (the
 * known F-1 gap). Asserts: (a) the per-chain gate; (b) below-threshold blocks
 * keep the preimage byte-identical to the pre-feature shape; (c) when active,
 * a dropped or divergent supply yields a DIFFERENT state_hash so the follower
 * HALTS at the block whose ledger activity moved the supply. Call-order mock
 * harness, mirroring the poll-finalize and index-map class tests.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility');
const {
    buildStateHashData, isTokenSupplyStateHashActive, TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
    POLL_FINALIZE_STATE_HASH_ACTIVATION, INDEX_MAP_STATE_HASH_ACTIVATION,
    BET_STATUS_STATE_HASH_ACTIVATION,
} = require('../../src/stateHash');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];

// db whose doQuery returns canned result-sets in CALL ORDER, getStatusId fixed.
function dbFor(results, completedId){
    let i = 0;
    return { doQuery: async () => results[i++], getStatusId: async () => (completedId === undefined ? null : completedId) };
}

// With activationDelay=null (skips the 4 deactivation queries), completedId=null
// (skips the credits query), and the index-map + poll_finalize regtest gates
// disarmed for this suite (see before/after), the
// doQuery call order is: slashes x4, request_status x2, cooldown x2,
// anchor_invalid x1. The token_supply slot is appended when its gate is active.
function baseResults(){ return [[], [], [], [], [], [], [], [], []]; }

async function build(results){
    const data = await buildStateHashData(dbFor(results || baseResults(), null), 7,
        { activationDelay: null, gasTick: 'XCHAIN', network: 'regtest', coin: 'BTC' });
    return { data, hash: util.getDataHash(data) };
}

async function withRegtestHeight(height, fn){
    const prev = TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest;
    TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest = height;
    try { return await fn(); } finally { TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest = prev; }
}

describe('state_hash token-supply class (F-1 closure, armed) @regression', function(){

    // Isolate this suite from the poll_finalize class (also armed on regtest):
    // its query slot would shift the canned call-order mock.
    // (index-map likewise: armed on regtest since 2026-07-16, )
    let pollPrev, indexPrev, betPrev;
    before(function(){
        pollPrev  = POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest; POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = 999999999;
        indexPrev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;     INDEX_MAP_STATE_HASH_ACTIVATION.regtest    = 999999999;
        betPrev   = BET_STATUS_STATE_HASH_ACTIVATION.regtest;    BET_STATUS_STATE_HASH_ACTIVATION.regtest   = 999999999;
    });
    after(function(){
        POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = pollPrev;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest     = indexPrev;
        BET_STATUS_STATE_HASH_ACTIVATION.regtest    = betPrev;
    });

    it('gate: regtest armed from genesis; mainnet/testnet armed per chain; coin-less lookup fail-inert', function(){
        assert.strictEqual(isTokenSupplyStateHashActive(0, 'regtest'), true, 'regtest armed at 0');
        for(const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet']){
            const h = TOKEN_SUPPLY_STATE_HASH_ACTIVATION[key];
            assert.ok(Number.isFinite(h) && h > 1000 && h < 999999999, `${key} must carry a real armed height, got ${h}`);
        }
        const h = TOKEN_SUPPLY_STATE_HASH_ACTIVATION['DOGE:mainnet'];
        assert.strictEqual(isTokenSupplyStateHashActive(h - 1, 'mainnet', 'DOGE'), false, 'below threshold');
        assert.strictEqual(isTokenSupplyStateHashActive(h, 'mainnet', 'DOGE'), true, 'at threshold');
        assert.strictEqual(isTokenSupplyStateHashActive(h + 1, 'mainnet'), false, 'coin-less mainnet lookup stays inert');
        assert.strictEqual(isTokenSupplyStateHashActive(7, 'nonexistent', 'BTC'), false, 'unknown network -> off (safe)');
    });

    it('below threshold: preimage is byte-identical to the pre-feature shape (no token_supply key)', async function(){
        await withRegtestHeight(999999999, async () => {
            const { data } = await build();
            assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS,
                'no token_supply key below the activation height');
        });
    });

    it('active: supply is folded in, and a stale/dropped supply HALTS (different hash)', async function(){
        // The class reads the follower's OWN tokens rows: a follower that dropped
        // the supply upsert still has the row, with the OLD supply value.
        const source = baseResults().concat([[{ tick: 'TOKA', supply: '1500' }]]);
        const stale  = baseResults().concat([[{ tick: 'TOKA', supply: '1000' }]]);

        const s = await build(source);
        assert.deepStrictEqual(Object.keys(s.data),
            ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid',
             'token_supply', 'block_index', 'state_hash_version'],
            'active preimage inserts token_supply before block_index');
        assert.deepStrictEqual(s.data.token_supply, [{ tick: 'TOKA', supply: '1500' }]);

        const st = await build(stale);
        assert.notStrictEqual(st.hash, s.hash,
            'a stale supply on the follower MUST change state_hash so it halts instead of serving the old supply');
    });

    it('active: an IDENTICAL supply set hashes the same (no false halt)', async function(){
        const rows = () => baseResults().concat([[{ tick: 'TOKA', supply: '1500' }, { tick: 'TOKB', supply: '7' }]]);
        const a = await build(rows());
        const b = await build(rows());
        assert.strictEqual(a.hash, b.hash);
    });
});
