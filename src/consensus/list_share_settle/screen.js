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

'use strict';

const { LIST_SHARE_HALT_REASON } = require('./halt.js');
const { deriveListSnapshotId } = require('./canonical.js');
const { listMetaHash } = require('../list_share_hash.js');
const { parseMembership, verifyMembershipOrder } = require('../bridge_settle/policy_membership.js');
const { metaFieldVerdict } = require('../../actions/list/meta_rules.js');

const HOME_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);

function halt(detail){
    return { halt: LIST_SHARE_HALT_REASON.SCREEN, detail };
}

function integer(value){
    if(typeof value === 'bigint')
        return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    if(typeof value === 'number')
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if(typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
        return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function isSet(value){
    return value !== null && value !== undefined && value !== '';
}

function admissionColumns(row){
    const map = {};
    for(const coin of HOME_CHAINS){
        const value = row['admit_block_' + coin.toLowerCase()];
        if(value === null || value === undefined) continue;
        const height = Number(value);
        if(!Number.isSafeInteger(height) || height < 0)
            throw new Error('invalid admission height');
        map[coin] = height;
    }
    return Object.keys(map).length ? map : null;
}

function screenListMeta(row, metaActive){
    row = row && typeof row === 'object' ? row : {};
    const name = row.name ?? null;
    const description = row.description ?? null;
    const metaHash = row.meta_hash ?? null;

    if(!metaActive){
        if(name !== null || description !== null || metaHash !== null)
            return { halt: LIST_SHARE_HALT_REASON.META_HASH, detail: 'meta_below_gate' };
        return { fields: { name: null, description: null, meta_hash: null } };
    }

    if(name !== null && (name === '' || metaFieldVerdict('name', name, 64, true)))
        return { halt: LIST_SHARE_HALT_REASON.META_HASH, detail: 'name' };
    if(description !== null &&
       (description === '' || metaFieldVerdict('description', description, 512, true)))
        return { halt: LIST_SHARE_HALT_REASON.META_HASH, detail: 'description' };
    if(typeof metaHash !== 'string' || metaHash !== listMetaHash(name, description))
        return { halt: LIST_SHARE_HALT_REASON.META_HASH, detail: 'meta_hash' };

    return { fields: { name, description, meta_hash: metaHash } };
}

function screenListMetaWithDeps(deps, row, snapshotBlock, network, fields){
    if(typeof deps.isListMetaActive !== 'function')
        return { fields };
    const screened = screenListMeta(row, deps.isListMetaActive(snapshotBlock, network) === true);
    if(screened.halt) return screened;
    return { fields: Object.assign(fields, screened.fields) };
}

function screenListSnapshotWithDeps(deps, row, ctx){
    row = row && typeof row === 'object' ? row : {};
    ctx = ctx && typeof ctx === 'object' ? ctx : {};

    const snapshotBlock = integer(row.snapshot_block);
    if(snapshotBlock === null) return halt('snapshot_block');
    const homeListIndex = integer(row.home_list_index);
    if(homeListIndex === null) return halt('home_list_index');
    const seq = integer(row.seq);
    if(seq === null) return halt('seq');
    const originBlock = integer(row.origin_block);
    if(originBlock === null) return halt('origin_block');

    const homeChain = String(row.home_chain || '');
    if(!HOME_CHAINS.has(homeChain) || homeChain === String(ctx.coin || ''))
        return halt('home_chain');

    const network = String(row.network || '');
    if(network !== String(ctx.network || ''))
        return halt('network');

    const snapshotId = String(row.snapshot_id || '');
    if(snapshotId !== deriveListSnapshotId(network, homeChain, homeListIndex, seq, snapshotBlock))
        return halt('snapshot_id');

    const localChainId = ctx.config ? ctx.config['BTC_CHAIN_ID'] : null;
    if(isSet(row.btc_chain_id) && isSet(localChainId) &&
       String(row.btc_chain_id) !== String(localChainId))
        return halt('btc_chain_id');

    if(String(row.status || '') !== 'finalized')
        return halt('status');

    const listType = integer(row.list_type);
    if(listType !== 1 && listType !== 2)
        return halt('list_type');

    const kind = String(row.kind || '');
    if(kind !== (seq === 1 ? 'full' : 'delta'))
        return halt('kind');

    const added = parseMembership(row.added);
    if(added === false) return halt('added');
    const removed = parseMembership(row.removed);
    if(removed === false) return halt('removed');
    if(!verifyMembershipOrder(added)) return halt('added_order');
    if(!verifyMembershipOrder(removed)) return halt('removed_order');
    if(seq === 1 && removed !== null && removed.length !== 0)
        return halt('removed_seq_1');

    let admitBlocks;
    try {
        admitBlocks = deps.ah.columnsAdmitBlocks(row);
    } catch(error) {
        return halt('admit_block_' + String(ctx.coin || '').toLowerCase());
    }
    if(!admitBlocks || !Object.prototype.hasOwnProperty.call(admitBlocks, ctx.coin))
        return halt('admit_block_' + String(ctx.coin || '').toLowerCase());

    return screenListMetaWithDeps(deps, row, snapshotBlock, network, {
        snapshot_id: snapshotId,
        snapshot_block: snapshotBlock,
        home_chain: homeChain,
        home_list_index: homeListIndex,
        list_type: listType,
        seq,
        kind,
        origin_block: originBlock,
        added,
        removed,
    });
}

function screenListSnapshot(row, ctx){
    return screenListSnapshotWithDeps({ ah: { columnsAdmitBlocks: admissionColumns } }, row, ctx);
}

function createScreen({ ah, isListMetaActive }){
    const deps = { ah, isListMetaActive };
    return {
        screenListSnapshot: screenListSnapshotWithDeps.bind(null, deps),
        wireListMetaGate(reader){
            if(typeof deps.isListMetaActive !== 'function')
                deps.isListMetaActive = reader;
        },
    };
}

module.exports = { createScreen, screenListSnapshot, screenListMeta };
