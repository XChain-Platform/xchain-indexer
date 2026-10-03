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
 *********************************************************************
 *
 * XChain Platform - apply one shared-list snapshot.
 *
 ********************************************************************/

'use strict';

const { nextMembership } = require('./delta.js');
const { planListShareLegs } = require('./legs.js');
const { injectListShareLegs } = require('./inject.js');
const { listShareTarget } = require('./target.js');
const { verifyMirrorMembers } = require('./reread.js');
const { recordListShareApplied } = require('./record.js');
const gateRegistry = require('../gate_registry.js');
const {
    ListShareHaltError,
    LIST_SHARE_HALT_REASON,
    LIST_META_GATE_KEY,
} = require('./halt.js');

function isListMetaActive(snapshotBlock, network){
    return gateRegistry.activeAt(
        LIST_META_GATE_KEY,
        network,
        'BTC',
        snapshotBlock,
        null
    );
}

function isListMetaApplyActive(coin, network, blockIndex){
    return gateRegistry.activeAt(
        LIST_META_GATE_KEY,
        network,
        coin,
        blockIndex,
        null
    );
}

function wireListMetaConsumer(deps){
    if(typeof deps.isListMetaApplyActive === 'function') return;
    if(!deps.canonical || typeof deps.canonical.wireListMetaGate !== 'function') return;
    if(!deps.screen || typeof deps.screen.wireListMetaGate !== 'function') return;
    deps.canonical.wireListMetaGate(isListMetaActive);
    deps.screen.wireListMetaGate(isListMetaActive);
    deps.isListMetaApplyActive = isListMetaApplyActive;
}

function halt(reason, row, detail){
    throw new ListShareHaltError(reason, row.snapshot_id, detail);
}

function screenedFields(deps, row, ctx){
    const screened = deps.screen.screenListSnapshot(row, ctx);
    if(screened.halt) halt(screened.halt, row, screened.detail);
    return Object.assign({}, screened.fields, { members_hash: row.members_hash });
}

async function verifySnapshotQuorum(deps, row, ctx, fields){
    const result = await deps.quorum.verifyQuorum(
        deps.canonical.listShareCanonical(row),
        row.validator_signatures,
        fields.snapshot_block,
        ctx.network,
        ctx.indexerDb
    );
    if(result.snapshotAbsent) halt(LIST_SHARE_HALT_REASON.SNAPSHOT_ABSENT, row);
    if(!result.met) halt(LIST_SHARE_HALT_REASON.QUORUM, row);
}

function plannedMembership(row, current, fields){
    const next = nextMembership(current, fields);
    if(next.halt) halt(next.halt, row);
    return next.membership;
}

async function plannedLegs(deps, fields, mirrorIndex, ctx){
    const options = {
        seq: fields.seq,
        listType: fields.list_type,
        added: fields.added,
        removed: fields.removed,
        mirrorIndex,
    };
    if(typeof deps.isListMetaApplyActive !== 'function' ||
       deps.isListMetaApplyActive(ctx.coin, ctx.network, ctx.blockIndex) !== true)
        return planListShareLegs(options);

    const meta = typeof fields.meta_hash === 'string'
        ? { name: fields.name, description: fields.description }
        : null;
    const currentMeta = mirrorIndex === null
        ? null
        : await ctx.indexerDb.getListMeta(mirrorIndex, ctx.blockIndex);
    return planListShareLegs(Object.assign(options, {
        metaActive: true,
        meta,
        currentMeta,
    }));
}

async function applyListShareSnapshot(deps, row, ctx){
    const fields = screenedFields(deps, row, ctx);
    await verifySnapshotQuorum(deps, row, ctx, fields);
    const target = await listShareTarget(ctx.indexerDb, {
        row: fields,
        config: ctx.config,
        blockIndex: ctx.blockIndex,
    });
    const membership = plannedMembership(row, target.current, fields);
    const mirrorIndex = target.mirror ? Number(target.mirror.action_index) : null;
    const legs = await plannedLegs(deps, fields, mirrorIndex, ctx);

    ctx.util.resetLists();
    const injected = await injectListShareLegs(ctx, {
        legs,
        snapshotId: fields.snapshot_id,
        owner: target.owner,
        homeChain: fields.home_chain,
        homeListIndex: fields.home_list_index,
    });
    const appliedIndex = injected.mirrorIndex || mirrorIndex;
    await verifyMirrorMembers(ctx.indexerDb, {
        mirrorIndex: appliedIndex,
        blockIndex: ctx.blockIndex,
        membersHash: fields.members_hash,
        snapshotId: fields.snapshot_id,
    });
    await recordListShareApplied(ctx.indexerDb, {
        actionIndexes: injected.actionIndexes,
        snapshotId: fields.snapshot_id,
        homeChain: fields.home_chain,
        homeListIndex: fields.home_list_index,
        coin: ctx.coin,
        blockIndex: ctx.blockIndex,
    });
    return { applied: true, actionIndexes: injected.actionIndexes, membership };
}

module.exports = function createApply(deps){
    wireListMetaConsumer(deps);
    return {
        applyListShareSnapshot: (row, ctx) => applyListShareSnapshot(deps, row, ctx),
    };
};
