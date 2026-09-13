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
 * Per-file schema isolation for the e2e and perf tiers.
 *
 * The integration tier already claims a schema pair per test FILE. The e2e and
 * perf tiers used to call createDatabases() with no argument, so every file in
 * a tier dropped and recreated the same two schemas: run two tiers on one venue
 * and each one's DROP DATABASE lands under the other's feet.
 *
 * Two things have to hold, and both are checked here without touching a
 * database:
 *   - every scenario in both tiers claims its own pair (passes __filename)
 *   - the explorer launcher resolves the schema names when it builds a config,
 *     not when it is required, so it follows the claim instead of freezing the
 *     unclaimed base names
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const dbConnection = require('../../integration/setup/db-connection');
const { buildTestConfigInfo } = require('../setup/explorer-launcher');

const TEST_ROOT = path.resolve(__dirname, '../..');
const SCENARIO_DIRS = [
    path.join(TEST_ROOT, 'e2e', 'scenarios'),
    path.join(TEST_ROOT, 'perf', 'scenarios')
];

/** Every *.test.js under the e2e and perf scenario trees. */
function scenarioFiles() {
    const files = [];
    for (const dir of SCENARIO_DIRS) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir).sort()) {
            if (name.endsWith('.test.js')) files.push(path.join(dir, name));
        }
    }
    return files;
}

/** The regtest database block the explorer launcher would hand XChainExplorer. */
async function launcherDbBlock() {
    const config = await buildTestConfigInfo().getConfig();
    return config.BTC.regtest.database;
}

describe('E2E: per-file schema isolation @regression @tier1', function () {
    this.timeout(20000);

    after(async function () {
        // Leave the module pointed at a deterministic claim; the tier's root
        // after hook drops whatever was handed out.
        await dbConnection.useFileDatabases(__filename);
    });

    it('every e2e and perf scenario claims its own schema pair', function () {
        const files = scenarioFiles();
        assert.ok(files.length >= 15,
            `expected the e2e+perf scenario trees to be populated, found ${files.length}`);

        const offenders = [];
        for (const file of files) {
            if (file === __filename) continue; // this checker only talks ABOUT the call
            const src = fs.readFileSync(file, 'utf8');
            if (!/\bcreateDatabases\s*\(/.test(src)) continue;
            // A call with an empty argument list takes the currently active
            // names, which in a tier means the shared base pair.
            if (/\bcreateDatabases\s*\(\s*\)/.test(src)) {
                offenders.push(path.relative(TEST_ROOT, file));
                continue;
            }
            if (!/\bcreateDatabases\s*\(\s*__filename\s*\)/.test(src)) {
                offenders.push(path.relative(TEST_ROOT, file));
            }
        }
        assert.deepStrictEqual(offenders, [],
            'these scenarios do not pass __filename to createDatabases(): ' + offenders.join(', '));
    });

    it('gives the same-numbered e2e and perf scenarios different schemas', function () {
        const e2eKey  = dbConnection.fileKey(path.join(TEST_ROOT, 'e2e', 'scenarios', '01-token-lifecycle.test.js'));
        const perfKey = dbConnection.fileKey(path.join(TEST_ROOT, 'perf', 'scenarios', '01-baseline-throughput.test.js'));
        assert.notStrictEqual(e2eKey, perfKey);
        assert.notStrictEqual(
            dbConnection.scopedDbName('xchain_test_indexer', e2eKey),
            dbConnection.scopedDbName('xchain_test_indexer', perfKey));
        assert.notStrictEqual(
            dbConnection.scopedDbName('xchain_test_decoder', e2eKey),
            dbConnection.scopedDbName('xchain_test_decoder', perfKey));
    });

    it('builds the explorer config from the ACTIVE schema names, not the require-time ones', async function () {
        const fileA = path.join(TEST_ROOT, 'e2e', 'scenarios', '__isolation_probe_a.test.js');
        const fileB = path.join(TEST_ROOT, 'e2e', 'scenarios', '__isolation_probe_b.test.js');

        await dbConnection.useFileDatabases(fileA);
        const dbA = await launcherDbBlock();
        assert.strictEqual(dbA.indexer.name, dbConnection.INDEXER_DB);
        assert.strictEqual(dbA.decoder.name, dbConnection.DECODER_DB);

        await dbConnection.useFileDatabases(fileB);
        const dbB = await launcherDbBlock();
        assert.strictEqual(dbB.indexer.name, dbConnection.INDEXER_DB);
        assert.strictEqual(dbB.decoder.name, dbConnection.DECODER_DB);

        // The claim actually moved, so a frozen require-time read would have
        // handed both configs the same pair.
        assert.notStrictEqual(dbA.indexer.name, dbB.indexer.name);
        assert.notStrictEqual(dbA.decoder.name, dbB.decoder.name);
    });
});
