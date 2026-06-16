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
// Inline DEPLOY CODE_ENCODING is base64 at/after DEPLOY_BASE64_CODE, which regtest
// activates at genesis (protocol_changes.js) — so encode the fixture source as canonical
// base64 to match the indexer's decode path (deploy.js round-trips to reject non-canonical).
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

const MANIFEST_C = "module.exports={ permissions:['SEND','ISSUE'], maxTakeBps:300, guard:function(){ return {}; } };";
const BARE_C     = "module.exports={ guard:function(){ return {}; } };";
const BAD_C      = "module.exports={ permissions:['SEND'], maxTakeBps:2.5, guard:function(){ return {}; } };";
// Allowlist enforcement (the "all paths" decision) exercised on the CONSTRUCTOR path: each
// constructor emits an ISSUE (needs no balance, so a denial is attributable SOLELY to the
// allowlist, not a secondary failure). NEG permits only SEND → its constructor's ISSUE must be
// denied → the deploy is rejected and token CTORNEG is never created. POS permits ISSUE → its
// constructor's ISSUE goes through → the deploy is valid and token CTORPOS exists. Together they
// prove the allowlist discriminates against a LIVE-persisted manifest (a balance-based guard
// emission would pass even with the allowlist disabled — the e2e E2 false-green this avoids).
// A COMPLETE, valid ISSUE emission — so when the allowlist permits it the token is really
// created (a bare {tick} ISSUE is rejected for missing fields, which would make the negative
// case a false green of its own).
const issueEmit = t => `xchain.emit.issue({tick:'${t}', maxSupply:'1000', maxMint:'1000', decimals:'0', mintSupply:'1000', memo:'x'});`;
const CTOR_NEG = `module.exports={ permissions:['SEND'],  initialize:function(){ ${issueEmit('CTORNEG')} } };`;
const CTOR_POS = `module.exports={ permissions:['ISSUE'], initialize:function(){ ${issueEmit('CTORPOS')} } };`;

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
            { source: DEPLOYER, data: `DEPLOY|0|${b64(MANIFEST_C)}|300000|` },
            { source: DEPLOYER, data: `DEPLOY|0|${b64(BARE_C)}|300000|` },
            { source: DEPLOYER, data: `DEPLOY|0|${b64(BAD_C)}|300000|` },
            // Non-empty CONSTRUCTOR_PARAMS so the VM runs `initialize` (the constructor emission path).
            { source: DEPLOYER, data: `DEPLOY|0|${b64(CTOR_NEG)}|500000|init` },
            { source: DEPLOYER, data: `DEPLOY|0|${b64(CTOR_POS)}|500000|init` },
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

    // A real token exists only if the ISSUE actually committed (the `tokens` table — NOT
    // index_tickers, whose INSERT IGNORE / non-rewinding ids survive a rolled-back emission).
    async function tokenExists(tick) {
        const rows = await indexerQuery(
            `SELECT COUNT(*) AS c FROM tokens tk JOIN index_tickers it ON it.id = tk.tick_id WHERE it.tick = ?`,
            [tick]);
        return Number(rows[0].c) > 0;
    }

    // All recorded contract-execution error messages (constructor runs recorded here even when
    // the deploy was rolled back). The allowlist denial surfaces as 'manifest: action <X> not
    // permitted'; an emission that PASSED the allowlist fails later with a different message.
    async function execErrors() {
        const rows = await indexerQuery(`SELECT error_message FROM contract_executions`, []);
        return rows.map(r => r.error_message || '');
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

    it('ENFORCES the allowlist: a DISALLOWED constructor emission is denied by the manifest', async function () {
        // CTOR_NEG permits only SEND but its constructor emits ISSUE. The allowlist check in
        // processEmission throws BEFORE the action runs, failing the constructor → the deploy
        // is rolled back and CTORNEG never exists. The denial surfaces as the exact allowlist
        // error. (Regression: with the array-coercion bug the manifest read back as a non-array,
        // the allowlist was disabled, and this denial would NOT occur.)
        const errs = await execErrors();
        assert.ok(errs.some(e => /action ISSUE not permitted/.test(e)),
            'a constructor ISSUE was denied by the manifest allowlist; errors=' + JSON.stringify(errs));
        assert.strictEqual(await tokenExists('CTORNEG'), false, 'the disallowed ISSUE never applied');
    });

    it('ENFORCES the allowlist: a PERMITTED constructor emission passes the manifest gate', async function () {
        // CTOR_POS permits ISSUE, so its constructor ISSUE is NOT blocked by the allowlist — it
        // gets past the gate (and only then fails downstream on the issuance FEE the unfunded
        // contract address can't pay). The discriminating proof: exactly ONE 'not permitted'
        // denial exists across all deploys — the CTOR_NEG one — NOT the ISSUE-permitting CTOR_POS.
        const errs = await execErrors();
        const denied = errs.filter(e => /not permitted/.test(e));
        assert.strictEqual(denied.length, 1,
            'only the ISSUE-forbidding contract was denied by the allowlist, not the ISSUE-permitting one; denied=' + JSON.stringify(denied));
        assert.ok(errs.some(e => /CTORPOS/.test(e) || /insufficient funds/.test(e)),
            'the permitted ISSUE reached action processing (failed later on fee, not on the allowlist)');
    });
});
