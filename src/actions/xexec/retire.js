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
 * Retirement of a mirrored dispatch this chain will not run, so it stops holding
 * a slot in the capped XEXEC injection pass.
 *
 * Two exits of the handler write no execution row: a signature set short of
 * quorum against a snapshot that IS present (index.js recordQuorumRefusal keeps
 * it retrying, since hubs gossip signatures), and cross_hops above XCALL_MAX_HOPS.
 * The pass excludes only calls with a cross_chain_call_executions row, so such a
 * dispatch is re-read on every block and 25 of them ahead of a valid one keep it
 * out of the per-block prefix for good. From PASS_PROGRESS_RETIREMENT_ACTIVATION,
 * once the dispatch has been selectable for the grace (consensus/pass_retirement,
 * sized well past hub quorum convergence), it is retired: an XEXEC action index is
 * minted as the rollback anchor and an execution row records 'retired:<reason>'.
 *
 * A retirement runs nothing: no EXECUTE index, no contract state, no gas, no
 * payload. getcrosschaincallresult reports it as not executed, so no result is
 * relayed for it and the source chain's request ends at its own deadline as
 * 'expired', the outcome the result pass's retirement leaves a requester with too.
 * The call_id is final on this branch, as an executed one is; any other call to
 * the same contract runs normally, and a reorg below the retirement block erases it.
 *
 * Called with the handler as `this`, the way dispatch_quorum.js and run_target.js are.
 *
 ********************************************************************/

'use strict';

const passRetirement = require('../../consensus/pass_retirement');

const { getLogger } = require('../../observability/index.js');

/**
 * Retire an unapplicable dispatch once it has aged past the grace.
 *
 * @param {Object} c      - the mirrored cross_chain_calls dispatch row
 * @param {Object} data   - the action row under construction; reads BLOCK_INDEX, writes
 *                          ACTION_INDEX and STATUS when it retires
 * @param {string} reason - no_quorum | cross_hops
 * @returns {Promise<boolean>} true when the dispatch was retired
 */
async function retireUnapplicableDispatch(c, data, reason){
    let blockIndex = data['BLOCK_INDEX'];
    if(!passRetirement.isPassRetirementActive(this.config, blockIndex))
        return false;
    if(!await passRetirement.rowAgedOut(this.indexerDb, this.decoderDb, c, blockIndex, this.config['COIN']))
        return false;

    // Minted only once the dispatch is retired, so a dispatch that stays queued moves no index.
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({ ACTION: 'XEXEC', BLOCK_INDEX: blockIndex }, true);
    data['STATUS'] = 'retired:' + reason;

    getLogger().info("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : unapplicable (' + reason + ') past the grace - retiring : block=' + blockIndex);

    await this.indexerDb.recordCrossChainCallRetirement(data['ACTION_INDEX'], String(c.call_id).toLowerCase(), 'retired:' + reason, blockIndex);
    return true;
}

module.exports = { retireUnapplicableDispatch };
