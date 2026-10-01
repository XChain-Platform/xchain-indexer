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
 ********************************************************************/

'use strict';

const { LIST_SHARE_HALT_REASON } = require('./halt.js');
const { deriveListSnapshotId } = require('./canonical.js');
const { parseMembership, verifyMembershipOrder } = require('../bridge_settle/policy_membership.js');

const HOME_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);

function screenHalt(detail) {
    return { halt: LIST_SHARE_HALT_REASON.SCREEN, detail };
}

function integer(value) {
    if (typeof value === 'bigint')
        return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    if (typeof value === 'number')
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
        return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function present(value) {
    return value !== null && value !== undefined && value !== '';
}

function screenIdentity(row, ctx) {
    const snapshotBlock = integer(row && row.snapshot_block);
    if (snapshotBlock === null) return screenHalt('snapshot_block');
    const homeListIndex = integer(row.home_list_index);
    if (homeListIndex === null) return screenHalt('home_list_index');
    const seq = integer(row.seq);
    if (seq === null) return screenHalt('seq');
    const originBlock = integer(row.origin_block);
    if (originBlock === null) return screenHalt('origin_block');

    const homeChain = String(row.home_chain || '');
    if (!HOME_CHAINS.has(homeChain) || homeChain === String(ctx && ctx.coin || ''))
        return screenHalt('home_chain');
    const network = String(row.network || '');
    if (network !== String(ctx && ctx.network || '')) return screenHalt('network');
    const id = deriveListSnapshotId(network, homeChain, homeListIndex, seq, snapshotBlock);
    if (String(row.snapshot_id || '') !== id) return screenHalt('snapshot_id');

    return { snapshotBlock, homeListIndex, seq, originBlock, homeChain, id };
}

function screenContent(row, ctx, identity) {
    const localChainId = ctx && ctx.config ? ctx.config['BTC_CHAIN_ID'] : null;
    if (present(row.btc_chain_id) && present(localChainId) &&
        String(row.btc_chain_id) !== String(localChainId))
        return screenHalt('btc_chain_id');
    if (String(row.status || '') !== 'finalized') return screenHalt('status');

    const listType = integer(row.list_type);
    if (listType !== 1 && listType !== 2) return screenHalt('list_type');
    const expectedKind = identity.seq === 1 ? 'full' : 'delta';
    if (String(row.kind || '') !== expectedKind) return screenHalt('kind');

    const added = parseMembership(row.added);
    if (added === false || !verifyMembershipOrder(added)) return screenHalt('added');
    const removed = parseMembership(row.removed);
    if (removed === false || !verifyMembershipOrder(removed)) return screenHalt('removed');
    if (identity.seq === 1 && removed !== null && removed.length !== 0)
        return screenHalt('removed for full snapshot');

    return { listType, added, removed };
}

function screenListSnapshotWithDeps(deps, row, ctx) {
    const identity = screenIdentity(row, ctx);
    if (identity.halt) return identity;
    const content = screenContent(row, ctx, identity);
    if (content.halt) return content;

    let admitBlocks;
    try { admitBlocks = deps.ah.columnsAdmitBlocks(row); }
    catch (_) { return screenHalt('admission map'); }
    if (!admitBlocks || !Object.prototype.hasOwnProperty.call(admitBlocks, String(ctx.coin)))
        return screenHalt('admission map');

    return { fields: {
        snapshot_id: identity.id,
        snapshot_block: identity.snapshotBlock,
        home_chain: identity.homeChain,
        home_list_index: identity.homeListIndex,
        list_type: content.listType,
        seq: identity.seq,
        kind: identity.seq === 1 ? 'full' : 'delta',
        origin_block: identity.originBlock,
        added: content.added,
        removed: content.removed,
    } };
}

function createScreen(deps) {
    function screenListSnapshot(row, ctx) {
        return screenListSnapshotWithDeps(deps, row, ctx);
    }

    return { screenListSnapshot };
}

module.exports = { createScreen };
