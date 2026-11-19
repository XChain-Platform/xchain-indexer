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
const sinon = require('sinon');
const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

function makeSync(){
    const writes = [];
    const hubDb = {
        doQuery: sinon.stub().callsFake(async (sql, args) => {
            if(/^INSERT/.test(sql)) writes.push({ sql, args });
            return { affectedRows: 1 };
        }),
    };
    const sync = new HubDbSync(hubDb, { network: 'regtest' });
    sinon.stub(sync, 'refuseForeignChainRow').returns(false);
    sinon.stub(sync, 'refuseForeignNetworkRow').resolves(false);
    sinon.stub(sync, 'localColumns').resolves(new Set([
        'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source',
    ]));
    return { sync, writes };
}

function row(snapshotBlock){
    return {
        snapshot_block: snapshotBlock,
        capability: 'cross_chain',
        signing_pubkey: 'a'.repeat(64),
        amount: '1',
        source: 'source',
    };
}

describe('capability snapshot canonical height apply fence @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('does not issue a mirror write for a malformed height', async function () {
        const { sync, writes } = makeSync();
        assert.strictEqual(await sync.applyRow('capability_snapshots', row('2e5')), false);
        assert.deepStrictEqual(writes, []);
    });

    it('binds a canonical digit string as a number', async function () {
        const { sync, writes } = makeSync();
        await sync.applyRow('capability_snapshots', row('161790'));
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0].args[0], 161790);
        assert.strictEqual(typeof writes[0].args[0], 'number');
    });
});
