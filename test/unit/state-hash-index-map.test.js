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
 * Index-map state_hash class (id-determinism P4).
 *
 * Promotes the index_addresses / index_tickers id->string MAP into the
 * replication-integrity state_hash, GATED on the chain's local block_index and
 * INERT by default. Asserts: (a) the gate function; (b) inert default leaves the
 * preimage byte-identical to the pre-feature shape (no new keys) AND blind to the
 * id map; (c) when armed, the map is folded in and a divergent id->address pair
 * (the recovery offset / ^id fork) yields a DIFFERENT state_hash - i.e. a follower
 * would HALT. No DB needed: buildStateHashData is driven with a call-order mock.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../src/utility');
const {
    buildStateHashData, isIndexMapStateHashActive, INDEX_MAP_STATE_HASH_ACTIVATION,
    POLL_FINALIZE_STATE_HASH_ACTIVATION, TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
    BET_STATUS_STATE_HASH_ACTIVATION,
} = require('../../src/stateHash');

const util = new Utility();
const PREFEATURE_KEYS = ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid', 'block_index', 'state_hash_version'];

// db whose doQuery returns canned result-sets in CALL ORDER, getStatusId fixed.
function dbFor(results, completedId){
    let i = 0;
    return { doQuery: async () => results[i++], getStatusId: async () => (completedId === undefined ? null : completedId) };
}

// With activationDelay=null (skips the 4 deactivation queries) and completedId=null
// (skips the credits query), buildStateHashData's doQuery call order is:
//   slashes x4, request_status x2, cooldown x2, anchor_invalid x1, [index_addresses, index_tickers]
// So 9 canned empties cover the base classes; the 2 index-map slots are appended when active.
function baseResults(){ return [[], [], [], [], [], [], [], [], []]; }

async function build(opts, results){
    const data = await buildStateHashData(dbFor(results || baseResults(), null), 7, opts);
    return { data, hash: util.getDataHash(data) };
}

// Temporarily arm the regtest gate around a body, always restoring it.
async function withArmed(height, fn){
    const prev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;
    INDEX_MAP_STATE_HASH_ACTIVATION.regtest = height;
    try { return await fn(); } finally { INDEX_MAP_STATE_HASH_ACTIVATION.regtest = prev; }
}

describe('state_hash index-map class (id-determinism P4) @regression', function(){

    // Isolate this suite from the poll_finalize / token_supply classes (armed on
    // regtest since 2026-07-07): their query slots would shift the canned
    // call-order mock and their preimage keys would break the shape assertions.
    // The index-map class itself is also disarmed suite-locally (armed on regtest
    // since 2026-07-16) so the inert-shape tests below still exercise the
    // below-threshold preimage; withArmed() re-arms per test.
    let pollPrev, tokenPrev, indexPrev, betPrev;
    before(function(){
        pollPrev  = POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest;
        tokenPrev = TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest;
        indexPrev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;
        betPrev   = BET_STATUS_STATE_HASH_ACTIVATION.regtest;
        POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = 999999999;
        TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest  = 999999999;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest     = 999999999;
        BET_STATUS_STATE_HASH_ACTIVATION.regtest    = 999999999;
    });
    after(function(){
        POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = pollPrev;
        TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest  = tokenPrev;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest     = indexPrev;
        BET_STATUS_STATE_HASH_ACTIVATION.regtest    = betPrev;
    });

    it('gate: every network armed at genesis (height 0, regtest via); at/above threshold activates', function(){
        assert.strictEqual(indexPrev, 0, 'regtest armed from genesis');
        assert.strictEqual(isIndexMapStateHashActive(7, 'regtest'), false, 'suite-local disarm holds (inert-shape tests depend on it)');
        assert.strictEqual(isIndexMapStateHashActive(7, 'mainnet'), true, 'mainnet armed at genesis (0)');
        assert.strictEqual(isIndexMapStateHashActive(7, 'testnet'), true, 'testnet armed at genesis (0)');
        assert.strictEqual(isIndexMapStateHashActive(7, 'nonexistent'), false, 'unknown network -> off (safe)');
        assert.strictEqual(isIndexMapStateHashActive(7, null), false);
        return withArmed(5, () => {
            assert.strictEqual(isIndexMapStateHashActive(4, 'regtest'), false, 'below threshold');
            assert.strictEqual(isIndexMapStateHashActive(5, 'regtest'), true, 'at threshold');
            assert.strictEqual(isIndexMapStateHashActive(6, 'regtest'), true, 'above threshold');
        });
    });

    it('inert: preimage is byte-identical to the pre-feature shape (no index-map keys)', async function(){
        const { data } = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' });
        assert.deepStrictEqual(Object.keys(data), PREFEATURE_KEYS,
            'no index_addresses_new / index_tickers_new key when inert');
    });

    it('inert: state_hash is BLIND to the id map (a divergent map hashes the same)', async function(){
        // 9th canned slot is anchor_invalid; the index-map rows are NOT queried when inert,
        // so two different id maps must produce the SAME inert hash.
        const a = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, baseResults());
        const b = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, baseResults());
        assert.strictEqual(a.hash, b.hash);
    });

    it('armed: the id map is folded in, and a divergent id->address pair HALTS (different hash)', async function(){
        await withArmed(0, async () => {
            // Same address string, DIFFERENT deterministic id == the recovery-offset / ^id fork.
            const fromGenesis = baseResults().concat([[{ id: 1, address: 'bc1qSrc' }], [{ id: 2, tick: 'TOKA' }]]);
            const recovered   = baseResults().concat([[{ id: 3, address: 'bc1qSrc' }], [{ id: 2, tick: 'TOKA' }]]);

            const g = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, fromGenesis);
            const r = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, recovered);

            assert.deepStrictEqual(Object.keys(g.data),
                ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid',
                 'index_addresses_new', 'index_tickers_new', 'block_index', 'state_hash_version'],
                'armed preimage inserts the two index-map keys before block_index');
            assert.deepStrictEqual(g.data.index_addresses_new, [{ id: 1, address: 'bc1qSrc' }]);
            assert.notStrictEqual(r.hash, g.hash,
                'a divergent id->address map MUST change state_hash so the follower halts');
        });
    });

    it('armed: an IDENTICAL id map hashes the same (no false halt across the recovery boundary)', async function(){
        await withArmed(0, async () => {
            const mapRows = baseResults().concat([[{ id: 1, address: 'bc1qSrc' }], [{ id: 2, tick: 'TOKA' }]]);
            const a = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, mapRows.map(r => r.slice()));
            const b = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, mapRows.map(r => r.slice()));
            assert.strictEqual(a.hash, b.hash);
        });
    });
});
