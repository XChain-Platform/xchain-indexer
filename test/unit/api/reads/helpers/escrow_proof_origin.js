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
 * The origin-node fixture shared by the getbridgeescrowproof divergence suites: an indexer
 * Database whose SQL answers are stubbed over a real persistent SMT, a later checkpoint signed
 * over the real XCHECKPOINT canonical, and a proof client loaded after the transport stubs.
 */

'use strict';

const sinon  = require('sinon');

const { getTestConfig } = require('../../../../fixtures/config');
const Utility  = require('../../../../../src/utility');
const Database = require('../../../../../src/db');
const SC  = require('../../../../../src/state_commitment/index.js');
const M   = require('../../../../../src/consensus/merkle.js');
const SUB = require('../../../../../src/consensus/gates/state_subtree_gate.js');
const checkpointSource = require('../../../../../src/consensus/bridge_proof_client/checkpoint_source.js');
const { sign } = require('../../../bridge/bridge_settle.test/helpers/settle_fixtures.js');

const NETWORK = 'regtest';
const CHAIN   = 'BTC';
const TICK    = 'XCHAIN';
const HEIGHT  = 9999;
const ESCROW_ADDR = 'mfbtcbridgedogeXXXXXXXXXXXXXUXTr4m';
const BALANCE = '12.5';
const DIVERGED_TEXT = 'escrow state at that block_index does not reassemble to the signed checkpoint state_root';

function newDb(){
    const util = new Utility();
    sinon.stub(util, 'logError');
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
}

// The origin node's committed tree at HEIGHT holds BALANCE at the escrow key. `signedBalance`
// is the balance the SIGNED checkpoint's state_root commits instead: equal to BALANCE for an
// honest node, different for a node whose state at HEIGHT is not the signed state.
async function originNode(opts){
    const memStore = new SC.MemoryNodeStore();
    const smt      = new SC.PersistentSMT(memStore);
    const key      = M.balanceKey(CHAIN, NETWORK, ESCROW_ADDR, TICK);
    const balancesRoot = await smt.update(SC.EMPTY_ROOT_HEX, key, M.toHex(M.amountLeaf(BALANCE)));
    const stakesRoot   = M.toHex(M.EMPTY_SMT_ROOT);

    const signedSmt  = new SC.PersistentSMT(new SC.MemoryNodeStore());
    const signedBal  = await signedSmt.update(SC.EMPTY_ROOT_HEX, key, M.toHex(M.amountLeaf(opts.signedBalance)));
    const signedRoot = opts.stateRoot !== undefined ? opts.stateRoot
        : M.toHex(M.stateRoot({ balances_root: signedBal, stakes_root: stakesRoot }));
    const checkpointRow = { checkpoint_seq: 3, snapshot_block: HEIGHT, state_root: signedRoot,
                            state_root_version: SUB.stateRootVersion(HEIGHT, NETWORK, CHAIN) };

    const tip = opts.tip !== undefined ? opts.tip : HEIGHT + 1000;
    const db = newDb();
    sinon.stub(db, 'doQueryStrict').callsFake(async (query, args) => {
        // The newest signed row the mirror holds. By default the stream is live (the federation
        // has signed at this node's tip); opts.streamStopped stops it at the highest row held.
        if(/MAX\(block_index\)/i.test(query) && /FROM\s+state_checkpoints/i.test(query)){
            if(!opts.streamStopped) return [{ newest_block: tip }];
            const held = [HEIGHT].concat((opts.later || []).map(r => r.block_index));
            return [{ newest_block: Math.max.apply(null, held) }];
        }
        // A later-checkpoint read: the selector's bounded candidates (block_index >= ?) or a
        // keyset page (block_index <= tip, after the last (block_index, checkpoint_seq) read),
        // answered in the query's own order and under its own LIMIT, as the table would.
        if(/FROM\s+state_checkpoints/i.test(query) && /block_index >= \?|checkpoint_seq < \?/.test(query)){
            let rows = (opts.later || []).slice();
            if(/block_index >= \?/.test(query)) rows = rows.filter(r => r.block_index >= args[2]);
            else rows = rows.filter(r => r.block_index <= args[2] &&
                (r.block_index > args[3] || (r.block_index === args[4] && r.checkpoint_seq < args[5])));
            rows.sort((x, y) => (x.block_index - y.block_index) || (y.checkpoint_seq - x.checkpoint_seq));
            const limit = /LIMIT\s+(\d+)/i.exec(query);
            return limit ? rows.slice(0, Number(limit[1])) : rows;
        }
        if(/FROM\s+state_tree_nodes/i.test(query)){
            const row = await memStore.get(args[0]);
            return row ? [row] : [];
        }
        // opts.rootsAt[height] stands for this node's roots at a height after a local reorg.
        if(/FROM\s+state_tree_roots/i.test(query))
            return [(opts.rootsAt && opts.rootsAt[args[2]]) ||
                    { balances_root: balancesRoot, stakes_root: stakesRoot, contract_state_root: null }];
        if(/FROM\s+state_checkpoints/i.test(query)) return [checkpointRow];
        return [{ cr: BALANCE, dr: '0' }];
    });
    sinon.stub(db, 'getLatestBlockIndex').resolves(tip);
    if(opts.validators){
        sinon.stub(db, 'getStakeWeightsByCapability').resolves(opts.validators);
        sinon.stub(db, 'getValidatorsByCapability').resolves(opts.validators);
    }
    return { db, checkpointRow, ownRoot: M.toHex(M.stateRoot({ balances_root: balancesRoot, stakes_root: stakesRoot })) };
}

// A later checkpoint row at `height` over `stateRoot`, signed by `signers` over the real
// XCHECKPOINT canonical the consumer's selector re-verifies.
function laterCheckpoint(height, stateRoot, signers, seq){
    const cp = { chain: CHAIN, network: NETWORK, block_index: height, block_hash: 'aa'.repeat(32),
                 ledger_hash: 'bb'.repeat(32), actions_hash: 'cc'.repeat(32), contract_hash: 'dd'.repeat(32),
                 checkpoint_seq: seq || 9, snapshot_block: height, state_root: stateRoot,
                 state_root_version: SUB.stateRootVersion(height, NETWORK, CHAIN),
                 block_merkle_root: null, block_merkle_version: null };
    const canonical = checkpointSource.checkpointCanonical(cp);
    cp.validator_signatures = JSON.stringify(signers.map(k => ({ pubkey: k.pubkey, sig: sign(k.privateKey, canonical) })));
    return cp;
}

// A copy of bridge_proof_client.js loaded after the stubs are in place, so its load-time
// destructure of transport.js and checkpoint_source.js picks them up.
function freshProofClient(){
    const p = require.resolve('../../../../../src/consensus/bridge_proof_client.js');
    const saved = require.cache[p];
    delete require.cache[p];
    try { return require(p); }
    finally { require.cache[p] = saved; }
}

module.exports = {
    NETWORK, CHAIN, TICK, HEIGHT, ESCROW_ADDR, BALANCE, DIVERGED_TEXT,
    newDb, originNode, laterCheckpoint, freshProofClient,
};
