// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const observability = require('../../../../../src/observability/index.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub/hub_schema_version');

// Regression: an indexer that mirrors remote_token_snapshots against a hub image without
// that route got HTTP 200 and a JSON-RPC error body, refused the rowless page silently, and
// ended every bootstrap "partial" without naming the table.

// What an old hub sends for a snapshot route it does not have.
const JSON_RPC_ERROR_BODY = { error: { code: -32600, message: 'Invalid Request, wrong version - undefined' }, id: null };

function makeSync() {
    const doQuery = sinon.stub().resolves([{ max_id: null }]);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', pollInterval: 50 });
    sync.running = true;
    sinon.stub(sync, 'applyRow').resolves();
    sinon.stub(sync, 'localColumns').resolves(new Set(['id']));
    sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
    return sync;
}

function linesNaming(warn, needle) {
    return warn.getCalls().map(c => c.args.map(String).join(' ')).filter(line => line.includes(needle));
}

describe('HubDbSync rowless snapshot page @regression @tier2', function () {
    let clock;

    afterEach(function () {
        if (clock) clock.restore();
        clock = null;
        sinon.restore();
    });

    it('names the table and what the hub sent when a snapshot page carries no rows array', async function () {
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const sync = makeSync();
        sinon.stub(sync, 'httpGet').resolves(JSON_RPC_ERROR_BODY);

        assert.strictEqual(await sync.bootstrapTable('remote_token_snapshots'), null,
            'a page without rows must still leave the table not drained');
        const lines = linesNaming(warn, 'remote_token_snapshots');
        assert.ok(lines.some(line => line.includes('Invalid Request')),
            'the refusal must name the table and the hub error: ' + JSON.stringify(warn.args));
    });

    it('names a null hub reply too', async function () {
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const sync = makeSync();
        sinon.stub(sync, 'httpGet').resolves(null);

        assert.strictEqual(await sync.bootstrapTable('state_checkpoints'), null);
        assert.strictEqual(linesNaming(warn, 'state_checkpoints').length, 1, JSON.stringify(warn.args));
    });

    it('the partial-bootstrap retry line names every table that did not drain', async function () {
        clock = sinon.useFakeTimers();
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const sync = makeSync();
        sinon.stub(sync, 'bootstrapTable').callsFake(async table =>
            (table === 'remote_token_snapshots' ? null : 7));

        await sync.bootstrapAll();

        assert.strictEqual(sync._bootstrapDrained, false, 'one undrained table keeps the gate shut');
        const partial = linesNaming(warn, 'bootstrap partial');
        assert.strictEqual(partial.length, 1, JSON.stringify(warn.args));
        assert.ok(partial[0].includes('remote_token_snapshots'),
            'the retry line must say which table held the gate: ' + partial[0]);
        assert.ok(!partial[0].includes('price_snapshots'), 'a drained table must not be named: ' + partial[0]);
    });

    it('a well-formed page still drains unchanged', async function () {
        const sync = makeSync();
        sinon.stub(sync, 'httpGet').resolves({ schema_version: HUB_SCHEMA_VERSION, rows: [{ id: 1 }], watermark: 9 });
        assert.strictEqual(await sync.bootstrapTable('remote_token_snapshots'), 9);
    });
});
