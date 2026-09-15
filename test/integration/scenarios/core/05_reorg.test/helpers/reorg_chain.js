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
 * test/integration/scenarios/core/05_reorg.test/helpers/reorg_chain.js
 *
 * The actors, block timing, decoder-block deletion and hooks the reorg suite shares:
 * 05_reorg.test.js and the parts beside it in 05_reorg.test/. Each file passes its own
 * __filename to fileSchemaHooks, so it claims scoped schemas of its own.
 */

'use strict';

const { decoderQuery, createDatabases, createDecoderSchema, resetDecoderDb, resetIndexerDb,
        closeAll } = require('../../../../setup/db-connection');
const { destroyFileIndexers } = require('../../../../setup/indexer-launcher');

// ---------------------------------------------------------------------------
// Addresses (30-char strings, safe for the indexer's address validation)
// ---------------------------------------------------------------------------
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp';
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi';

// Base block time (Unix timestamp)
const T0 = 1700000000;
const BLK = 600; // seconds per block

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Delete decoder blocks >= blockIndex (and their transactions / outputs).
 * Call this after seeding a reorg event but before seeding replacement blocks.
 */
async function deleteDecoderBlocksFrom(blockIndex) {
    await decoderQuery(
        'DELETE FROM transaction_outputs WHERE tx_index IN ' +
        '(SELECT tx_index FROM transactions WHERE block_index >= ?)',
        [blockIndex]
    );
    await decoderQuery('DELETE FROM transactions WHERE block_index >= ?', [blockIndex]);
    await decoderQuery('DELETE FROM blocks WHERE block_index >= ?', [blockIndex]);
}

// The schema hooks for one test file, passed to before()/after() by name rather than
// wrapped, so `this` is still the mocha context and the timeout below still applies.
function fileSchemaHooks(testFile) {
    return {
        async createFileSchemas() {
            this.timeout(30000);
            await createDatabases(testFile);
            await createDecoderSchema();
        },
        async closeFileSchemas() {
            await destroyFileIndexers(testFile);
            await closeAll();
        },
    };
}

async function freshChain() {
    this.timeout(15000);
    await resetDecoderDb();
    await resetIndexerDb();
}

module.exports = { ADDR1, ADDR2, ADDR3, T0, BLK, deleteDecoderBlocksFrom, fileSchemaHooks, freshChain };
