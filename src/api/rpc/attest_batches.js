/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * XChain Indexer - JSON-RPC attest batch family.
 ********************************************************************/

'use strict';

const batchQuery = require('../price_batch_query.js');
const { getLogger } = require('../../observability/index.js');

function attestBatchesRpc({ indexer }) {
    return {
        async getattestbatches(body) {
            if (!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let v = batchQuery.validateAttestBatchParams(body);
            if (!v.ok) return { error: v.error };
            let db = indexer.indexerDb.apiView();
            try {
                let rows = await db.getCompleteAttestBatchesByWindowStart(
                    v.window_start_from, v.window_start_to, v.limit);
                return batchQuery.buildAttestBatchesResponse(rows, v);
            } catch (err) {
                getLogger().error('getattestbatches error:', err);
                return { error: 'failed to look up attest batches' };
            }
        },
    };
}

module.exports = { buildAttestBatchesRpc: attestBatchesRpc };
