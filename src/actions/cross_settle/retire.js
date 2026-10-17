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
 **********************************************************************
 *
 * Retirement of a mirrored match this chain cannot settle, so it stops holding a
 * slot in the capped settlement pass.
 *
 * Three exits of the handler write nothing: a quorum that falls short against a
 * snapshot that IS present, a local leg that is an indexed action but not an
 * offer (the dismissal probe), and a local leg that is not there at all. The pass
 * excludes only matches with a cross_chain_settlements row, so such a match is
 * re-read on every block, and 25 of them ahead of a valid match keep it out of
 * the per-block prefix for good. From PASS_PROGRESS_RETIREMENT_ACTIVATION, once
 * the match has been selectable for the grace (consensus/pass_retirement), it is
 * retired: a CROSS_SETTLE action index is minted as the rollback anchor and a
 * settlement row is recorded with both leg references NULL.
 *
 * A retirement moves no value and changes no offer. The NULL legs keep it out of
 * the VM's crossChain.isSettled snapshot, which reads only rows that name their
 * legs, and the table carries no status column, so the reason is in the log line.
 * The local offer stays open, so a later match for it settles normally; the
 * retired match_id itself is final on this branch, exactly as a settled one is,
 * and a reorg below the retirement block erases it with its action index.
 *
 * Called with the handler as `this`, the way quorum.js and local_leg.js are.
 *
 ********************************************************************/

'use strict';

const passRetirement = require('../../consensus/pass_retirement');

const { getLogger } = require('../../observability/index.js');

/**
 * Retire an unapplicable match once it has aged past the grace.
 *
 * @param {Object} data   - the action row under construction; reads BLOCK_INDEX, writes
 *                          ACTION_INDEX and STATUS when it retires
 * @param {Object} m      - the mirrored cross_chain_matches row
 * @param {Object} leg    - the local leg local_leg.js resolved
 * @param {string} reason - no_quorum | dismissed | no_leg
 * @returns {Promise<boolean>} true when the match was retired
 */
async function retireUnapplicableMatch(data, m, leg, reason){
    let blockIndex = data['BLOCK_INDEX'];
    if(!passRetirement.isPassRetirementActive(this.config, blockIndex))
        return false;
    if(!await passRetirement.rowAgedOut(this.indexerDb, this.decoderDb, m, blockIndex, this.config['COIN']))
        return false;

    // Minted only once the match is retired: an index minted on a match that stays in the
    // queue would move every later action index for nothing.
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({ ACTION: 'CROSS_SETTLE', BLOCK_INDEX: blockIndex }, true);
    data['STATUS'] = 'retired:' + reason;

    getLogger().info("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : unapplicable (' + reason + ') past the grace : retiring : block=' + blockIndex);

    await this.indexerDb.recordCrossChainSettlementRetirement(data['ACTION_INDEX'], m.match_id, leg.localActionIndex, blockIndex);
    return true;
}

module.exports = { retireUnapplicableMatch };
