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
 *********************************************************************/

'use strict';

const { planDueVersions } = require('./plan.js');

async function planListShareInputs(db, { network, coin, blockIndex, cap }){
    const mirror = db.mirrorDb();
    const heads = await mirror.getListSnapshotHeads(network, coin);
    const counts = await db.getAppliedListShareCounts();
    const lists = [];

    for(const head of heads){
        const count = counts.find(row =>
            row.src_chain === head.home_chain &&
            Number(row.src_action_index) === Number(head.home_list_index)
        );
        const applied = count ? Number(count.applied_seq) : 0;

        if(BigInt(head.max_seq) <= BigInt(applied))
            continue;

        const rows = await mirror.getListSnapshotsAfter(
            network,
            head.home_chain,
            head.home_list_index,
            applied
        );
        lists.push({
            home_chain: head.home_chain,
            home_list_index: head.home_list_index,
            applied,
            rows
        });
    }

    return planDueVersions({ lists, coin, blockIndex, cap });
}

module.exports = { planListShareInputs };
