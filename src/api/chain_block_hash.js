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
 * XChain Indexer - chain block hash read for the block-hashes RPC
 *
 * The decoder-side chain block hash that the block-hashes JSON-RPC handler in
 * src/api.js signs alongside the stored per-block triple. The handler keeps
 * the committed-only view binding and passes the bound view in, so this part
 * never reaches for a raw database handle.
 *
 ********************************************************************/

'use strict';

// The chain block hash at `target` off the committed decoder view the caller
// bound, as a string, or null when the decoder holds no hash for that height.
async function chainBlockHash(decoderDb, target){
    let blockHash = null;
    let rows = await decoderDb.getDecoderBlockHashRow(target);
    if(rows.length > 0 && rows[0].block_hash) blockHash = String(rows[0].block_hash);
    return blockHash;
}

module.exports = { chainBlockHash };
