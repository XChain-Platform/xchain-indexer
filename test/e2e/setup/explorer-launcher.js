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
 * Explorer launcher for E2E tests.
 *
 * Starts xchain-explorer's XChainExplorer class on an ephemeral HTTP port,
 * bypassing the SSL-dependent config.js and api.js entry point.
 *
 * The explorer reads directly from the test indexer database, so any state
 * written by the indexer is immediately visible through the API.
 */

'use strict';

const http    = require('http');
const express = require('express');
const cors    = require('cors');
const path    = require('path');

// Set package info before requiring explorer (it reads process.env.npm_package_*)
process.env.npm_package_version = process.env.npm_package_version || '1.0.0-test';
process.env.npm_package_name    = process.env.npm_package_name    || 'xchain-explorer';

const XChainExplorer = require(path.resolve(__dirname, '../../../../xchain-explorer/src/XChainExplorer.js'));
const { DB_HOST, DB_PORT, DB_USER, DB_PASS, DECODER_DB, INDEXER_DB } = require('../../integration/setup/db-connection');

/**
 * Build a configInfo object that satisfies XChainExplorer and its db.js layer.
 * Only configures BTC regtest pointed at the test databases.
 */
function buildTestConfigInfo() {
    const config = {
        COIN_NETWORKS:  { BTC: 'Bitcoin' },
        COIN_PREFIXES:  { mainnet: '', testnet: 'T', regtest: 'R' },
        COIN_SUPPORTED: { BTC: 'Bitcoin (mainnet)', TBTC: 'Bitcoin (testnet)', RBTC: 'Bitcoin (regtest)' },
        COIN_AVAILABLE: { RBTC: 'BTC (regtest)' },
        DISPENSER_LIST_DELAY: 3600,
        API: {
            host: '127.0.0.1',
            user: false,
            pass: false,
            ssl:  null,
            port: { http: 0, https: 0 }
        },
        BTC: {
            chain: { name: 'Bitcoin', tick: 'BTC', site: 'https://bitcoin.org' },
            regtest: {
                database: {
                    indexer: { db_host: DB_HOST, db_port: DB_PORT, user: DB_USER, pass: DB_PASS, name: INDEXER_DB },
                    decoder: { db_host: DB_HOST, db_port: DB_PORT, user: DB_USER, pass: DB_PASS, name: DECODER_DB }
                },
                address: {
                    burn:      'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    gas:       'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    protocol:  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    community: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                    explorer:  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
                }
            }
        }
    };

    return {
        getConfig:            async () => config,
        onConfigChanged:      () => {},
        triggerConfigChanged: () => {}
    };
}

/**
 * Start the explorer on an ephemeral HTTP port.
 * @returns {Promise<{server: http.Server, port: number, explorer: XChainExplorer}>}
 */
async function startExplorer() {
    const app = express();
    app.use(express.json());
    app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

    const testConfigInfo = buildTestConfigInfo();
    const explorer = new XChainExplorer(app, testConfigInfo);
    await explorer.init();

    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port, explorer });
        });
        server.once('error', reject);
    });
}

/**
 * Close the explorer's MariaDB connection pools.
 * Call this before resetIndexerDb() to avoid leaked connections.
 */
async function closeExplorerPools(explorer) {
    if (explorer && explorer.db && explorer.db.pools) {
        for (const key of Object.keys(explorer.db.pools)) {
            try {
                if (explorer.db.pools[key].pool)
                    await explorer.db.pools[key].pool.end();
            } catch (e) { /* ignore cleanup errors */ }
        }
        explorer.db.pools = {};
    }
}

/**
 * Re-initialize the explorer's DB pools after a database reset.
 * Must be called after resetIndexerDb() so the explorer reconnects.
 */
async function resetExplorerPools(explorer) {
    await closeExplorerPools(explorer);
    await explorer.db.setupConnectionPools();
}

/**
 * Stop the explorer and close its database pools.
 */
async function stopExplorer(server, explorer) {
    await closeExplorerPools(explorer);
    await new Promise((resolve) => server.close(resolve));
}

module.exports = { startExplorer, stopExplorer, closeExplorerPools, resetExplorerPools };
