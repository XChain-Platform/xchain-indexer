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
 * Shared lifecycle for the Block Discovery and Sync suite.
 *
 * The entry file and its parts each register their own describe block under
 * one title, so the hooks, fixtures and the per-test state object live here
 * and every block calls in. The test file is a parameter because the DB
 * harness scopes its databases and live indexers by caller file.
 */

'use strict';

const {
    decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb, closeAll,
} = require('../../../../setup/db-connection');
const DecoderSeeder = require('../../../../setup/decoder-seeder');
const {
    initIndexer, processBlocks, destroyIndexer, destroyFileIndexers,
} = require('../../../../setup/indexer-launcher');
const { seedGas } = require('../../../../setup/gas-seeder');
const {
    assertBlockCount, assertHashChain, countRows, getActionIndex,
} = require('../../../../setup/assertion-helpers');

// Addresses: valid regtest P2PKH (base58check-validated)
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // 30 chars
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // 30 chars
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // 30 chars

// A block time baseline (unix epoch seconds, ~2023)
const BASE_TIME = 1700000000;
const TITLE = 'Block Discovery and Sync @regression @tier3';

function defineBlockDiscoverySuite(testFile, registerTests) {
    describe(TITLE, function () {
        // Allow generous timeout for DB operations
        this.timeout(30000);
        const state = {};

        before(async function () {
            await createDatabases(testFile);
            await createDecoderSchema();
        });
        beforeEach(async function () {
            await resetDecoderDb();
            await resetIndexerDb();
            state.seeder = new DecoderSeeder(decoderQuery);
            state.indexer = await initIndexer();
        });
        afterEach(async function () {
            await destroyIndexer(state.indexer);
        });
        after(async function () {
            await destroyFileIndexers(testFile);
            await closeAll();
        });
        registerTests(state);
    });
}

module.exports = {
    ADDR1, ADDR2, ADDR3, BASE_TIME,
    defineBlockDiscoverySuite,
    indexerQuery, processBlocks, seedGas,
    assertBlockCount, assertHashChain, countRows, getActionIndex,
};
