/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration: Phase E permissions manifest — deploy persistence.
 *
 * Drives real DEPLOY actions through the full indexer pipeline (decoder seed →
 * processBlocks) against a real MariaDB + the real (isolated-vm) VM. Verifies the
 * deploy → vm.readManifest → validate → db.createContractPermission wiring end to
 * end:
 *   - a declared manifest persists permissions + maxTakeBps to contract_permissions
 *   - a bare contract stores NO manifest row (unrestricted default)
 *   - a malformed manifest REJECTS the deploy (CONTRACT_MANIFEST) and stores no row
 *
 * Caught a real bug the mocked enforcement unit tests missed: normalizeDataValues
 * coerced the permissions ARRAY to a comma-joined string before JSON.stringify, so
 * the stored JSON silently disabled the allowlist on read-back (fixed in db.js;
 * pinned by test/unit/contract-permissions-persist.test.js).
 *
 * Run (disposable MariaDB, e.g. a throwaway container):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=root TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=cverify_pe_decoder TEST_INDEXER_DB=cverify_pe_indexer \
 *   TEST_INDEXER_DB_B=cverify_pe_indexer_b \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config --exit test/integration/scenarios/16-controller-permissions.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');

const DEPLOYER = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // valid regtest P2PKH
const T0  = 1700000000;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

const MANIFEST_C = "module.exports={ permissions:['SEND','ISSUE'], maxTakeBps:300, guard:function(){ return {}; } };";
const BARE_C     = "module.exports={ guard:function(){ return {}; } };";
const BAD_C      = "module.exports={ permissions:['SEND'], maxTakeBps:2.5, guard:function(){ return {}; } };";

describe('Phase E permissions manifest — deploy persistence (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    let seeder, indexer;

    before(async function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases();
        await createDecoderSchema();
        seeder = new DecoderSeeder(decoderQuery);
        await seedGas(seeder, { addresses: [DEPLOYER], amount: '100' });
        await seeder.seedBlock(100, T0, [
            { source: DEPLOYER, data: `DEPLOY|0|${hex(MANIFEST_C)}|300000|` },
            { source: DEPLOYER, data: `DEPLOY|0|${hex(BARE_C)}|300000|` },
            { source: DEPLOYER, data: `DEPLOY|0|${hex(BAD_C)}|300000|` },
        ]);
        indexer = await initIndexer();
        await processBlocks(indexer);
    });

    after(async function () {
        if (indexer) await destroyIndexer(indexer);
        await closeAll();
    });

    async function rowFor(code) {
        const h = sha(code);
        const rows = await indexerQuery(
            `SELECT c.action_index, c.code_hash, s.status AS status,
                    cp.permissions AS permissions, cp.max_take_bps AS max_take_bps
             FROM contracts c
             LEFT JOIN index_statuses s ON s.id = c.status_id
             LEFT JOIN contract_permissions cp ON cp.contract_index = c.action_index`, []);
        return rows.find(r => r.code_hash === h);
    }

    it('persists a declared manifest (permissions + maxTakeBps) on a clean deploy', async function () {
        const row = await rowFor(MANIFEST_C);
        assert.ok(row, 'manifest contract was deployed');
        assert.strictEqual(row.status, 'valid', 'clean deploy is valid');
        assert.ok(row.permissions, 'contract_permissions row persisted');
        assert.deepStrictEqual(JSON.parse(row.permissions), ['SEND', 'ISSUE'], 'permissions persisted as a JSON array');
        assert.strictEqual(Number(row.max_take_bps), 300, 'maxTakeBps persisted');
    });

    it('a bare contract (no manifest) stores NO contract_permissions row', async function () {
        const row = await rowFor(BARE_C);
        assert.ok(row, 'bare contract deployed');
        assert.strictEqual(row.status, 'valid', 'bare deploy is valid');
        assert.strictEqual(row.permissions, null, 'no manifest row → unrestricted default');
    });

    it('a malformed manifest REJECTS the deploy (CONTRACT_MANIFEST) and stores no row', async function () {
        const row = await rowFor(BAD_C);
        assert.ok(row, 'bad-manifest contract row exists with its (invalid) status');
        assert.ok(/CONTRACT_MANIFEST/.test(row.status || ''), 'rejected with CONTRACT_MANIFEST, got: ' + row.status);
        assert.strictEqual(row.permissions, null, 'no contract_permissions row for a rejected deploy');
    });
});
