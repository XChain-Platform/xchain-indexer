'use strict';

const assert = require('assert');
const {
    buildTestConfigInfo,
    resolveExplorerModule
} = require('../../e2e/setup/explorer-launcher');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout');

const REQUIRED_DATABASE_FIELDS = ['db_host', 'db_port', 'name', 'pass', 'user'];

function connectionFixture() {
    return {
        DB_HOST: Symbol('db-host'),
        DB_PORT: Symbol('db-port'),
        DB_USER: Symbol('db-user'),
        DB_PASS: Symbol('db-pass'),
        DECODER_DB: 'decoder_run',
        INDEXER_DB: 'indexer_run'
    };
}

async function databaseBlock() {
    const configInfo = buildTestConfigInfo(connectionFixture());
    const config = await configInfo.getConfig();
    return config.BTC.regtest.database;
}

function acceptedCheckpoint(poolSetup, database) {
    const db = {
        util: { isNull: value => value === undefined || value === null || value === '' },
        decoderApiUrlFromConfig: () => null
    };
    poolSetup.resetPoolMaps(db);
    poolSetup.setNetworkPools(
        db, { createPool: () => ({}) }, { regtest: { database } }, 'BTC', 'regtest');
    return db.checkpointDb.RBTC;
}

describe('E2E explorer launcher database config', function () {
    it('provides every required checkpoint database field from the indexer connection', async function () {
        const database = await databaseBlock();

        assert.deepStrictEqual(Object.keys(database.checkpoint).sort(), REQUIRED_DATABASE_FIELDS);
        for (const field of REQUIRED_DATABASE_FIELDS) {
            assert.strictEqual(database.checkpoint[field], database.indexer[field], field);
        }
    });

    it('is accepted by the explorer checkpoint config loader', async function () {
        const loader = siblingCheckout(__dirname,
            resolveExplorerModule('src/db/connection/pool_setup.js'));
        if (!loader.usable) {
            this.test.title += ' (missing xchain-explorer sibling)';
            return skipOrFail(this, loader, 'the explorer checkpoint config loader guard');
        }

        const poolSetup = require(loader.path);
        const database = await databaseBlock();
        assert.ok(acceptedCheckpoint(poolSetup, database),
            'the explorer loader rejected the launcher checkpoint database block');

        const requiredByLoader = Object.keys(database.checkpoint).filter(field => {
            const checkpoint = { ...database.checkpoint };
            delete checkpoint[field];
            return !acceptedCheckpoint(poolSetup, { ...database, checkpoint });
        }).sort();

        assert.deepStrictEqual(requiredByLoader, Object.keys(database.checkpoint).sort(),
            'the launcher checkpoint fields and explorer loader requirements differ');
    });
});
