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
 * test/integration/scenarios/03_order_dispenser.test/helpers/order_book_chain.js
 *
 * The actors, tokens, block times and fresh-indexer helper the order and dispenser suite
 * shares: 03_order_dispenser.test.js and the parts beside it in 03_order_dispenser.test/.
 */

'use strict';

const { decoderQuery, createDatabases, createDecoderSchema, resetDecoderDb, resetIndexerDb,
        closeAll } = require('../../../setup/db-connection');
const DecoderSeeder = require('../../../setup/decoder-seeder');
const { initIndexer, destroyFileIndexers } = require('../../../setup/indexer-launcher');
const { seedGas } = require('../../../setup/gas-seeder');

// ---------------------------------------------------------------------------
// Addresses (30 chars, valid P2PKH length)
// ---------------------------------------------------------------------------
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issues ALPHA
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // issues BETA
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // dispenser payment collector

// ---------------------------------------------------------------------------
// Token names
// ---------------------------------------------------------------------------
const TICK_A = 'ALPHA';   // issued by ADDR1
const TICK_B = 'BETA';    // issued by ADDR2
const TICK_D = 'DTOKEN';  // used in dispenser tests

// ---------------------------------------------------------------------------
// Block times: start far enough in the past so expirations can be set
// ---------------------------------------------------------------------------
const T0 = 1700000000;        // base time
const T_FAR_FUTURE = T0 + 90 * 86400 + 1; // > 90 days ahead → triggers fee, still valid

// ---------------------------------------------------------------------------
// Helper: fresh indexer per test
// ---------------------------------------------------------------------------
async function freshIndexer() {
    await resetDecoderDb();
    await resetIndexerDb();
    const seeder  = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();
    // Fee era: the ISSUEs in these suites need gas; seed XCHAIN to the actors
    await seedGas(seeder, { addresses: [ADDR1, ADDR2, ADDR3] });
    return { seeder, indexer };
}

// The schema hooks for a part file, which registers them in each of its blocks. The entry
// file keeps its own root hooks.
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

module.exports = { ADDR1, ADDR2, ADDR3, TICK_A, TICK_B, TICK_D, T0, T_FAR_FUTURE, freshIndexer, fileSchemaHooks };
