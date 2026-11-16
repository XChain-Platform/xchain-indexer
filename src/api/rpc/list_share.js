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
const { getSharedListDetails } = require('../../db/lists/sharing.js');
const { getLogger } = require('../../observability/index.js');
const { qualifyTickMembers } = require('./list_share/list_share_tick_members.js');
const rpcParams = require('./params.js');

function listMetaAnswer(meta){
    const name = meta?.name ?? null;
    const description = meta?.description ?? null;
    return { name, description, meta_hash: listMetaHash(name, description) };
}

async function getListAtRpc(indexer, params){
    if(!indexer.indexerDb)
        return { error: 'indexer database not ready' };
    let listIndex = rpcParams.integer(params.list_index, { name: 'list_index', min: 1 });
    if(listIndex.error) return { error: listIndex.error };
    let block = rpcParams.integer(params.block, { name: 'block', min: 0 });
    if(block.error) return { error: block.error };

    try {
        let db = indexer.indexerDb.apiView();
        let rootIndex = await db.getListRootIndex(listIndex.value, null, block.value);
        let type = await db.getListType(rootIndex, block.value);
        if(type === false)
            return { error: 'list not found' };
        let members = await db.getListAtBlock(rootIndex, block.value);
        if(members === null)
            return { error: 'list reference rejected' };
        if(type === 1)
            members = await qualifyTickMembers(db, members,
                indexer.config['COIN'], indexer.config['COINS']);
        let meta = listMetaAnswer(await db.getListMeta(rootIndex, block.value));
        return { type, members, hash: listMembershipHash(members), ...meta };
    } catch (err) {
        getLogger().error('getlistat error:', err);
        return { error: 'failed to look up list' };
    }
}

async function getSharedListsRpc(indexer, params){
    if(!indexer.indexerDb)
        return { error: 'indexer database not ready' };
    if(params.network !== indexer.config['NETWORK'])
        return { error: 'network does not match this indexer' };

    try {
        let db = indexer.indexerDb.apiView();
        let rows = await getSharedListDetails(db);
        return rows.map(row => ({
            root_index:         row.root_index,
            name:               row.name ?? null,
            owner:              row.owner ?? null,
            share_block:        row.share_block,
            share_action_index: row.share_action_index
        }));
    } catch (err) {
        getLogger().error('getsharedlists error:', err);
        return { error: 'failed to look up shared lists' };
    }
}

function buildListShareRpc({ indexer }){
    return {
        getlistat: async (params = {}) => getListAtRpc(indexer, params),
        getsharedlists: async (params = {}) => getSharedListsRpc(indexer, params),
    };
}

module.exports = { buildListShareRpc, listMetaAnswer };
