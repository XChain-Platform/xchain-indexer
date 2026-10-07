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

const { isListShared } = require('../../../db/lists/sharing.js');
const { getLogger } = require('../../../observability/index.js');
const { parseSharedListParams, sharedListRecord } = require('../shared_list/params.js');

function buildListShareMirrorRpc({ indexer }){
    return {
        async getsharedlist(params = {}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };

            const parsed = parseSharedListParams(params);
            if(parsed.error)
                return parsed;

            const homeChain = parsed.home_chain;
            const root = parsed.list_index;

            try {
                const db = indexer.indexerDb.apiView();
                if(homeChain === indexer.config['COIN']){
                    if(!await isListShared(db, root))
                        return { error: 'list is not shared' };
                    const latest = await db.getLatestBlockIndex();
                    const members = await db.getList(root, latest);
                    return sharedListRecord({
                        home_chain: homeChain,
                        home_list_index: root,
                        local_list_index: root,
                        seq: null,
                        origin_block: null,
                        members
                    });
                }

                const mirror = await db.getListShareMirror(homeChain, root);
                if(!mirror)
                    return { error: 'no mirror of ' + homeChain + ' list ' + root + ' on this chain' };

                const seq = await db.countAppliedListShareVersions(homeChain, root);
                const snapshot = await db.mirrorDb().getListSnapshotAtSeq(
                    indexer.config['NETWORK'], homeChain, root, seq);
                const latest = await db.getLatestBlockIndex();
                const localIndex = Number(mirror.action_index);
                const members = await db.getList(localIndex, latest);

                return sharedListRecord({
                    home_chain: homeChain,
                    home_list_index: root,
                    local_list_index: localIndex,
                    seq,
                    origin_block: snapshot ? Number(snapshot.origin_block) : null,
                    members
                });
            } catch (err) {
                getLogger().error('getsharedlist error:', err);
                return { error: 'failed to look up shared list' };
            }
        },
    };
}

module.exports = { buildListShareMirrorRpc };
