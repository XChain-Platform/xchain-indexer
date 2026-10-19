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
 * XChain Indexer - Database mixin part: capability stake proofs
 *
 * Read-only proofs from the BTC capability-stakes subtree committed at an
 * exact block height.
 *
 ********************************************************************/

'use strict';

const M = require('../../consensus/merkle.js');
const stateCommitment = require('../../state_commitment/index.js');
const { subRootsOf } = require('../credits/bridge_reads.js');

const PUBKEY_RE = /^[0-9a-fA-F]{64}$/;
const MAX_PUBKEYS = 256;

function badParams(db, capability, blockIndex, pubkeys){
    let caps = db.config['STAKING'] && db.config['STAKING']['CAPABILITIES'];
    return typeof capability !== 'string' || !caps
        || !Object.prototype.hasOwnProperty.call(caps, capability)
        || !Number.isSafeInteger(blockIndex) || blockIndex < 0
        || !Array.isArray(pubkeys) || pubkeys.length > MAX_PUBKEYS
        || pubkeys.some(pubkey => typeof pubkey !== 'string' || !PUBKEY_RE.test(pubkey));
}

function memberLeaf(row){
    return M.toHex(M.stakeMemberLeaf(String(row.source), String(row.weight)));
}

function committedRow(rows, pubkey, leafValue){
    if(leafValue === null) return null;
    for(const row of rows){
        if(String(row.pubkey).toLowerCase() === pubkey && memberLeaf(row) === leafValue)
            return { source: String(row.source), weight: String(row.weight) };
    }
    return undefined;
}

function stakeTotal(rows){
    const sources = new Map();
    for(const row of rows){
        const source = String(row.source);
        if(!sources.has(source)) sources.set(source, String(row.weight));
    }
    return M.sumCanonicalAmounts(Array.from(sources.values()));
}

module.exports = {

    async getCapabilityStakeProof(capability, block_index, pubkeys){
        if(String(this.config['COIN']).toUpperCase() !== 'BTC')
            return { error: 'STAKES_BTC_ONLY' };

        if(block_index === null || block_index === undefined
                || badParams(this, capability, block_index, pubkeys))
            return { error: 'BAD_PARAMS' };
        let height = block_index;

        let rootRows = await this.doQueryStrict(
            `SELECT balances_root, stakes_root, contract_state_root
             FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1`,
            [this.config['COIN'], this.config['NETWORK'], height]);
        if(!rootRows.length) return { error: 'NO_STATE_TREE' };

        let rootRow = rootRows[0];
        let rows = await this.getStakeWeightsByCapability(capability, height);
        let smt = new stateCommitment.PersistentSMT(new stateCommitment.DbNodeStore(this));
        let members = [];

        for(const requested of pubkeys){
            let pubkey = requested.toLowerCase();
            let proof = await smt.prove(rootRow.stakes_root, M.stakeKey(pubkey, capability));
            let committed = committedRow(rows, pubkey, proof.leaf_value);
            if(committed === undefined) return null;
            members.push({
                pubkey,
                leaf_value: proof.leaf_value,
                siblings: proof.siblings,
                committed
            });
        }

        let total = stakeTotal(rows);
        let totalProof = null;
        let proof = await smt.prove(
            rootRow.stakes_root, M.stakeKey(M.STAKE_TOTAL_PUBKEY, capability));
        if(M.canonicalAmount(total) !== M.canonicalAmount('0')){
            if(proof.leaf_value !== M.toHex(M.stakeTotalLeaf(total))) return null;
            totalProof = { siblings: proof.siblings };
        } else {
            if(proof.leaf_value !== null) return null;
            total = null;
        }

        return {
            chain: this.config['COIN'],
            network: this.config['NETWORK'],
            block_index: height,
            sub_roots: subRootsOf(this, rootRow),
            members,
            total,
            total_proof: totalProof
        };
    },

};
