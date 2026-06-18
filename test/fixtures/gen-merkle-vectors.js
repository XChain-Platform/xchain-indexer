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
 * Generator for test/fixtures/merkle-vectors.json: the frozen golden lock for
 * src/merkle.js (SPV light-client primitives, spec §3-§5). Sibling of
 * gen-block-hash-vectors.js / gen-state-hash-vectors.js.
 *
 * It embeds canonical INPUTS and computes the expected OUTPUTS with the REAL
 * src/merkle.js, so the committed JSON authentically locks the scheme. The unit
 * test (test/unit/merkle.test.js) reloads the JSON, recomputes from the same
 * inputs, and asserts byte-equality. xchain-sync/src/merkle.js is the byte-
 * identical twin; its own copy of this golden + the e2e recompute scenario are
 * the cross-repo drift guard.
 *
 * Run manually and commit the output:
 *   node test/fixtures/gen-merkle-vectors.js
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const M    = require('../../src/merkle.js');

// ---- canonical INPUTS (frozen) ----------------------------------------------
const CHAIN = 'BTC', NETWORK = 'regtest';

const BAL_ENTRIES = [
    { address: '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', tick: 'XCHAIN', amount: '1000.5' },
    { address: '1FuckButtZ6tQcSxwfxhv6XKKjcyiabcde', tick: 'JDOG',   amount: '0.000000000000000001' },
    { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', tick: 'XCHAIN', amount: '42' },
    { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', tick: 'PEPE',   amount: '7777777.123456789012345678' }
];
// membership target (present), non-membership target (absent), delete target.
const MEMBER_TARGET  = BAL_ENTRIES[0];
const ABSENT_TARGET  = { address: '1NOTPRESENTxxxxxxxxxxxxxxxxxxxxxxxx', tick: 'GHOST' };
const DELETE_TARGET  = BAL_ENTRIES[2];   // 42 -> 0, must DELETE the leaf

const STAKE_ENTRIES = [
    { pubkey: '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f901', capability: 'oracle_publish', amount: '5000' },
    { pubkey: '03f1e2d3c4b5a6978869504132231415e6d7c8b9a0f1e2d3c4b5a697886950413', capability: 'cross_chain',    amount: '3000' }
];

const CANON_AMOUNTS = [
    { in: '0',                            out: '0.000000000000000000' },
    { in: '1000.5',                       out: '1000.500000000000000000' },
    { in: '00042',                        out: '42.000000000000000000' },
    { in: '0.000000000000000001',         out: '0.000000000000000001' },
    { in: '7777777.123456789012345678',   out: '7777777.123456789012345678' }
];

// block-content rows (already in the §5.1 deterministic order within each kind)
const LEDGER_ROWS = [
    { kind: 'credit', action_index: 10, address: '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', tick: 'XCHAIN', amount: '1000.5' },
    { kind: 'debit',  action_index: 10, address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', tick: 'XCHAIN', amount: '42'     },
    { kind: 'escrow', action_index: 11, address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', tick: 'PEPE',   amount: '5'      },
    // Negative escrow row: the release idiom (order_expire/swap_expire/attest settle).
    // Locks the leaf encoding for signed amounts (raw stored string, not canonicalAmount).
    { kind: 'escrow', action_index: 12, address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', tick: 'PEPE',   amount: '-5'     }
];
const ACTIONS_ROWS = [
    { action_index: 10, tx_index: 0,    action: 'SEND'  },
    { action_index: 11, tx_index: null, action: 'ORDER' }   // tx_index NULL -> '' encoding
];

function balLeaf(e){ return M.amountLeaf(e.amount); }
function balKey(e){ return M.balanceKey(CHAIN, NETWORK, e.address, e.tick); }

function buildBalanceTree(entries){
    const t = new M.SparseMerkleTree();
    for(const e of entries) t.set(balKey(e), balLeaf(e));
    return t;
}
function buildStakeTree(entries){
    const t = new M.SparseMerkleTree();
    for(const e of entries) t.set(M.stakeKey(e.pubkey, e.capability), M.amountLeaf(e.amount));
    return t;
}

function main(){
    // SMT roots
    const balTree = buildBalanceTree(BAL_ENTRIES);
    const stakeTree = buildStakeTree(STAKE_ENTRIES);
    const balances_root = balTree.rootHex();
    const stakes_root   = stakeTree.rootHex();

    // membership + non-membership proofs (store compressed form, the wire form)
    const memberProof = balTree.prove(balKey(MEMBER_TARGET));
    const absentProof = balTree.prove(M.balanceKey(CHAIN, NETWORK, ABSENT_TARGET.address, ABSENT_TARGET.tick));

    // delete-on-zero: remove the 42 leaf, capture the new root
    const balTree2 = buildBalanceTree(BAL_ENTRIES);
    balTree2.delete(balKey(DELETE_TARGET));
    const balances_root_after_delete = balTree2.rootHex();

    // re-insert after delete returns to the original root (idempotence of identity)
    const balTree3 = buildBalanceTree(BAL_ENTRIES.filter(e => e !== DELETE_TARGET));
    balTree3.set(balKey(DELETE_TARGET), balLeaf(DELETE_TARGET));
    const balances_root_reinserted = balTree3.rootHex();

    // top-level state root (balances + stakes; others EMPTY)
    const state_root = M.toHex(M.stateRoot({ balances_root, stakes_root }));
    const subPath = M.stateRootProof({ balances_root, stakes_root }, 'balances_root');

    // block-content root over the frozen cross-kind order: ledger..., actions...
    const orderedLeaves = [
        ...LEDGER_ROWS.map(M.ledgerLeaf),
        ...ACTIONS_ROWS.map(M.actionsLeaf)
    ];
    const block_merkle_root = M.toHex(M.blockMerkleRoot(orderedLeaves));
    const blkIncludeIndex = 1;   // second ledger row (the debit)
    const blkProof = M.fixedMerkleProof(orderedLeaves, blkIncludeIndex);

    const out = {
        merkle_version:       M.MERKLE_VERSION,
        state_root_version:   M.STATE_ROOT_VERSION,
        block_merkle_version: M.BLOCK_MERKLE_VERSION,
        smt_depth:            M.SMT_DEPTH,
        chain: CHAIN, network: NETWORK,

        constants: {
            empty_0:        M.toHex(M.EMPTY[0]),
            empty_1:        M.toHex(M.EMPTY[1]),
            empty_255:      M.toHex(M.EMPTY[255]),
            empty_smt_root: M.toHex(M.EMPTY_SMT_ROOT)
        },
        primitives: {
            leaf_hello: M.toHex(M.leafHash('hello')),
            node_empty_pair: M.toHex(M.nodeHash(M.EMPTY[0], M.EMPTY[0]))   // == empty_1
        },
        canonical_amount: CANON_AMOUNTS,

        keys: {
            member_balance_key: M.toHex(balKey(MEMBER_TARGET)),
            stake_key_example:  M.toHex(M.stakeKey(STAKE_ENTRIES[0].pubkey, STAKE_ENTRIES[0].capability))
        },

        smt: {
            bal_entries: BAL_ENTRIES,
            stake_entries: STAKE_ENTRIES,
            balances_root,
            stakes_root,
            membership: {
                target: MEMBER_TARGET,
                leaf_value: memberProof.leaf_value,
                compressed: memberProof.compressed
            },
            nonmembership: {
                target: ABSENT_TARGET,
                compressed: absentProof.compressed
            },
            delete_target: DELETE_TARGET,
            balances_root_after_delete,
            balances_root_reinserted
        },

        state_root: {
            balances_root, stakes_root, root: state_root,
            sub_root_path_balances: subPath
        },

        block_merkle: {
            ledger_rows: LEDGER_ROWS,
            actions_rows: ACTIONS_ROWS,
            root: block_merkle_root,
            include_index: blkIncludeIndex,
            include_proof: blkProof
        }
    };

    const dest = path.join(__dirname, 'merkle-vectors.json');
    fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
    console.log('wrote ' + dest);
    console.log('balances_root:     ' + balances_root);
    console.log('stakes_root:       ' + stakes_root);
    console.log('state_root:        ' + state_root);
    console.log('block_merkle_root: ' + block_merkle_root);
}

main();
