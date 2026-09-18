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
 * test/integration/scenarios/core/02_issue_mint_send.test/helpers/lifecycle_chain.js
 *
 * The actors, the block-time baseline and the per-test chain every file of the token
 * lifecycle suite shares: 02_issue_mint_send.test.js and the parts beside it in
 * 02_issue_mint_send.test/. Each file passes its own __filename to fileSchemaHooks, so it
 * claims scoped schemas of its own and never shares a database with another file.
 */

'use strict';

const { decoderQuery, createDatabases, createDecoderSchema, resetDecoderDb, resetIndexerDb,
        closeAll } = require('../../../../setup/db-connection');
const DecoderSeeder = require('../../../../setup/decoder-seeder');
const { initIndexer, destroyFileIndexers } = require('../../../../setup/indexer-launcher');
const { seedGas } = require('../../../../setup/gas-seeder');

// ---------------------------------------------------------------------------
// Test addresses: valid regtest P2PKH (isCryptoAddress validates base58check)
// ---------------------------------------------------------------------------
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // 30 chars, primary issuer
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // 30 chars, secondary actor
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // 30 chars, recipient

// Block time baseline
const BASE_TIME = 1700000000;

// The schema hooks for one test file. createDatabases drops and recreates that file's own
// scoped schemas, so registering them in every block repeats the same work, not new work,
// and closeAll only ends pools that the next block's first query reopens.
function fileSchemaHooks(testFile) {
    return {
        async createFileSchemas() {
            await createDatabases(testFile);
            await createDecoderSchema();
        },
        async closeFileSchemas() {
            await destroyFileIndexers(testFile);
            await closeAll();
        },
    };
}

// A reset chain and a fresh indexer for one test. Gas lands at 99, so tests seed from 100:
// processBlocks runs every pass at every height between, and a gap outgrows the timeout.
async function freshLifecycleChain() {
    await resetDecoderDb();
    await resetIndexerDb();
    const seeder = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();
    // Fee era: every ISSUE below needs gas; seed XCHAIN to the actors first
    await seedGas(seeder, { addresses: [ADDR1, ADDR2, ADDR3] });
    return { seeder, indexer };
}

module.exports = { ADDR1, ADDR2, ADDR3, BASE_TIME, fileSchemaHooks, freshLifecycleChain };
