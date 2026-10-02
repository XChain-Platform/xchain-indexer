/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const { listMembershipHash, listMetaHash } = require('../../consensus/list_share_hash.js');
const { getSharedLists, getListOwner } = require('../../db/lists/sharing.js');
const { getLogger } = require('../../observability/index.js');
const { qualifyTickMembers } = require('./list_share_tick_members.js');

const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

function integerParam(value, positive){
    if(typeof value === 'string'){
        if(!CANONICAL_NON_NEGATIVE_INTEGER.test(value)) return null;
        value = Number(value);
    }
    if(!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) return null;
    return value;
}

function listMetaAnswer(meta){
    const name = meta?.name ?? null;
    const description = meta?.description ?? null;
    return { name, description, meta_hash: listMetaHash(name, description) };
}

function buildListShareRpc({ indexer }){
    return {
        async getlistat(params = {}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(params === null || typeof params !== 'object')
                return { error: 'list_index must be a positive integer' };
            let listIndex = integerParam(params.list_index, true);
            if(listIndex === null)
                return { error: 'list_index must be a positive integer' };
            let block = integerParam(params.block, false);
            if(block === null)
                return { error: 'block must be a non-negative integer' };

            try {
                let db = indexer.indexerDb.apiView();
                let type = await db.getListType(listIndex, block);
                if(type === false)
                    return { error: 'list not found' };
                let members = await db.getListAtBlock(listIndex, block);
                if(members === null)
                    return { error: 'list reference rejected' };
                if(type === 1)
                    members = await qualifyTickMembers(db, members,
                        indexer.config['COIN'], indexer.config['COINS']);
                return { type, members, hash: listMembershipHash(members) };
            } catch (err) {
                getLogger().error('getlistat error:', err);
                return { error: 'failed to look up list' };
            }
        },

        async getsharedlists(params = {}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(params === null || typeof params !== 'object' ||
               params.network !== indexer.config['NETWORK'])
                return { error: 'network does not match this indexer' };

            try {
                let db = indexer.indexerDb.apiView();
                let rows = await getSharedLists(db);
                return await Promise.all(rows.map(async row => ({
                    root_index:        row.root_index,
                    owner:             await getListOwner(db, row.root_index),
                    share_block:       row.share_block,
                    share_action_index: row.share_action_index
                })));
            } catch (err) {
                getLogger().error('getsharedlists error:', err);
                return { error: 'failed to look up shared lists' };
            }
        },
    };
}

module.exports = { buildListShareRpc, listMetaAnswer };
