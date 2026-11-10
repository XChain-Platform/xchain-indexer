// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const observability = require('../../../../../src/observability/index.js');

const SEEDED = 50000;                 // 100 chunks of 500
const PER_DELETE_MS = 6000;           // 100 chunks take 10 minutes of clock time
const TWO_MINUTES_MS = 2 * 60 * 1000;

function linesWith(stub, needle) {
    return stub.getCalls().filter(c => String(c.args[0]).includes(needle));
}

// A mirror holding SEEDED skipped rows below the hub floor, each DELETE costing
// PER_DELETE_MS of fake clock time. Set-backed so the fixture stays linear at this size.
function makeSlowMirror(clock) {
    const live = new Set();
    for (let i = 1; i <= SEEDED; i++) live.add(i);
    const doQuery = async (sql, args) => {
        if (/^SELECT id FROM price_snapshots WHERE status = 'skipped' AND round_number < \?/.test(sql))
            return Array.from(live, id => ({ id: id }));
        if (/^DELETE FROM price_snapshots WHERE id IN/.test(sql)) {
            clock.tick(PER_DELETE_MS);
            for (const id of args) live.delete(Number(id));
            return { affectedRows: args.length };
        }
        return [];
    };
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'testnet' });
    return { sync, live };
}

// A prior hub lineage can leave millions of skipped rows below the new hub's floor, and
// their delete runs inside the bootstrap for minutes. Until the mirror reports drained it
// must keep saying it is working, and the moment it opens the gated routes must be marked.
describe('HubDbSync price mirror: a long skipped-row delete stays observable @regression @tier2', function () {
    let clock = null;
    afterEach(function () {
        if (clock) { clock.restore(); clock = null; }
        sinon.restore();
    });

    it('logs delete progress at least every two minutes and the summary once', async function () {
        clock = sinon.useFakeTimers({ now: 1700000000000, toFake: ['Date'] });
        const { sync, live } = makeSlowMirror(clock);
        sync.bootstrapProgressMs = 15000;
        sync._bootstrapping = true;
        sync._bootstrapProgressTicks = 0;
        const stamps = [Date.now()];
        const info = sinon.stub(observability.getLogger(), 'info').callsFake(() => { stamps.push(Date.now()); });
        const warn = sinon.stub(observability.getLogger(), 'warn');

        await sync.reconcileForeignPriceRounds(new Set(), false, 154360, 0, 124726);
        stamps.push(Date.now());

        assert.strictEqual(live.size, 0, 'every below-floor skipped row is removed');
        assert.ok(linesWith(info, 'price_snapshots rows this hub does not hold').length > 0,
            'a ten-minute delete must log progress before it ends');
        for (let i = 1; i < stamps.length; i++) {
            assert.ok(stamps[i] - stamps[i - 1] <= TWO_MINUTES_MS,
                'no silent gap over two minutes: ' + JSON.stringify(stamps.map(s => s - stamps[0])));
        }
        assert.strictEqual(linesWith(warn, 'removed ' + SEEDED + ' skipped price_snapshots row(s)').length, 1,
            'the summary line still appears exactly once');
        assert.ok(sync._bootstrapProgressTicks >= SEEDED / 500,
            'each chunk counts as bootstrap progress for the stall detector');
    });

    it('stays silent for a delete that finishes inside one reporter interval', async function () {
        clock = sinon.useFakeTimers({ now: 1700000000000, toFake: ['Date'] });
        const sync = new HubDbSync({ doQuery: async (sql) =>
            (/^SELECT id FROM price_snapshots WHERE status = 'skipped'/.test(sql) ? [{ id: 1 }, { id: 2 }] : []) },
        { hubUrl: 'http://hub.test', network: 'testnet' });
        sync.bootstrapProgressMs = 15000;
        const info = sinon.stub(observability.getLogger(), 'info');
        sinon.stub(observability.getLogger(), 'warn');

        await sync.reconcileForeignPriceRounds(new Set(), false, 154360, 0, 124726);

        assert.strictEqual(linesWith(info, 'price_snapshots rows this hub does not hold').length, 0);
    });
});

describe('HubDbSync drain certification is logged @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('logs exactly one drain-complete line when the mirror certifies its drain', function () {
        const sync = new HubDbSync({ doQuery: async () => [] }, { hubUrl: 'http://hub.test', network: 'testnet' });
        sync._wsEpoch = 7;
        sinon.stub(sync, 'repageOwedTables').returns([]);
        sinon.stub(sync, 'noteHeights');
        sinon.stub(sync, 'advanceWatermark');
        const info = sinon.stub(observability.getLogger(), 'info');

        assert.strictEqual(sync.certifyFullDrain([5000, 5001], 7), true);
        assert.strictEqual(sync._bootstrapDrained, true);
        assert.strictEqual(linesWith(info, 'bootstrap drained').length, 1,
            'a finished drain must say so once: ' + JSON.stringify(info.args));
    });
});
