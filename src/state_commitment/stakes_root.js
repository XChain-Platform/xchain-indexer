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
 * XChain Indexer - State commitment part: stakes_root
 *
 * The BTC stakes sub-tree: its leaf set from the capability stake weights, and
 * the rebuild-only-on-change memo over the persistent SMT build. Part of the
 * block commitment that src/state_commitment/index.js orchestrates.
 *
 ********************************************************************/

'use strict';

const M = require('../consensus/merkle.js');
const { ZERO_CANON, canonicalAmountOf } = require('./leaf_values.js');

// Root of an empty depth-256 SMT: the same value src/state_commitment/index.js exports
// as EMPTY_ROOT_HEX, derived here from merkle.js rather than required back from
// the module that requires this one.
const EMPTY_ROOT_HEX = M.toHex(M.EMPTY_SMT_ROOT);

// ---- Stakes sub-tree (BTC-only, §4.1) ---------------------------------------
// Built fresh each BTC block from the authoritative capability stake-weight query
// (the set is small, bounded by VALIDATOR_QUERY_LIMIT). One leaf per (pubkey,
// capability) with the source-deduped weight; absent stakers are simply not in the
// set (delete-on-zero falls out). Keyed by canonical pubkey+capability strings.
async function gatherStakeEntries(db, blockIndex){
    const caps = (db.config['STAKING'] && db.config['STAKING']['CAPABILITIES'])
        ? Object.keys(db.config['STAKING']['CAPABILITIES']) : [];
    const entries = [];
    for(const capability of caps){
        const rows = await db.getStakeWeightsByCapability(capability, blockIndex);
        const seenSource = new Map();   // source -> weight (first wins; equal per source)
        for(const r of (rows || [])){
            if(!r || r.pubkey == null) continue;
            if(canonicalAmountOf(String(r.weight == null ? '0' : r.weight)) === ZERO_CANON) continue;   // zero cannot qualify
            const source = String(r.source);
            // Member leaf commits SOURCE + weight so a light client can source-dedupe
            // signer stake exactly as swq.meetsStakeThreshold does (validator-set proof).
            entries.push([ M.toHex(M.stakeKey(String(r.pubkey), capability)),
                           M.toHex(M.stakeMemberLeaf(source, String(r.weight))) ]);
            if(!seenSource.has(source)) seenSource.set(source, String(r.weight));
        }
        // Total leaf: the source-deduped quorum denominator S, so a client can check
        // 3·Σ(signer-source weight) > 2·S without enumerating the full set (spec §7).
        const total = M.sumCanonicalAmounts(Array.from(seenSource.values()));
        if(canonicalAmountOf(total) !== ZERO_CANON)
            entries.push([ M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, capability)),
                           M.toHex(M.stakeTotalLeaf(total)) ]);
    }
    return entries;
}

// Rebuild the stakes tree only when the stake set actually changed.
//
// buildFull writes SMT_DEPTH nodes per key, so this tree costs keys x 256 node
// writes on EVERY BTC block - 12,544 on the regtest venue's 49 keys - and the
// stake set changes on almost none of them. Every one of those writes is an
// INSERT IGNORE no-op, but each still probes a primary key far larger than the
// buffer pool, which is what put BTC regtest block parse at 25-66s against LTC's
// 3-5s for the same code (LTC commits the empty stakes root and never pays it).
//
// The memo is sound because buildFull is a PURE function of its entries: the node
// store is content-addressed, so the same entry set always yields the same root.
// test/unit/state_commitment/state_commitment.test.js pins both halves of that - equality with the merkle.js
// reference, and insert-order independence.
//
// Every way this can be wrong is a way it rebuilds. It shortcuts ONLY when the
// entries are identical to those of the block IMMEDIATELY BEFORE it, which this
// same process built and committed, and whose nodes are therefore already durable
// (state_tree_nodes is COW and rollback-exempt). Keyed on block CONTINUITY and not
// on the digest alone, so a reorg, a rollback, or a cold start lands on a block
// that is not the memo's successor and rebuilds. That direction matters: a cache
// in a consensus path may only ever fail toward the slow correct answer, and an
// earlier cache that failed the other way here did so because it was keyed on a
// MUTABLE dense id rather than on its own inputs.
let stakesMemo = null;

function stakeEntriesDigest(entries){
    // Sorted, because buildFull is order-independent: an entry set that merely
    // reordered must still hit. Length-prefixed and separator-joined so no pair
    // boundary can be forged by a value that happens to contain the separator.
    const pairs = entries.map(e => String(e[0]) + ':' + String(e[1])).sort();
    return M.toHex(M.sha256(Buffer.from(pairs.length + '|' + pairs.join('|'), 'utf8')));
}

// Exported for tests and for any caller that wipes the node store underneath a
// live process; forgetting the memo only ever costs one rebuild.
function resetStakesMemo(){ stakesMemo = null; }

async function buildStakesRoot(smt, chain, network, blockIndex, entries){
    const digest = stakeEntriesDigest(entries);
    const memo   = stakesMemo;
    if(memo && memo.chain === chain && memo.network === network
            && memo.blockIndex === blockIndex - 1 && memo.digest === digest){
        // One indexed read weighed against 12,544 writes: proves the memoized tree
        // is still IN the store before trusting it. It does not prove every interior
        // node survived - only a prune could remove one, and reachability marking
        // keeps whatever a retained root reaches - so this is a cheap floor, stated
        // as such rather than sold as verification.
        if(memo.root === EMPTY_ROOT_HEX || await smt.store.get(memo.root)){
            stakesMemo = { chain, network, blockIndex, digest, root: memo.root };
            return memo.root;
        }
    }
    const root = await smt.buildFull(entries);
    stakesMemo = { chain, network, blockIndex, digest, root };
    return root;
}

module.exports = {
    gatherStakeEntries,
    buildStakesRoot,
    resetStakesMemo
};
