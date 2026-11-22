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
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const { requireWithFreshConfig } = require('../../../helpers/fresh_config.js');

const DB_PATH = require.resolve('../../../../src/db');
const DOTENV_PATH = require.resolve('dotenv');
const MIGRATE_PATH = require.resolve('../../../../src/db/migration/migrate.js');
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../src/sql/migrations');
const RealDatabase = require('../../../../src/db');

const files = () => fs.readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort();
const rawOf = (file) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
const sumOf = (file) => crypto.createHash('sha256').update(rawOf(file)).digest('hex');

describe('migrate status backdating preview @regression', function () {
    const saved = {};

    beforeEach(function () {
        for(const key of ['INDEXER_DB_HOST', 'INDEXER_DB_NAME', 'INDEXER_DB_USER', 'INDEXER_COIN', 'INDEXER_NETWORK']){
            saved[key] = process.env[key];
            process.env[key] = key === 'INDEXER_DB_HOST' ? 'db.test' : key === 'INDEXER_DB_NAME' ? 'indexer_test' :
                key === 'INDEXER_DB_USER' ? 'tester' : key === 'INDEXER_COIN' ? 'BTC' : 'regtest';
        }
        saved.argv = process.argv;
        saved.exitCode = process.exitCode;
        process.exitCode = undefined;
    });

    afterEach(function () {
        sinon.restore();
        process.argv = saved.argv;
        process.exitCode = saved.exitCode;
        for(const key of ['INDEXER_DB_HOST', 'INDEXER_DB_NAME', 'INDEXER_DB_USER', 'INDEXER_COIN', 'INDEXER_NETWORK']){
            if(saved[key] == null) delete process.env[key];
            else process.env[key] = saved[key];
        }
        delete require.cache[MIGRATE_PATH];
        delete require.cache[DB_PATH];
        delete require.cache[DOTENV_PATH];
    });

    it('prints BACKDATED and the refusal summary for a divergent pending auto file', async function () {
        const all = files();
        const target = all.filter(file => RealDatabase.prototype.migrationMode(rawOf(file)) === 'auto').slice(-1)[0];
        assert.ok(target, 'fixture needs a committed auto migration');
        const ledger = all.filter(file => file !== target).map(file => ({ name: file, checksum: sumOf(file), mode: 'auto', applied_at: 'x' }));
        ledger.push({ name: '2099-12-31-missing.sql', checksum: '0'.repeat(64), mode: 'auto', applied_at: 'x' });
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        class FakeDatabase {
            constructor() { this.pool = { end: async () => finish() }; }
            getConnection() { return Promise.resolve({ query: async () => ledger, release: async () => {} }); }
            migrationMode(raw) { return RealDatabase.prototype.migrationMode(raw); }
            static planLedgerRenames() { return []; }
        }
        const log = sinon.stub(console, 'log');
        sinon.stub(console, 'error');
        sinon.stub(process, 'exit');
        process.argv = ['node', 'migrate.js', '--status'];
        require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: FakeDatabase };
        require.cache[DOTENV_PATH] = { id: DOTENV_PATH, filename: DOTENV_PATH, loaded: true, exports: { config: () => ({ parsed: {} }) } };
        requireWithFreshConfig(MIGRATE_PATH, { keep: [DB_PATH] });
        await done;
        const output = log.getCalls().map(call => call.args.join(' ')).join('\n');
        assert.match(output, new RegExp('\\[BACKDATED, mode=auto\\] ' + target));
        assert.match(output, /will refuse until each BACKDATED file is renamed/);
        assert.strictEqual(process.exitCode, undefined);
    });
});
