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

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');

const Broadcast = require('../../../../../src/actions/broadcast.js');
const Database = require('../../../../../src/db');

const LONG_FEE = '0.1234567890';
const MAX_FEE = '0.123456789';

function buildHandler(gateEnabled){
    const indexer = createMockIndexer();
    indexer.protocolChanges.isEnabled = sinon.stub().callsFake(async name =>
        name === 'BROADCAST_FEE_LENGTH' && gateEnabled
    );
    indexer.indexerDb.config = indexer.config;
    indexer.indexerDb.util = indexer.util;
    indexer.indexerDb.normalizeDataValues = Database.prototype.normalizeDataValues;
    indexer.indexerDb.createBroadcast = Database.prototype.createBroadcast;

    const handler = new Broadcast({
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
    });
    return { handler, indexer };
}

async function parseBroadcast(gateEnabled, format, params){
    const { handler, indexer } = buildHandler(gateEnabled);
    const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: format });
    await handler.parse(params, data, null);
    return { data, indexer };
}

describe('BROADCAST FEE length gate @regression @tier1', function () {
    it('keeps a legacy 12-character FEE valid and stores its first 11 characters', async function () {
        const { data, indexer } = await parseBroadcast(false, 1,
            ['1', 'BTC-USD', '50000', LONG_FEE, 'legacy']);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.doQuery.callCount, 2);
        assert.strictEqual(indexer.indexerDb.doQuery.secondCall.args[1][2], MAX_FEE);
    });

    it('rejects a 12-character FEE when active', async function () {
        const { data } = await parseBroadcast(true, 1,
            ['1', 'BTC-USD', '50000', LONG_FEE, 'active']);

        assert.strictEqual(data['STATUS'], 'invalid: FEE (length)');
    });

    it('accepts an 11-character FEE when active without reading the gate', async function () {
        const { data, indexer } = await parseBroadcast(true, 1,
            ['1', 'BTC-USD', '50000', MAX_FEE, 'bounded']);

        assert.strictEqual(data['STATUS'], 'valid');
        sinon.assert.notCalled(indexer.protocolChanges.isEnabled);
    });

    for(const action of [
        { format: 0, params: ['0', 'message', '2'] },
        { format: 3, params: ['3', '1234', '2', 'result'] },
    ]){
        it(`leaves format ${action.format} without FEE unaffected when active`, async function () {
            const { data, indexer } = await parseBroadcast(true, action.format, action.params);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['FEE'], null);
            sinon.assert.notCalled(indexer.protocolChanges.isEnabled);
        });
    }

    it('matches MAX_BROADCAST_FEE_LENGTH to the broadcasts.fee column width', function () {
        const { indexer } = buildHandler(false);
        const sqlPath = path.join(__dirname, '../../../../../src/sql/broadcasts.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        const match = sql.match(/\bfee\s+VARCHAR\((\d+)\)/i);

        assert.ok(match, 'broadcasts.fee VARCHAR width must be declared');
        assert.strictEqual(indexer.config['MAX_BROADCAST_FEE_LENGTH'], 11);
        assert.strictEqual(indexer.config['MAX_BROADCAST_FEE_LENGTH'], Number(match[1]));
    });
});
