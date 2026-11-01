/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Decoder block-time window reads. Each UNION branch uses the blocks
 * primary height index to collect one landing block and its predecessors,
 * while the complete statement keeps an API page to one database read.
 ********************************************************************/

'use strict';

const { rethrowIfInfraFault } = require('../../consensus/fault_guard');

function timeWindowBranch(rowCount) {
    return `(SELECT ? AS requested_block_index, block_index, block_time
             FROM blocks
             WHERE block_index <= ? AND (block_index = ? OR block_time IS NOT NULL)
             ORDER BY block_index DESC LIMIT ${rowCount})`;
}

module.exports = {
    async getStoredBlockTimeWindows(blockIndexes, previousCount) {
        const seen = new Set();
        const keys = [];
        for (const value of (Array.isArray(blockIndexes) ? blockIndexes : [])) {
            const key = Number(value);
            if (!Number.isSafeInteger(key) || key < 0 || seen.has(key)) continue;
            seen.add(key);
            keys.push(key);
        }
        if (keys.length === 0) return [];

        const span = Number(previousCount);
        const rowCount = Number.isSafeInteger(span) && span > 0 ? span + 1 : 1;
        const query = keys.map(() => timeWindowBranch(rowCount)).join(' UNION ALL ');
        const params = keys.flatMap(key => [key, key, key]);
        try {
            return await this.doQueryStrict(query, params);
        } catch (e) {
            rethrowIfInfraFault(e);
            return [];
        }
    }
};
