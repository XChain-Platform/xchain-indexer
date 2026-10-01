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
 * XChain Platform - shared-list settlement pass.
 *
 ********************************************************************/

'use strict';

const swq = require('./stake_weighted_quorum.js');
const eq = require('./equivocation_header.js');
const ah = require('./gates/mirror_admission_gate.js');
const gateRegistry = require('./gate_registry.js');
const { XPOLICY_MAX_PER_BLOCK } = require('../protocol/constants.js');
const { createCanonical } = require('./list_share_settle/canonical.js');
const createQuorum = require('./bridge_settle/quorum.js');
const { createScreen } = require('./list_share_settle/screen.js');
const { planListShareInputs } = require('./list_share_settle/inputs.js');
const createApply = require('./list_share_settle/apply.js');
const { ListShareHaltError } = require('./list_share_settle/halt.js');

const canonical = createCanonical({ ah, eq });
const quorum = createQuorum({ swq });
const screen = createScreen({ ah });
const apply = createApply({ canonical, quorum, screen });

function consumerActive(ctx){
    return gateRegistry.activeAt(
        'list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION',
        ctx.network,
        ctx.coin,
        ctx.blockIndex,
        null
    ) && ah.isMirrorAdmissionConsumerActive(
        ctx.coin,
        ctx.network,
        ctx.blockIndex
    );
}

function plannerHalt(plan){
    const halt = plan.halt;
    const id = String(halt.home_chain) + ':' + String(halt.home_list_index) + ':' + String(halt.seq);
    return new ListShareHaltError(halt.reason, id);
}

async function processListSharePass(ctx){
    if(!consumerActive(ctx)) return { applied: [] };

    const plan = await planListShareInputs(ctx.indexerDb, {
        network: ctx.network,
        coin: ctx.coin,
        blockIndex: ctx.blockIndex,
        cap: XPOLICY_MAX_PER_BLOCK || 5,
    });
    if(plan.halt) throw plannerHalt(plan);

    const applied = [];
    for(const row of plan.due){
        await apply.applyListShareSnapshot(row, ctx);
        applied.push(row.snapshot_id);
    }
    return { applied };
}

module.exports = {
    processListSharePass,
    applyListShareSnapshot: apply.applyListShareSnapshot,
    listShareCanonical: canonical.listShareCanonical,
};
