'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

const assert = require('assert');
const sinon  = require('sinon');
const M      = require('../../../../src/consensus/merkle.js');
const SUB    = require('../../../../src/state_subtree_activation.js');
const CHK    = require('../../../../src/consensus/bridge_checkpoint_check.js');

const R = CHK.ESCROW_PROOF_REASON;

// The rail's shape: XCHAIN locked on BTC to a DOGE address, DOGE mints.
const NETWORK     = 'regtest';
const ORIGIN      = 'BTC';
const DEST        = 'DOGE';
const TICK        = 'XCHAIN';
// One escrow address per network, and deliberately DIFFERENT strings. The balance key commits
// chain and network, so a resolver that read the role at the wrong network would derive a
// different key and a different address, and the testnet cases below would stop verifying
// instead of quietly proving the same fixture twice.
const ESCROW_ADDRS = {
    regtest: 'mBridgeDogeEscrowXXXXXXXXXXXXXXXXX',
    testnet: 'mBridgeDogeEscrowTestnetXXXXXXXXXX',
};
const ESCROW_ADDR = ESCROW_ADDRS[NETWORK];
const SNAPSHOT    = 1200;
const CP_HEIGHT   = 1205;          // the first checkpoint at or after snapshot_block

// Heights the sub-tree activation maps really key on today, measured not assumed:
// contract_state_root arms on BTC:regtest at 10000 and the balances_root escrow leaf at
// 11200, so regtest is the one chain with a boundary on both sides. All three testnet chains
// are armed from genesis, so testnet has no below-boundary side at all and every genuine
// testnet checkpoint carries version 2. The first case in the version block asserts all of
// this, so a map move retires these fixtures loudly rather than collapsing them into one case.
const V1_HEIGHT        = 9999;     // BTC:regtest, below contract_state_root
const V2_HEIGHT        = 10000;    // BTC:regtest, at contract_state_root
const V2_ESCROW_HEIGHT = 11200;    // BTC:regtest, at the escrow locked leaf
const TESTNET_HEIGHT   = 150000;   // BTC:testnet, an ordinary live height

// A second, unrelated balance leaf, so balances_root is not a one-leaf tree and the escrow
// proof carries real siblings rather than the empty constants at every depth.
const OTHER_ADDR  = 'mSomeOtherHolderXXXXXXXXXXXXXXXXXX';

// Build a balances sub-tree holding the escrow balance plus one unrelated holder, and return
// everything a producer would hand over: the root, the escrow inclusion proof, and the tree
// itself for the tests that need to re-prove a different key.
function buildBalances(escrowBalance, network){
    const net    = network || NETWORK;
    const escrow = ESCROW_ADDRS[net];
    const smt = new M.SparseMerkleTree();
    if(M.canonicalAmount(escrowBalance) !== M.canonicalAmount('0'))
        smt.set(M.balanceKey(ORIGIN, net, escrow, TICK), M.amountLeaf(escrowBalance));
    smt.set(M.balanceKey(ORIGIN, net, OTHER_ADDR, TICK), M.amountLeaf('41.5'));
    return {
        smt,
        root:  smt.rootHex(),
        proof: smt.prove(M.balanceKey(ORIGIN, net, escrow, TICK)),
    };
}

// A full, valid envelope for an escrow holding `escrowBalance`. Sub-roots are assembled the
// way stateCommitment.assembleStateRoot assembles them, so the checkpoint's state_root is a
// real state_root and not a stand-in.
//
// opts: { network, cpHeight, version, subRoots }. `version` defaults to the DERIVED value at
// the fixture's own height, chain and network, which is what a producing node stamps
// (api.js getblockhashes) and what the hub copies into the signed canonical. Passing it
// explicitly is how the refusal cases stamp a wrong one. `subRoots` adds named slots beyond
// the two a v1 assembly commits, for the version-2 layout cases.
function buildProof(escrowBalance, opts){
    const o       = opts || {};
    const net     = o.network  || NETWORK;
    const height  = (o.cpHeight !== undefined) ? o.cpHeight : CP_HEIGHT;
    const version = (o.version  !== undefined) ? o.version  : SUB.stateRootVersion(height, net, ORIGIN);
    const balances = buildBalances(escrowBalance, net);
    const subRoots = Object.assign(
        { balances_root: balances.root, stakes_root: M.toHex(M.EMPTY_SMT_ROOT) },
        o.subRoots || {});
    return {
        chain:       ORIGIN,
        network:     net,
        block_index: height,
        sub_roots:   subRoots,
        address:     ESCROW_ADDRS[net],
        tick:        TICK,
        balance:     escrowBalance,
        balance_proof: { siblings: balances.proof.siblings },
        checkpoint: {
            chain:              ORIGIN,
            network:            net,
            block_index:        height,
            checkpoint_seq:     77,
            snapshot_block:     height,
            state_root:         M.toHex(M.stateRoot(subRoots)),
            state_root_version: version,
        },
        _balances: balances,   // test-only handle, ignored by the verifier
    };
}

function buildRow(overrides){
    return Object.assign({
        transfer_id:     'a'.repeat(64),
        snapshot_block:  SNAPSHOT,
        network:         NETWORK,
        src_chain:       ORIGIN,
        src_action_index: 9001,
        src_address:     '1SomeLockerXXXXXXXXXXXXXXXXXXXXXXX',
        dest_chain:      DEST,
        dest_address:    'DSomeDogeDestinationXXXXXXXXXXXXXX',
        tick:            TICK,
        decimals:        8,
        amount:          '5.00000000',
        effective_time:  1750000000,
    }, overrides || {});
}

function buildCtx(proof, overrides){
    return Object.assign({
        actions: {}, indexerDb: {}, util: {}, config: {},
        coin: DEST, network: NETWORK, blockIndex: 500, blockTime: 1750000100,
        proof: proof,
    }, overrides || {});
}


// The escrow address is resolved from the ORIGIN chain's own coin config, never from the
// envelope. These tests stub that one door so they exercise the check itself rather than
// the arrival of the BRIDGE_<COIN> role; the door itself is asserted separately at
// the bottom of this file.
function installBridgeHooks(state){
    beforeEach(function(){
        const btc = require('../../../../src/coins/to_indexer_config.js');
        state.cfgStub = sinon.stub(btc, 'toIndexerConfig').callsFake(function(tick, network){
            const addr = ESCROW_ADDRS[network];
            return { ADDRESS: addr ? { BRIDGE_DOGE: addr } : {} };
        });
    });
    afterEach(function(){ state.cfgStub.restore(); });
}

module.exports = {
    assert, sinon, M, SUB, CHK, R, NETWORK, ORIGIN, DEST, TICK,
    ESCROW_ADDRS, ESCROW_ADDR, SNAPSHOT, CP_HEIGHT, V1_HEIGHT, V2_HEIGHT,
    V2_ESCROW_HEIGHT, TESTNET_HEIGHT, OTHER_ADDR, buildBalances, buildProof,
    buildRow, buildCtx, installBridgeHooks,
};

