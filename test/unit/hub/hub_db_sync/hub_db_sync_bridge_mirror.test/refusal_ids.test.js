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

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

const POLICY_COLUMNS = ['id', 'snapshot_id', 'network', 'origin_chain', 'tick', 'policy_seq', 'status', 'btc_chain_id'];
const OURS    = 'a'.repeat(64);
const FOREIGN = 'f'.repeat(64);

function policyRow(snapshotId, fields) {
    return Object.assign({ id: 7, snapshot_id: snapshotId, network: 'regtest', origin_chain: 'BTC', tick: 'FORG',
        policy_seq: 1, status: 'finalized', btc_chain_id: OURS }, fields || {});
}

// A HubDbSync for a regtest DOGE mirror over a fake hub DB that records every statement.
function makeSync(opts) {
    opts = opts || {};
    const seen = { sql: [] };
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        seen.sql.push({ sql: sql, args: args });
        if (/^DELETE FROM /.test(sql)) return { affectedRows: opts.deleted || 0 };
        if (/^SELECT snapshot_id AS id FROM policy_snapshots WHERE network <> \?/.test(sql)) return opts.foreignIds || [];
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'regtest', coin: 'DOGE' });
    sinon.stub(sync, 'localColumns').resolves(new Set(POLICY_COLUMNS));
    sync._expectedBtcChainId = OURS;
    return { sync, seen };
}

function lines(warn) {
    return warn.getCalls().map((c) => c.args.map(String).join(' '));
}

function inserts(seen) {
    return seen.sql.filter((s) => /^INSERT/.test(s.sql));
}

// A settlement screen and an acceptance journal both name a policy snapshot by snapshot_id,
// and the mirror layer refuses foreign rows before either can see them. Each refusal line
// must therefore name the rows it refused, or a refused forgery cannot be traced at all.
describe('HubDbSync mirror refusals name the refused row @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('names the snapshot_id of a policy row refused for a foreign btc_chain_id', async function () {
        const { sync, seen } = makeSync();
        const warn = sinon.stub(console, 'warn');
        const applied = await sync.applyRow('policy_snapshots', policyRow('snapFORGC01', { btc_chain_id: FOREIGN }));
        sync.reportRefusedChainRows('policy_snapshots');
        assert.strictEqual(applied, false);
        assert.strictEqual(inserts(seen).length, 0, 'a refused row must never reach the database');
        const refusal = lines(warn).filter((l) => l.includes('snapFORGC01'));
        assert.deepStrictEqual(refusal, ['HubDbSync: refused 1 policy_snapshots row(s) carrying btc_chain_id ' + FOREIGN +
            ' (this chain is ' + OURS + ') (snapshot_id snapFORGC01)']);
    });

    it('refuses a policy row served for another network at apply and names its snapshot_id once', async function () {
        const { sync, seen } = makeSync();
        const warn = sinon.stub(console, 'warn');
        const applied = await sync.applyRow('policy_snapshots', policyRow('snapFORGN01', { network: 'testnet' }));
        sync.reportRefusedChainRows('policy_snapshots');
        sync.reportRefusedChainRows('policy_snapshots');
        assert.strictEqual(applied, false);
        assert.strictEqual(inserts(seen).length, 0, 'a foreign-network row must never reach the database');
        assert.deepStrictEqual(lines(warn).filter((l) => l.includes('snapFORGN01')),
            ['HubDbSync: refused 1 policy_snapshots row(s) served for network testnet (this mirror serves regtest) ' +
             '(snapshot_id snapFORGN01)']);
    });

    it('applies a same-network row and leaves the unscoped display mirror alone', async function () {
        const { sync, seen } = makeSync();
        sinon.stub(console, 'warn');
        await sync.applyRow('policy_snapshots', policyRow('snapOK01'));
        assert.strictEqual(inserts(seen).length, 1, 'a row for this network applies');
        sync.network = null;
        await sync.applyRow('policy_snapshots', policyRow('snapOTHER01', { network: 'testnet' }));
        assert.strictEqual(inserts(seen).length, 2, 'a mirror with no network scope applies every row as before');
    });

    it('caps the named ids at ten and says there were more', async function () {
        const { sync } = makeSync();
        const warn = sinon.stub(console, 'warn');
        for (let i = 0; i < 12; i++) await sync.applyRow('policy_snapshots', policyRow('snap' + i, { network: 'testnet' }));
        sync.reportRefusedChainRows('policy_snapshots');
        const line = lines(warn).find((l) => /refused 12 policy_snapshots row/.test(l));
        assert.ok(line, 'one line reports all twelve');
        assert.ok(line.endsWith('(snapshot_id snap0, snap1, snap2, snap3, snap4, snap5, snap6, snap7, snap8, snap9, ...)'), line);
    });

    it('names the snapshot_ids a foreign-network purge removes', async function () {
        const { sync } = makeSync({ deleted: 2, foreignIds: [{ id: 'snapP1' }, { id: 'snapP2' }] });
        const warn = sinon.stub(console, 'warn');
        const removed = await sync.purgeForeignNetworkRows('policy_snapshots', 'regtest');
        assert.strictEqual(removed, 2);
        const line = lines(warn).find((l) => /removed 2 row\(s\) from policy_snapshots/.test(l));
        assert.ok(line && line.endsWith('(snapshot_id snapP1, snapP2)'), String(line));
    });
});
