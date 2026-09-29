// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

// The hub-mirror fences refuse a row before any settlement screen can see it, so the
// mirror's own log line is the only record that the row was refused. Policy AT4 on the
// bridge rail (L014-9-la, 2026-09-29) forged a policy_snapshots row with a foreign
// network and one with a foreign btc_chain_id: both were kept out of the ledger, but the
// only lines logged named a count and a chain id, never the snapshot, so nobody could say
// WHICH row was refused. And the foreign-network row was not refused at all on arrival:
// it was mirrored, and deleted only by the purge at the next bootstrap.

const assert = require('assert');
const sinon  = require('sinon');

const observability = require('../../../../../src/observability/index.js');
const HubDbSync     = require('../../../../../src/hub/hub_db_sync.js');

const OURS    = '0'.repeat(63) + '1';
const FOREIGN = 'f'.repeat(64);

function snapshotId(n) {
    return (String(n).padStart(4, '0') + 'ab').repeat(11).slice(0, 64);
}

function makeSync(opts) {
    const o = opts || {};
    const doQuery = sinon.stub().callsFake(async (sql) => {
        if (/^SELECT snapshot_id AS name FROM policy_snapshots WHERE network <> \?/.test(sql))
            return (o.foreignIds || []).map((id) => ({ name: id }));
        if (/^DELETE FROM /.test(sql)) return { affectedRows: (o.foreignIds || []).length };
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'regtest' });
    sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'snapshot_id', 'network', 'btc_chain_id', 'tick']));
    sync._expectedBtcChainId = OURS;
    return { sync, doQuery };
}

function linesNaming(warn, id) {
    return warn.getCalls().map((c) => c.args.map(String).join(' '))
        .filter((line) => line.includes('XPOLICY') && line.includes(id.slice(0, 16)));
}

function insertCount(doQuery) {
    return doQuery.getCalls().filter((c) => /^INSERT/.test(String(c.args[0]))).length;
}

function registerNetworkFenceTests() {
    it('refuses a foreign-network row on arrival and names its snapshot_id once, under XPOLICY', async function () {
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const { sync, doQuery } = makeSync();
        const row = { id: 7, snapshot_id: snapshotId(1), network: 'testnet', btc_chain_id: OURS, tick: 'FORGN' };

        assert.strictEqual(await sync.applyRow('policy_snapshots', row), false, 'a foreign-network row must not apply');
        assert.strictEqual(insertCount(doQuery), 0, 'nothing may be written for a refused row');
        sync.reportRefusedNetworkRows('policy_snapshots');
        assert.strictEqual(linesNaming(warn, row.snapshot_id).length, 1, JSON.stringify(warn.args));

        // The next bootstrap is served the same row again: it is refused again but not re-named.
        assert.strictEqual(await sync.applyRow('policy_snapshots', row), false);
        sync.reportRefusedNetworkRows('policy_snapshots');
        assert.strictEqual(linesNaming(warn, row.snapshot_id).length, 1, 'a re-refused id is named once per process');
    });

    it('leaves a same-network row and a row with no network alone', async function () {
        const { sync } = makeSync();
        assert.strictEqual(await sync.refuseForeignNetworkRow('policy_snapshots', { network: 'regtest' }), false);
        assert.strictEqual(await sync.refuseForeignNetworkRow('policy_snapshots', { network: null }), false);
        assert.strictEqual(await sync.refuseForeignNetworkRow('policy_snapshots', {}), false);
    });

    it('a mirror with no proven network (the explorer display mirror) refuses nothing', async function () {
        const { sync } = makeSync();
        sync.network = undefined;
        assert.strictEqual(await sync.refuseForeignNetworkRow('policy_snapshots', { network: 'testnet' }), false);
    });
}

function registerChainFenceTests() {
    it('names the snapshot_id of a refused foreign-chain row under XPOLICY, once', function () {
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const { sync } = makeSync();
        const row = { snapshot_id: snapshotId(2), network: 'regtest', btc_chain_id: FOREIGN };

        assert.strictEqual(sync.refuseForeignChainRow('policy_snapshots', row), true);
        sync.reportRefusedChainRows('policy_snapshots');
        assert.strictEqual(linesNaming(warn, row.snapshot_id).length, 1, JSON.stringify(warn.args));
        const line = linesNaming(warn, row.snapshot_id)[0];
        assert.ok(line.includes('btc_chain_id ' + FOREIGN), 'the chain id stays on the line: ' + line);

        sync.refuseForeignChainRow('policy_snapshots', row);
        sync.reportRefusedChainRows('policy_snapshots');
        assert.strictEqual(linesNaming(warn, row.snapshot_id).length, 1, 'a re-refused id is named once per process');
    });
}

function registerPurgeTests() {
    it('the foreign-network purge names up to ten snapshot_ids and counts the rest', async function () {
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const ids = Array.from({ length: 12 }, (_, i) => snapshotId(10 + i));
        const { sync } = makeSync({ foreignIds: ids });

        assert.strictEqual(await sync.purgeForeignNetworkRows('policy_snapshots', 'regtest'), 12);
        const lines = warn.getCalls().map((c) => c.args.map(String).join(' ')).filter((l) => l.includes('removed 12 row(s)'));
        assert.strictEqual(lines.length, 1, JSON.stringify(warn.args));
        for (const id of ids.slice(0, 10)) assert.ok(lines[0].includes(id), 'missing ' + id + ': ' + lines[0]);
        for (const id of ids.slice(10)) assert.ok(!lines[0].includes(id), 'more than ten named: ' + lines[0]);
        assert.ok(lines[0].includes('XPOLICY') && lines[0].includes('2 more'), lines[0]);
    });
}

describe('HubDbSync refused-row names @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    registerNetworkFenceTests();

    registerChainFenceTests();

    registerPurgeTests();
});
