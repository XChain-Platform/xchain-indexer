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
 * Index-map state_hash class (id determinism).
 *
 * Promotes the index_addresses / index_tickers id->string MAP into every
 * replication-integrity state_hash. Asserts that the map is folded in and a
 * divergent id->address pair
 * (the recovery offset / ^id fork) yields a DIFFERENT state_hash - i.e. a follower
 * would HALT. No DB needed: buildStateHashData is driven with a call-order mock.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../../../src/utility');
const {
    buildStateHashData,
    POLL_FINALIZE_STATE_HASH_ACTIVATION, TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
    BET_STATUS_STATE_HASH_ACTIVATION, ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION,
} = require('../../../../src/consensus/state_hash');

const util = new Utility();
// db whose doQuery returns canned result-sets in CALL ORDER, getStatusId fixed.
function dbFor(results, completedId){
    let i = 0;
    return { doQuery: async () => results[i++], getStatusId: async () => (completedId === undefined ? null : completedId) };
}

// With activationDelay=null (skips the 4 deactivation queries) and completedId=null
// (skips the credits query), buildStateHashData's doQuery call order is:
//   slashes x4, request_status x2, cooldown x2, anchor_invalid x1, [index_addresses, index_tickers]
// So 9 canned empties cover the base classes; the 2 index-map slots follow them.
function baseResults(){ return [[], [], [], [], [], [], [], [], []]; }

async function build(opts, results){
    const data = await buildStateHashData(dbFor(results || baseResults(), null), 7, opts);
    return { data, hash: util.getDataHash(data) };
}

let abhPrev;

describe('state_hash index-map class (id-determinism P4) @regression', () => {
    let pollPrev, tokenPrev, betPrev;
    before(function(){
    pollPrev  = POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest;
    tokenPrev = TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest;
    betPrev   = BET_STATUS_STATE_HASH_ACTIVATION.regtest;
    POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = 999999999;
    TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest  = 999999999;
    BET_STATUS_STATE_HASH_ACTIVATION.regtest    = 999999999;
    abhPrev = ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION.regtest; ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION.regtest = 999999999;
    });
    after(function(){
    POLL_FINALIZE_STATE_HASH_ACTIVATION.regtest = pollPrev;
    TOKEN_SUPPLY_STATE_HASH_ACTIVATION.regtest  = tokenPrev;
    BET_STATUS_STATE_HASH_ACTIVATION.regtest    = betPrev;
    ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION.regtest = abhPrev;
    });

    it('armed: the id map is folded in, and a divergent id->address pair HALTS (different hash)', async function(){
    // Same address string, DIFFERENT deterministic id == the recovery-offset / ^id fork.
    const fromGenesis = baseResults().concat([[{ id: 1, address: 'bc1qSrc' }], [{ id: 2, tick: 'TOKA' }]]);
    const recovered   = baseResults().concat([[{ id: 3, address: 'bc1qSrc' }], [{ id: 2, tick: 'TOKA' }]]);

    const g = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, fromGenesis);
    const r = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, recovered);

    assert.deepStrictEqual(Object.keys(g.data),
    ['deactivations', 'slashes', 'request_status', 'cooldown', 'credits', 'anchor_invalid',
    'index_addresses_new', 'index_tickers_new', 'block_index', 'state_hash_version'],
    'preimage inserts the two index-map keys before block_index');
    assert.deepStrictEqual(g.data.index_addresses_new, [{ id: 1, address: 'bc1qSrc' }]);
    assert.notStrictEqual(r.hash, g.hash,
    'a divergent id->address map MUST change state_hash so the follower halts');
    });

    it('armed: an IDENTICAL id map hashes the same (no false halt across the recovery boundary)', async function(){
    const mapRows = baseResults().concat([[{ id: 1, address: 'bc1qSrc' }], [{ id: 2, tick: 'TOKA' }]]);
    const a = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, mapRows.map(r => r.slice()));
    const b = await build({ activationDelay: null, gasTick: 'XCHAIN', network: 'regtest' }, mapRows.map(r => r.slice()));
    assert.strictEqual(a.hash, b.hash);
    });
});
