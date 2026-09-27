/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

function deriveLateness(row, blockIndex, mirrorMaturity){
    return Number(blockIndex) - (Number(row.snapshot_block) + Number(mirrorMaturity));
}

function recordLateDerive(logger, row, blockIndex, mirrorMaturity){
    let lateness = deriveLateness(row, blockIndex, mirrorMaturity);
    if(lateness > 0){
        try {
            logger.info('anchor reward ' + row.reward_type + '/' + row.round_reference +
                        ' publisher ' + row.publisher + ' derived ' + lateness + ' blocks late');
        } catch(_error) {}
    }
    return lateness;
}

module.exports = { deriveLateness, recordLateDerive };
