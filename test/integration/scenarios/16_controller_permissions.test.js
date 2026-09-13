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
 * Integration: Phase E permissions manifest (deploy persistence).
 *
 * Drives real DEPLOY actions through the full indexer pipeline (decoder seed →
 * processBlocks) against a real MariaDB + the real (isolated-vm) VM. Verifies the
 * deploy → vm.readManifest → validate → db.createContractPermission wiring end to
 * end:
 *   - a declared manifest persists permissions + maxTakeBps to contract_permissions
 *   - a bare contract stores NO manifest row (unrestricted default)
 *   - a malformed manifest REJECTS the deploy (CONTRACT_MANIFEST) and stores no row
 *   - CONTRACT_META_REQUIRED (regtest-armed at genesis): a nameless contract is
 *     REJECTED with the meta-required string, a conforming `meta` lands in the four
 *     meta columns, and a contract malformed on maxTakeBps AND nameless still reports
 *     the maxTakeBps string (verdict precedence)
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
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');

const DEPLOYER = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // valid regtest P2PKH
const T0  = 1700000000;
// Inline DEPLOY CODE_ENCODING is base64 at/after DEPLOY_BASE64_CODE, which regtest
// activates at genesis (protocol_changes.js), so encode the fixture source as canonical
// base64 to match the indexer's decode path (deploy.js round-trips to reject non-canonical).
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// CONTRACT_META_REQUIRED is genesis-active on regtest, so every fixture below that
// must reach a NON-meta verdict carries `meta` as the first export key (spec 2.1).
// The two deliberate exceptions are named at their definitions.
const META_A = "meta:{ name:'Manifest A', description:'Permissions-manifest fixture.', version:'1.0.0' }";
const MANIFEST_C = `module.exports={ ${META_A}, permissions:['SEND','ISSUE'], maxTakeBps:300, guard:function(){ return {}; } };`;
// "Bare" means bare of a PERMISSIONS manifest (the unrestricted default), which is
// what this fixture tests; it carries meta like any deployable contract.
const BARE_C     = "module.exports={ meta:{ name:'Bare', description:'No permissions manifest at all.', version:'1.0.0' }, guard:function(){ return {}; } };";
// Deliberately nameless AND malformed on maxTakeBps: the meta verdict is evaluated
// after the permissions/maxTakeBps branches and only under !error, so this contract
// must keep reporting today's maxTakeBps string. That precedence is consensus
// (spec 2.3, D34/D35) and this is its integration-tier vector.
const BAD_C      = "module.exports={ permissions:['SEND'], maxTakeBps:2.5, guard:function(){ return {}; } };";
// Well-formed on every earlier axis and nameless: the one contract here whose
// rejection is the meta rule itself.
const NAMELESS_C = "module.exports={ permissions:['SEND'], maxTakeBps:300, guard:function(){ return {}; } };";
// Allowlist enforcement (the "all paths" decision) exercised on the CONSTRUCTOR path: each
// constructor emits an ISSUE (needs no balance, so a denial is attributable SOLELY to the
// allowlist, not a secondary failure). NEG permits only SEND → its constructor's ISSUE must be
// denied → the deploy is rejected and token CTORNEG is never created. POS permits ISSUE → its
// constructor's ISSUE goes through → the deploy is valid and token CTORPOS exists. Together they
// prove the allowlist discriminates against a LIVE-persisted manifest (a balance-based guard
// emission would pass even with the allowlist disabled (the e2e E2 false-green this avoids).
// A COMPLETE, valid ISSUE emission: when the allowlist permits it the token is really
// created (a bare {tick} ISSUE is rejected for missing fields, which would make the negative
// case a false green of its own).
const issueEmit = t => `xchain.emit.issue({tick:'${t}', maxSupply:'1000', maxMint:'1000', decimals:'0', mintSupply:'1000', memo:'x'});`;
const CTOR_NEG = `module.exports={ meta:{ name:'Ctor Neg', description:'Constructor emits an ISSUE its allowlist forbids.', version:'1.0.0' }, permissions:['SEND'],  initialize:function(){ ${issueEmit('CTORNEG')} } };`;
const CTOR_POS = `module.exports={ meta:{ name:'Ctor Pos', description:'Constructor emits an ISSUE its allowlist permits.', version:'1.0.0' }, permissions:['ISSUE'], initialize:function(){ ${issueEmit('CTORPOS')} } };`;

describe('Phase E permissions manifest: deploy persistence (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    let seeder, indexer;

    before(async function () {
        // This scenario drives real contract DEPLOY/EXECUTE, which needs the
        // isolated-vm-backed xchain-vm. The integration tier is provisioned
        // without a VM (EXECUTE paths are e2e-suite territory), so skip the whole
        // suite when xchain-vm can't be loaded rather than failing.
        try { require('xchain-vm'); } catch (e) { return this.skip(); }
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases(__filename);
        await createDecoderSchema();
        seeder = new DecoderSeeder(decoderQuery);
        await seedGas(seeder, { addresses: [DEPLOYER], amount: '100' });
        await seeder.seedBlock(100, T0, [
            { source: DEPLOYER, data: `DEPLOY|0|${b64(MANIFEST_C)}|300000|` },
            { source: DEPLOYER, data: `DEPLOY|0|${b64(BARE_C)}|300000|` },
            { source: DEPLOYER, data: `DEPLOY|0|${b64(BAD_C)}|300000|` },
            { source: DEPLOYER, data: `DEPLOY|0|${b64(NAMELESS_C)}|300000|` },
            // Non-empty CONSTRUCTOR_PARAMS so the VM runs `initialize` (the constructor emission path).
            { source: DEPLOYER, data: `DEPLOY|0|${b64(CTOR_NEG)}|500000|init` },
            { source: DEPLOYER, data: `DEPLOY|0|${b64(CTOR_POS)}|500000|init` },
        ]);
        indexer = await initIndexer();
        await processBlocks(indexer);
    });

    after(async function () {
        if (indexer) await destroyIndexer(indexer);
        await destroyFileIndexers(__filename);
        await closeAll();
    });

    async function rowFor(code) {
        const h = sha(code);
        const rows = await indexerQuery(
            `SELECT c.action_index, c.code_hash, s.status AS status,
                    c.meta_name, c.meta_description, c.meta_version, c.meta_json,
                    cp.permissions AS permissions, cp.max_take_bps AS max_take_bps
             FROM contracts c
             LEFT JOIN index_statuses s ON s.id = c.status_id
             LEFT JOIN contract_permissions cp ON cp.contract_index = c.action_index`, []);
        return rows.find(r => r.code_hash === h);
    }

    // A real token exists only if the ISSUE actually committed. Check the `tokens` table, NOT
    // index_tickers, whose INSERT IGNORE / non-rewinding ids survive a rolled-back emission.
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
        // The meta the same manifest read extracted lands in its own columns on the
        // contracts row (spec 2.5: written only for a valid deploy whose meta conforms).
        assert.strictEqual(row.meta_name,        'Manifest A');
        assert.strictEqual(row.meta_description, 'Permissions-manifest fixture.');
        assert.strictEqual(row.meta_version,     '1.0.0');
        assert.deepStrictEqual(JSON.parse(row.meta_json),
            { name: 'Manifest A', description: 'Permissions-manifest fixture.', version: '1.0.0' },
            'meta_json holds the isolate bytes verbatim');
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
        // BAD_C is malformed on maxTakeBps AND nameless. The maxTakeBps branch runs
        // first and the meta verdict is assigned only under !error, so the earlier
        // string must win: this is the verdict-precedence vector, and asserting the
        // exact string is what makes it one (a /CONTRACT_MANIFEST/ regex passes for
        // the meta string too, which would hide exactly the regression it guards).
        assert.strictEqual(row.status, 'invalid: CONTRACT_MANIFEST (maxTakeBps must be an integer in [0, 10000])',
            'the earlier verdict wins over the meta verdict, got: ' + row.status);
        assert.strictEqual(row.permissions, null, 'no contract_permissions row for a rejected deploy');
        assert.strictEqual(row.meta_name, null, 'a rejected deploy stores no meta columns');
    });

    it('a NAMELESS contract is rejected by CONTRACT_META_REQUIRED and stores no permissions or meta', async function () {
        // Regtest arms CONTRACT_META_REQUIRED at genesis, so a contract that is
        // well-formed on every earlier axis and simply exports no `meta` is refused
        // at consensus. Its permissions manifest is valid and still must NOT persist:
        // createContractPermission is gated on a clean status.
        const row = await rowFor(NAMELESS_C);
        assert.ok(row, 'nameless contract row exists with its (invalid) status');
        assert.strictEqual(row.status, 'invalid: CONTRACT_MANIFEST (meta required)',
            'a nameless deploy is refused with the meta-required string, got: ' + row.status);
        assert.strictEqual(row.permissions, null,
            'no contract_permissions row for a meta-rejected deploy');
        assert.strictEqual(row.meta_name,        null);
        assert.strictEqual(row.meta_description, null);
        assert.strictEqual(row.meta_version,     null);
        assert.strictEqual(row.meta_json,        null);
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
        // CTOR_POS permits ISSUE, so its constructor ISSUE is NOT blocked by the allowlist.
        // The discriminating proof: exactly ONE 'not permitted' denial exists across all
        // deploys: the CTOR_NEG one, not the ISSUE-permitting CTOR_POS.
        const errs = await execErrors();
        const denied = errs.filter(e => /not permitted/.test(e));
        assert.strictEqual(denied.length, 1,
            'only the ISSUE-forbidding contract was denied by the allowlist, not the ISSUE-permitting one; denied=' + JSON.stringify(denied));
        // The permitted emission is asserted by its EFFECT: token CTORPOS really exists.
        // This assertion used to look for a downstream FAILURE instead ('...failed later on
        // the issuance FEE the unfunded contract address can't pay'), which stopped being
        // true once ISSUANCE_FEE_EMISSION_EXEMPT activated: a VM-emitted ISSUE is fee-exempt
        // by design (issue.js, the deployer already paid DEPLOY gas), so the permitted ISSUE
        // now commits outright. Asserting the token exists is the stronger check anyway,
        // and it is the exact mirror of the CTORNEG case above.
        assert.strictEqual(await tokenExists('CTORPOS'), true,
            'the permitted ISSUE passed the allowlist and applied; execution errors=' + JSON.stringify(errs));
        // And nothing about CTOR_POS failed at all: its deploy committed.
        const row = await rowFor(CTOR_POS);
        assert.ok(row, 'the ISSUE-permitting contract was deployed');
        assert.strictEqual(row.status, 'valid',
            'the ISSUE-permitting deploy is valid (its constructor emission succeeded), got: ' + row.status);
    });
});
