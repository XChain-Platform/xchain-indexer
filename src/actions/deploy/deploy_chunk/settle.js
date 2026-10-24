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
 * XChain Platform - DEPLOY v4 (chunk carrier): the carrier's own rows
 *
 * The deploy_chunks row every carrier writes, valid or not, and the ledger
 * write of a carrier that did NOT complete a pending group (one that did has
 * its ledger written by the deployment it triggered). A part of
 * actions/deploy/deploy_chunk.js, called from parse().
 *
 ********************************************************************/

const { getLogger } = require('../../../observability/index.js');

// The strict server rounds a fractional bind to the nearest integer, so an INT UNSIGNED
// column takes exactly the values inside these two half-unit boundaries.
const U32_ROUNDED_MIN_EXCLUSIVE = -0.5;
const U32_ROUNDED_MAX_EXCLUSIVE = 4294967295.5;

/**
 * Log the carrier's verdict and persist its slice.
 *
 * @param {DeployChunk} carrier  the owning chunk handler
 * @param {object}      data     the carrier's transaction context, STATUS already set
 * @param {{chunkIndex: number, totalChunks: number, partBytes: number, status: string}} slice
 */
async function recordCarrier(carrier, data, slice){
    let { chunkIndex, totalChunks, partBytes, status } = slice;
    let storesInU32 = (value) => Number.isFinite(value) &&
        value > U32_ROUNDED_MIN_EXCLUSIVE && value < U32_ROUNDED_MAX_EXCLUSIVE;
    // Print status message
    getLogger().info("\t DEPLOY v4 : hash=" + data['CODE_HASH'] + ' : ' + chunkIndex + '/' + totalChunks +
        ' : bytes=' + partBytes + ' : ' + data['STATUS']);

    // Persist the chunk (stored valid or invalid so the explorer can surface its status;
    // the DEPLOY assembler reads only VALID rows). A CHUNK_INDEX or TOTAL_CHUNKS that does
    // not fit its INT UNSIGNED column was refused in validateChunkFormat; the row keeps
    // that refusal under the placeholder 0, since both columns are NOT NULL and an
    // unrepresentable bind fails the INSERT and halts the block.
    await carrier.indexerDb.recordDeployChunk({
        ACTION_INDEX : data['ACTION_INDEX'],
        SOURCE       : data['SOURCE'],
        CODE_HASH    : data['CODE_HASH'],
        CHUNK_INDEX  : storesInU32(chunkIndex) ? chunkIndex : 0,
        TOTAL_CHUNKS : storesInU32(totalChunks) ? totalChunks : 0,
        CODE_PART    : data['CODE_PART'],
        STATUS       : status,
        BLOCK_INDEX  : data['BLOCK_INDEX']
    });
}

/**
 * Write the carrier's ledger changes, balances, token supply and action mappings.
 *
 * @param {DeployChunk} carrier  the owning chunk handler
 * @param {object}      data     the carrier's transaction context
 * @param {Array}       credits  [tick, amount, address] credits (none today)
 * @param {Array}       debits   [tick, amount, address] debits (the gas fee, XCHAIN mode only)
 */
async function writeCarrierLedger(carrier, data, credits, debits){
    // Process any transaction ledger changes (credits / debits)
    await carrier.util.processTransactionLedgerChanges(carrier.indexerDb, data, credits, debits);

    // Get a list of tickers & addresses
    let tickers   = carrier.util.getTickersList(),
        addresses = Object.keys(carrier.util.getAddressesList());

    // Update address balances and token supply
    await carrier.indexerDb.updateBalances(addresses);
    await carrier.indexerDb.updateTokens(tickers);

    // Create action mappings
    await carrier.mapper.createMappings(data);
}

module.exports = { recordCarrier, writeCarrierLedger };
