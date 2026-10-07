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

const diag = require('../diagnostic_events.js');
const { foldActionRows } = require('./v3_rows.js');
const { getLogger } = require('../../../observability/index.js');

function failureEvent(data, sections){
    return {
        chain: sections.map(section => section.CHAIN).join(','),
        reason: data.STATUS,
        network: data.NETWORK,
        version: 3,
        snapshot_block: data.SNAPSHOT_BLOCK,
        block_index: data.BLOCK_INDEX
    };
}

function wrapperSignatures(sections, archive){
    if(archive === null) return [];
    let section = sections[Number(archive.WRAPPER_SECTION_INDEX)];
    return section ? section.SIGS : [];
}

async function recordFoldAction(handler, data, sections, archive, publisherSigs, error){
    data.PUBLISHER_ATTESTATIONS = publisherSigs.length > 0 ? JSON.stringify(publisherSigs) : null;
    if(!data.STATUS) data.STATUS = error || 'valid';

    let chains = sections.map(section => section.CHAIN).join(',');
    let archiveCount = archive === null ? 0 : 1;
    getLogger().info('ANCHOR v3 : ' + data.NETWORK + ' @ snapshot ' + data.SNAPSHOT_BLOCK +
        ' (' + sections.length + ' section(s): ' + chains + ') : ARCHIVE_COUNT ' +
        archiveCount + ' : ' + data.STATUS);

    if(diag.isAnchorFailureStatus(data.STATUS))
        diag.noteAnchorFailed(failureEvent(data, sections));

    let rows = foldActionRows(data, sections, archive, wrapperSignatures(sections, archive));
    for(let row of rows) await handler.indexerDb.createAnchorAction(row);
}

module.exports = { recordFoldAction };
