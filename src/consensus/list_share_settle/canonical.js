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

const crypto = require('crypto');

function canonicalField(value) {
    return value === null || value === undefined ? '' : String(value);
}

function deriveListSnapshotId(network, homeChain, homeListIndex, seq, snapshotBlock) {
    const preimage = [
        'XLISTSHARE',
        network,
        homeChain + ':' + homeListIndex,
        seq,
        snapshotBlock,
    ].join('|');
    return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

function listShareCanonical(deps, row) {
    const { ah, eq } = deps;
    const text = [
        'XLISTSHARE',
        row.snapshot_id,
        row.snapshot_block,
        row.home_chain,
        row.home_list_index,
        row.list_type,
        row.seq,
        row.kind,
        row.origin_block,
        row.members_hash,
        row.network,
    ].map(canonicalField).join('|');
    const admitBlocks = ah.columnsAdmitBlocks(row);
    if (admitBlocks === null || admitBlocks === undefined)
        throw new Error('List share canonical requires an admission map');

    const admitted = text + ah.admissionCanonicalField(
        'CrossChainListShare',
        row.network,
        row.snapshot_block,
        admitBlocks,
    );
    if (eq.isEquivHeaderActive(row.snapshot_block, row.network)) {
        return eq.buildEquivCanonical(
            eq.ENGINE_TAGS.LIST_SHARE,
            row.snapshot_id,
            row.finalizing_view != null ? row.finalizing_view : 0,
            admitted,
        );
    }
    return admitted;
}

function createCanonical(deps) {
    return {
        listShareCanonical: row => listShareCanonical(deps, row),
    };
}

module.exports = { createCanonical, deriveListSnapshotId };
