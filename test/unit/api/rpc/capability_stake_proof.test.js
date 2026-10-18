/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The BTC capability-stake proof RPC, backed by the persistent tree nodes
 * written with the block's stakes root.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { getTestConfig } = require('../../../fixtures/config.js');
const Utility = require('../../../../src/utility.js');
const Database = require('../../../../src/db/index.js');
const SC = require('../../../../src/state_commitment/index.js');
const M = require('../../../../src/consensus/merkle.js');
const { buildCapabilitiesRpc } = require('../../../../src/api/rpc/capabilities.js');

const CAPABILITY = 'price';
const HEIGHT = 90210;
const STATE_ROOT = '703f06aaeff3d74cfae24f2d6f924b1cb865e4b5cd6e9d2d68bc927b6e28a99f';
const PK_ONE = '11'.repeat(32);
const PK_TWO = '22'.repeat(32);
const PK_ABSENT = '33'.repeat(32);
const ROWS = [
    { pubkey: PK_ONE, source: 'source-alpha', weight: '4' },
    { pubkey: PK_ONE, source: 'source-beta', weight: '7' },
    { pubkey: PK_TWO, source: 'source-beta', weight: '7' }
];

afterEach(function(){ sinon.restore(); });

function newDb(config){
    const util = new Utility();
    sinon.stub(util, 'logError');
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p',
        { config: config || getTestConfig(), util });
}

async function proofFixture(){
    const store = new SC.MemoryNodeStore();
    const smt = new SC.PersistentSMT(store);
    const total = M.sumCanonicalAmounts(['4', '7']);
    const entries = ROWS.map(row => [
        M.toHex(M.stakeKey(row.pubkey, CAPABILITY)),
        M.toHex(M.stakeMemberLeaf(row.source, row.weight))
    ]);
    entries.push([
        M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAPABILITY)),
        M.toHex(M.stakeTotalLeaf(total))
    ]);
    const stakesRoot = await smt.buildFull(entries);
    const rootRow = {
        state_root: STATE_ROOT,
        balances_root: M.toHex(M.EMPTY_SMT_ROOT),
        stakes_root: stakesRoot,
        contract_state_root: null
    };
    const db = newDb();
    sinon.stub(db, 'getStakeWeightsByCapability').resolves(ROWS);
    sinon.stub(db, 'doQueryStrict').callsFake(async (query, args) => {
        if(/FROM\s+state_tree_roots/i.test(query)) return [rootRow];
        if(/FROM\s+state_tree_nodes/i.test(query)){
            const row = await store.get(args[0]);
            return row ? [row] : [];
        }
        throw new Error('unexpected query: ' + query);
    });
    const rpc = buildCapabilitiesRpc({ indexer: { indexerDb: { apiView: () => db } } });
    return { db, rpc, rootRow, total };
}

function assertMemberProofs(answer, rootRow){
    const one = answer.members[0];
    assert.strictEqual(one.pubkey, PK_ONE);
    assert.deepStrictEqual(one.committed, { source: 'source-beta', weight: '7' });
    assert.strictEqual(one.leaf_value,
        M.toHex(M.stakeMemberLeaf(one.committed.source, one.committed.weight)));
    assert.strictEqual(M.verifySmtProof(rootRow.stakes_root,
        M.stakeKey(PK_ONE, CAPABILITY), one.leaf_value, one.siblings), true);

    const absent = answer.members[2];
    assert.strictEqual(absent.leaf_value, null);
    assert.strictEqual(absent.committed, null);
    assert.strictEqual(M.verifySmtProof(rootRow.stakes_root,
        M.stakeKey(PK_ABSENT, CAPABILITY), null, absent.siblings), true);
}

function assertEnvelope(answer, rootRow, total){
    assert.strictEqual(answer.chain, 'BTC');
    assert.strictEqual(answer.network, 'regtest');
    assert.strictEqual(answer.block_index, HEIGHT);
    assert.deepStrictEqual(answer.sub_roots, {
        balances_root: rootRow.balances_root,
        stakes_root: rootRow.stakes_root
    });
    assert.strictEqual(
        M.toHex(M.stateRoot(answer.sub_roots)),
        rootRow.state_root);
    assertMemberProofs(answer, rootRow);
    assert.strictEqual(answer.total, total);
    assert.strictEqual(M.verifySmtProof(rootRow.stakes_root,
        M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAPABILITY), M.toHex(M.stakeTotalLeaf(total)),
        answer.total_proof.siblings), true);
}

describe('getcapabilitystakeproof @regression @tier1', function(){
    it('proves membership, absence, committed preimages, totals, and state-root assembly', async function(){
        const { rpc, rootRow, total } = await proofFixture();
        const answer = await rpc.getcapabilitystakeproof({
            capability: CAPABILITY,
            block_index: HEIGHT,
            pubkeys: [PK_ONE.toUpperCase(), PK_TWO, PK_ABSENT]
        });
        assertEnvelope(answer, rootRow, total);
    });

    it('returns null when a present member leaf has no matching stake row', async function(){
        const { db, rpc } = await proofFixture();
        db.getStakeWeightsByCapability.resolves([
            { pubkey: PK_ONE, source: 'source-alpha', weight: '4' }
        ]);
        assert.strictEqual(await rpc.getcapabilitystakeproof({
            capability: CAPABILITY, block_index: HEIGHT, pubkeys: [PK_ONE]
        }), null);
    });

    it('answers the BTC-only, parameter, and missing-tree errors', async function(){
        const offBtc = newDb(Object.assign({}, getTestConfig(), { COIN: 'LTC' }));
        assert.deepStrictEqual(await offBtc.getCapabilityStakeProof(CAPABILITY, HEIGHT, []),
            { error: 'STAKES_BTC_ONLY' });

        const db = newDb();
        assert.deepStrictEqual(await db.getCapabilityStakeProof('unknown', HEIGHT, []),
            { error: 'BAD_PARAMS' });
        assert.deepStrictEqual(await db.getCapabilityStakeProof('toString', HEIGHT, []),
            { error: 'BAD_PARAMS' });
        assert.deepStrictEqual(await db.getCapabilityStakeProof(CAPABILITY, String(HEIGHT), []),
            { error: 'BAD_PARAMS' });
        assert.deepStrictEqual(await db.getCapabilityStakeProof(CAPABILITY, Number.MAX_SAFE_INTEGER + 1, []),
            { error: 'BAD_PARAMS' });
        assert.deepStrictEqual(await db.getCapabilityStakeProof(CAPABILITY, HEIGHT, ['not-a-pubkey']),
            { error: 'BAD_PARAMS' });
        assert.deepStrictEqual(await db.getCapabilityStakeProof(CAPABILITY, HEIGHT,
            new Array(257).fill(PK_ONE)), { error: 'BAD_PARAMS' });

        sinon.stub(db, 'doQueryStrict').resolves([]);
        assert.deepStrictEqual(await db.getCapabilityStakeProof(CAPABILITY, HEIGHT, []),
            { error: 'NO_STATE_TREE' });
    });
});
