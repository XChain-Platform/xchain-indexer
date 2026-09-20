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
 * XChain Indexer - JSON-RPC token policy family: a bridged token's origin policy and its applied copy.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const crypto = require('crypto');
const { getLogger } = require('../../observability/index.js');

// The XPOLICY canonical membership hash for a bridged token's allow and block
// lists: sha256 over ALLOW|<n or ->|<addr>|...|BLOCK|<m or ->|<addr>|...|SLEEP|<0 or 1>.
// `-` means the origin row carries no such list AT ALL, distinct from `0`, an existing but
// empty one. Addresses arrive from db.getListAtBlock already in utf8_bin ascending
// order; this function never re-sorts them, so a caller that changed that ordering
// would move the hash here, not silently mask it.
function bridgePolicyHash(allowList, blockList, sleeping){
    function section(tag, list){
        let parts = [tag, (list === null) ? '-' : String(list.length)];
        if(list !== null)
            for(let addr of list) parts.push(addr);
        return parts.join('|');
    }
    let canonical = section('ALLOW', allowList) + '|' + section('BLOCK', blockList) +
                    '|SLEEP|' + (sleeping ? '1' : '0');
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

function buildTokenPolicyRpc(ctx){
    return Object.assign({}, tokenPolicyRpc(ctx), appliedPolicyRpc(ctx));
}

// The origin-chain policy read: the
// token's policy AS OF origin_block. Open read (in no gating set). A tick with no
// native row on this chain (this is not its origin) answers { error } rather than
// throwing.
// Body: { tick, origin_block }
function tokenPolicyRpc({ indexer }){
    return {
        async gettokenpolicy({tick, origin_block}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!tick)
                return { error: 'tick required' };
            let block = Number(origin_block);
            if(!Number.isFinite(block) || !Number.isInteger(block) || block < 0)
                return { error: 'origin_block must be a non-negative integer' };
            let t  = String(tick);
            let db = indexer.indexerDb.apiView();
            try {
                let info = await db.getTokenInfo(t, block);
                if(!info)
                    return { error: 'tick has no native row on this chain' };
                let [allowList, blockList, sleeping] = await Promise.all([
                    (info.ALLOW_LIST != null) ? db.getListAtBlock(info.ALLOW_LIST, block) : Promise.resolve(null),
                    (info.BLOCK_LIST != null) ? db.getListAtBlock(info.BLOCK_LIST, block) : Promise.resolve(null),
                    db.isTickSleepingAtBlock(t, block)
                ]);
                return {
                    allow_list:   allowList,
                    block_list:   blockList,
                    sleeping:     !!sleeping,
                    policy_hash:  bridgePolicyHash(allowList, blockList, !!sleeping),
                    bridged:      Number(info.BRIDGED) === 1,
                    origin_block: block
                };
            } catch (err) {
                getLogger().error('gettokenpolicy error:', err);
                return { error: 'failed to look up token policy' };
            }
        },
    };
}

// The destination-chain applied-policy read:
// the current local materialized state for a bridged row, plus the applied
// snapshot's identity when one has landed here. Open read. A tick with no local row
// on this chain answers { error } rather than throwing.
// Body: { tick }
function appliedPolicyRpc({ indexer }){
    return {
        async getappliedpolicy({tick}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!tick)
                return { error: 'tick required' };
            let t  = String(tick);
            let db = indexer.indexerDb.apiView();
            try {
                let info = await db.getTokenInfo(t, null);
                if(!info)
                    return { error: 'tick has no local row on this chain' };
                let copy    = indexer.util.parseBridgedTick(t);
                let latest  = await db.getLatestBlockIndex();
                let [sleeping, applied] = await Promise.all([
                    db.isTickSleeping(t, latest),
                    copy ? db.getAppliedPolicySnapshot(copy.origin, copy.name) : Promise.resolve(null)
                ]);
                return {
                    tick:         t,
                    bridged:      Number(info.BRIDGED) === 1,
                    allow_list:   (info.ALLOW_LIST != null) ? Number(info.ALLOW_LIST) : null,
                    block_list:   (info.BLOCK_LIST != null) ? Number(info.BLOCK_LIST) : null,
                    sleeping:     !!sleeping,
                    policy_seq:   applied ? Number(applied.policy_seq)   : null,
                    origin_block: applied ? Number(applied.origin_block) : null,
                    policy_hash:  applied ? applied.policy_hash          : null
                };
            } catch (err) {
                getLogger().error('getappliedpolicy error:', err);
                return { error: 'failed to look up applied policy' };
            }
        },
    };
}

module.exports = { buildTokenPolicyRpc, bridgePolicyHash };
