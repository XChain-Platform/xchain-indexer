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
 * test/integration/scenarios/core/04_complex_actions.test/helpers/complex_chain.js
 *
 * The actors, tokens, block time, fresh-indexer and gas-token helpers the complex-actions
 * suite shares: 04_complex_actions.test.js and the parts beside it in 04_complex_actions.test/.
 */

'use strict';

const { decoderQuery, createDatabases, createDecoderSchema, resetDecoderDb, resetIndexerDb,
        closeAll } = require('../../../../setup/db-connection');
const DecoderSeeder = require('../../../../setup/decoder-seeder');
const { initIndexer, destroyFileIndexers } = require('../../../../setup/indexer-launcher');

// ---------------------------------------------------------------------------
// Addresses (30 chars)
// ---------------------------------------------------------------------------
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp';
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // sweep destination / airdrop member
const ADDR4 = 'my5gN5QBFhAziVKAhrrVyqJDrkjwbjDKP6'; // airdrop member
const GAS_ADDR = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // GAS address (regtest)

// ---------------------------------------------------------------------------
// Token names
// ---------------------------------------------------------------------------
const TICK_X = 'XTOKEN';
const TICK_Y = 'YTOKEN';
const TICK_GAS = 'XCHAIN'; // Platform gas token

// ---------------------------------------------------------------------------
// Block times
// ---------------------------------------------------------------------------
const T0 = 1700000000;

// ---------------------------------------------------------------------------
// Helper: fresh indexer + seeder per test group
// ---------------------------------------------------------------------------
async function freshIndexer() {
    await resetDecoderDb();
    await resetIndexerDb();
    const seeder  = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();
    return { seeder, indexer };
}

/**
 * Seed the XCHAIN gas token (issue + mint + send to addr) in blocks 1-3.
 * Returns the next available block index (3).
 */
async function seedGasToken(seeder, addr, amount) {
    await seeder.seedBlock(1, T0 - 3000, [
        { source: GAS_ADDR, destination: null, amount: '0',
          data: 'ISSUE|0|' + TICK_GAS + '|999999999|999999999|0' },
    ]);
    await seeder.seedBlock(2, T0 - 2000, [
        { source: GAS_ADDR, destination: null, amount: '0',
          data: 'MINT|0|' + TICK_GAS + '|' + amount },
    ]);
    await seeder.seedBlock(3, T0 - 1000, [
        { source: GAS_ADDR, destination: null, amount: '0',
          data: 'SEND|0|' + TICK_GAS + '|' + amount + '|' + addr + '|' },
    ]);
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

module.exports = { ADDR1, ADDR2, ADDR3, ADDR4, TICK_X, TICK_Y, T0, freshIndexer, seedGasToken, fileSchemaHooks };
