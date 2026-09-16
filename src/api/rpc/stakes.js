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
 * XChain Indexer - JSON-RPC stake family: one key's stake, the whole-federation sets and the stake source.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const { getStakeSourceByPubkey } = require('../stake_source');
const { getLogger } = require('../../observability/index.js');

function buildStakesRpc(ctx){
    return Object.assign({}, ownStakeRpc(ctx), activeValidatorsRpc(ctx), activeStakeWeightsRpc(ctx));
}

function ownStakeRpc({ indexer }){
    return {
        // Look up the active stake amount + latest block index for a single pubkey.
        // Used by xchain-hub's CapabilityRegistry to keep its own qualification
        // state in sync with on-chain stake without needing direct DB access.
        // Body: { pubkey }
        async getownstake({pubkey}){
            if(!pubkey || !/^[0-9a-fA-F]{64}$/.test(String(pubkey)))
                return { error: 'pubkey must be a 64-char hex string' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Federation READ isolation: route every read
            // through apiView() so it draws an independent pooled connection and
            // sees only COMMITTED state. A federation read landing mid-block must
            // never join the block's open ACID transaction: sharing that physical
            // connection with the block loop is a per-block atomicity hazard, and
            // reading the block's uncommitted rows can hand a hub a validator set
            // the block may still roll back on a reorg/throw.
            let db = indexer.indexerDb.apiView();
            let pk = String(pubkey).toLowerCase();
            try {
                let blockIndex = await db.getLatestBlockIndex();
                // Effective-set view (direct stake minus revocations, plus delegated-key
                // resolution) so a delegation-only hub self-qualifies in step with the
                // federation. This is the federation-read-only consumer; consensus handlers
                // use getActiveStakeByPubkey (direct stake ownership) instead.
                let stake = await db.getEffectiveStakeByPubkey(pk, blockIndex);
                return {
                    pubkey:      pk,
                    block_index: blockIndex,
                    amount:      stake ? stake.amount : '0',
                    has_stake:   !!stake
                };
            } catch (err) {
                getLogger().error('getownstake error:', err);
                return { error: 'failed to look up stake' };
            }
        },

        // Resolve the staking source address that owned/delegated a signing
        // pubkey as of a block; stakes first, then DELEGATE v0 delegations
        // (same order as createValidatorReward). Block-scoped so every caller
        // gets the same answer at any time: the hub archive builder pins this
        // earn-time source into the ANCHOR archive, and follower hubs
        // re-resolve it before co-signing.
        // Body: { pubkey, block_index }. Logic lives in ./stake-source so it can
        // be unit-tested without standing up the Express/JSON-RPC stack.
        async getstakesourcebypubkey({pubkey, block_index}){
            return getStakeSourceByPubkey(indexer, { pubkey, block_index });
        },
    };
}

// Whole-federation validator-set snapshot at a block boundary:
// every pubkey with ANY active stake at the block, regardless of
// capability. Used by xchain-hub's Consensus (config-change PBFT)
// where quorum is over all stakers, not a capability subset.
// Body: { block_index }
function activeValidatorsRpc({ indexer }){
    return {
        async getactivevalidators({block_index}){
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latestBlock = await db.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await db.getActiveValidators(blk);
                return {
                    block_index: blk,
                    count:       validators.length,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:   validators.truncated === true,
                    validators:  validators
                };
            } catch (err) {
                getLogger().error('getactivevalidators error:', err);
                return { error: 'failed to look up active validators' };
            }
        },
    };
}

// Source-keyed whole-federation weights at a block boundary; every staker
// (no capability filter, no MIN_STAKE floor) with each effective key's
// `source` + the source's aggregate `weight`. The STAKE_WEIGHTED_QUORUM
// counterpart of getactivevalidators; used by xchain-hub's Consensus
// (config-change PBFT) to weight governance quorum by stake.
// Body: { block_index }
function activeStakeWeightsRpc({ indexer }){
    return {
        async getactivestakeweights({block_index}){
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latestBlock = await db.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await db.getActiveStakeWeights(blk);
                let sources = new Set(validators.map(v => v.source));
                return {
                    block_index:  blk,
                    count:        validators.length,
                    source_count: sources.size,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:    validators.truncated === true,
                    validators:   validators
                };
            } catch (err) {
                getLogger().error('getactivestakeweights error:', err);
                return { error: 'failed to look up active stake weights' };
            }
        },
    };
}

module.exports = { buildStakesRpc };
