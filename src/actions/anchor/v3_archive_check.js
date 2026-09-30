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
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const validate = require('./validate.js');

const ZERO_HASH = '0'.repeat(64);

function archiveShapeReason(handler, archive){
    const head = Object.assign({
        CHAIN: 'BTC',
        NETWORK: handler.config.NETWORK,
        BLOCK_INDEX_CHECKPOINTED: '0',
        CHECKPOINT_SEQ: '0',
        SNAPSHOT_BLOCK: '0',
        BLOCK_HASH: ZERO_HASH,
        LEDGER_HASH: ZERO_HASH,
        ACTIONS_HASH: ZERO_HASH,
        CONTRACT_HASH: ZERO_HASH
    }, archive);
    return validate.validateHeadShape(handler.config, head, null);
}

function foldArchiveReason(handler, archive, data){
    if(archive === null) return null;

    const shapeReason = archiveShapeReason(handler, archive);
    if(shapeReason || Number(archive.TOTAL_CHUNKS) !== 1) return shapeReason;

    const crc = handler.archiveCrc(archive.ARCHIVE_B64);
    if(crc === null) return 'invalid: ARCHIVE_B64 (not gzip)';
    if(crc !== archive.BATCH_CRC32) return 'invalid: BATCH_CRC32 (archive mismatch)';

    const countCheckActive = gateRegistry.activeAt(
        'archive_match_count_activation.ARCHIVE_MATCH_COUNT_ACTIVATION',
        handler.config.NETWORK, null, Number(data.BLOCK_INDEX), null
    );
    if(countCheckActive && handler.archiveMatchCount(archive.ARCHIVE_B64) !== Number(archive.MATCH_COUNT))
        return 'invalid: MATCH_COUNT (archive mismatch)';
    return null;
}

module.exports = { foldArchiveReason };
