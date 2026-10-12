// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const path = require('path');

const Database = require('../../../../../src/db/index.js');
const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const { requireWithFreshConfig } = require('../../../../helpers/fresh_config.js');

const SRC = path.resolve(__dirname, '../../../../../src');
const STARTUP = path.join(SRC, 'XChainIndexer', 'startup.js');
const DB_ENTRY = require.resolve(path.join(SRC, 'db', 'index.js'));
const SYNC_ENTRY = require.resolve(path.join(SRC, 'hub', 'hub_db_sync.js'));

// A real Database whose open transaction holds `dirty` (a rollback's uncommitted bump; null
// for no open transaction) while the pool, which sees only committed rows, holds `committed`
// or fails with it.
function rollbackInFlight(dirty, committed) {
    const db = Object.create(Database.prototype);
    db.util = {
        isNull: (v) => v === null || v === undefined,
        logError() {},
        throwError(msg) { throw new Error(msg); }
    };
    db.transactionConnection = (dirty === null) ? null
        : { query: async () => [{ generation: dirty }], release: async () => {} };
    db.pool = {
        getConnection: async () => ({
            query: async () => {
                if (committed instanceof Error) throw committed;
                return [{ generation: committed }];
            },
            release: async () => {}
        })
    };
    return db;
}

// The options connectHubDatabase() hands HubDbSync, built by the real startup code with
// the database and mirror constructors swapped for recorders.
function wiredMirrorOptions(indexerDb) {
    require(STARTUP);
    let captured = null;
    class RecordingSync { constructor(hubDb, options) { captured = options; } }
    class InertDatabase {}
    const saved = [[DB_ENTRY, require.cache[DB_ENTRY]], [SYNC_ENTRY, require.cache[SYNC_ENTRY]]];
    const savedEnv = process.env.HUB_DB_SYNC_ENABLED;
    require.cache[DB_ENTRY] = { id: DB_ENTRY, filename: DB_ENTRY, loaded: true, exports: InertDatabase };
    require.cache[SYNC_ENTRY] = { id: SYNC_ENTRY, filename: SYNC_ENTRY, loaded: true, exports: RecordingSync };
    process.env.HUB_DB_SYNC_ENABLED = 'true';
    try {
        const startup = requireWithFreshConfig(STARTUP);
        startup.connectHubDatabase.call({ config: { COIN: 'BTC', NETWORK: 'regtest' }, indexerDb: indexerDb });
    } finally {
        for (const [p, entry] of saved) {
            if (entry === undefined) delete require.cache[p];
            else require.cache[p] = entry;
        }
        if (savedEnv === undefined) delete process.env.HUB_DB_SYNC_ENABLED;
        else process.env.HUB_DB_SYNC_ENABLED = savedEnv;
    }
    assert.ok(captured, 'connectHubDatabase must build the mirror when HUB_DB_SYNC_ENABLED is true');
    return captured;
}

// A mirror guarded by the wired hook, recording every statement it sends.
function guardedMirror(getOwnRollbackGeneration) {
    const calls = [];
    const doQuery = async (sql, args) => { calls.push({ sql, args }); return []; };
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: 'BTC', getOwnRollbackGeneration });
    return { sync, deletes: () => calls.filter((c) => /^DELETE/.test(c.sql)) };
}

describe('HubDbSync own-chain generation hook as startup wires it @regression @tier1', function () {
    it('reads the committed generation, not the open rollback transaction\'s bump', async function () {
        const options = wiredMirrorOptions(rollbackInFlight(7, 6));
        assert.strictEqual(await options.getOwnRollbackGeneration(), 6);
    });

    it('refuses an own-chain retraction fenced at the uncommitted generation minus one', async function () {
        const options = wiredMirrorOptions(rollbackInFlight(7, 6));
        const { sync, deletes } = guardedMirror(options.getOwnRollbackGeneration);
        await sync.applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 6 });
        assert.strictEqual(deletes().length, 0, 'no committed rollback produced this fence yet');
        await sync.applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 5 });
        assert.strictEqual(deletes().length, 1, 'a fence below the committed generation still applies');
    });

    it('rejects on a failed read so the guard fails closed instead of reading 0', async function () {
        const options = wiredMirrorOptions(rollbackInFlight(null, new Error('pool down')));
        await assert.rejects(() => options.getOwnRollbackGeneration(), /pool down/);
        const { sync, deletes } = guardedMirror(options.getOwnRollbackGeneration);
        await sync.applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 0 });
        assert.strictEqual(deletes().length, 0);
    });
});
