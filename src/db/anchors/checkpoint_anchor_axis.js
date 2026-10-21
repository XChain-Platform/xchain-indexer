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
 **********************************************************************
 *
 * XChain Platform - the bridge escrow checkpoint reads on the BTC anchor axis.
 *
 * getEarliestValidAnchorCheckpoint and getMirroredStateCheckpointCandidates (anchors/index.js)
 * range on the checkpoint's own block_index. These two range on its snapshot_block instead:
 * the lowest snapshot_block STRICTLY above a bridge row's snapshot_block, which is how a DOGE-
 * or LTC-origin escrow checkpoint is selected from BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION
 * (src/consensus/bridge_checkpoint_check/anchor_match.js). Same sources, filters, strictness
 * and limits; only the ranged column and the leading sort term move. The strict bound is part
 * of the rule, not a convenience: a checkpoint at the stamp's own BTC height can predate it.
 * Spread into the anchors mixin, so these are Database prototype methods like their siblings.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // Strict, as its block_index sibling: a fault returned as [] would read as "no rows". The
    // primary key ends the order so the pick is total where two valid rows tie on
    // (snapshot_block, checkpoint_seq).
    async getEarliestValidAnchorCheckpointAfterAnchor(version, chain, network, afterSnapshotBlock){
        // version is one section version or a list of them, bound as one placeholder each.
        const versions = [].concat(version);
        return await this.doQueryStrict(
            `SELECT a.chain, a.network, a.block_index, a.checkpoint_seq, a.snapshot_block,
                    a.state_root, a.state_root_version
             FROM anchor_actions a
             JOIN index_statuses s ON s.id = a.status_id
             WHERE a.version IN (${versions.map(() => '?').join(', ')}) AND a.chain = ? AND a.network = ? AND a.snapshot_block > ?
               AND a.state_root IS NOT NULL AND s.status = 'valid'
             ORDER BY a.snapshot_block ASC, a.checkpoint_seq DESC, a.action_index ASC, a.section_index ASC
             LIMIT 1`,
            [...versions, chain, network, afterSnapshotBlock]);
    },

    // Several rows, lowest first, for the same reason as its block_index sibling: a row at the
    // lowest qualifying snapshot_block may fail re-verification. Read from the mirror home.
    async getMirroredStateCheckpointCandidatesAfterAnchor(chain, network, afterSnapshotBlock){
        return await this.mirrorDb().doQueryStrict(
            `SELECT * FROM state_checkpoints
             WHERE chain = ? AND network = ? AND snapshot_block > ? AND state_root IS NOT NULL
             ORDER BY snapshot_block ASC, checkpoint_seq DESC
             LIMIT 8`,
            [chain, network, afterSnapshotBlock]);
    },

};
