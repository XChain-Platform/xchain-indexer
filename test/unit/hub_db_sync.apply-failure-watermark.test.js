// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Mirror writes must fail loudly, and a failed apply must stop the mirror certifying
// coverage it does not have.
//
// Two independent halves, both of which have to hold:
//   1. Db.doQuery SWALLOWS a non-transactional query error and returns its `[]` default,
//      so a mirror write that never landed looked exactly like one that did. Writes now
//      route through doQueryStrict where the connection exposes it; reads stay on
//      doQuery, where an empty result is a legitimate answer.
//   2. The socket handler's catch logs an apply failure and continues, so the next
//      heartbeat would advance the stream watermark over a row that was never written.
//      An apply failure latches, the watermark gate reads that latch, and only a clean
//      re-bootstrap drain clears it.

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');

// A sync with no socket and no real DB. hubDb carries both query primitives so the
// routing decision is observable; drop doQueryStrict to model the explorer's pool.
function makeSync(hubDb) {
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    sync.running = true;
    // The column filter and the chain-identity fence are not under test here.
    sync._localColumns      = async () => new Set(['network', 'policy_key', 'policy_value']);
    sync._cachedColumnType  = () => 'varchar(64)';
    sync._refuseForeignChainRow = () => false;
    return sync;
}

const ROW = { network: 'mainnet', policy_key: 'k', policy_value: 'v' };

describe('HubDbSync mirror-write confirmation and the apply-failure watermark latch @regression @tier1', function () {

    afterEach(function () { sinon.restore(); });

    describe('writes route through the fail-loud primitive', function () {

        it('sends an _applyRow write to doQueryStrict when the connection has one', async function () {
            const hubDb = { doQuery: sinon.stub().resolves([]), doQueryStrict: sinon.stub().resolves({ affectedRows: 1 }) };
            const sync  = makeSync(hubDb);

            await sync._applyRow('policy_snapshots', ROW);

            assert.strictEqual(hubDb.doQueryStrict.callCount, 1,
                'the INSERT must go through doQueryStrict; doQuery swallows the error that makes this a mirror hole');
            assert.ok(/INSERT IGNORE INTO policy_snapshots/.test(hubDb.doQueryStrict.firstCall.args[0]));
            assert.strictEqual(hubDb.doQuery.callCount, 0, 'no write may fall back to the swallowing primitive');
        });

        it('propagates a failed write instead of returning as though the row landed', async function () {
            // The pre-fix shape: doQuery resolves [] on a swallowed SQL error and _applyRow
            // resolved, so the caller believed the row was mirrored. With the write on the
            // strict primitive the rejection reaches the caller, which is what lets the
            // latch below ever be set.
            const boom  = new Error('ER_LOCK_DEADLOCK');
            const hubDb = { doQuery: sinon.stub().resolves([]), doQueryStrict: sinon.stub().rejects(boom) };
            const sync  = makeSync(hubDb);

            await assert.rejects(() => sync._applyRow('policy_snapshots', ROW), /ER_LOCK_DEADLOCK/);
        });

        it('still writes through doQuery when the connection exposes no strict primitive', async function () {
            // The vendored explorer copy reaches HubMirrorPool, which has doQuery only and
            // already lets a query error propagate. Absence must not become a TypeError.
            const hubDb = { doQuery: sinon.stub().resolves({ affectedRows: 1 }) };
            const sync  = makeSync(hubDb);

            await sync._applyRow('policy_snapshots', ROW);

            assert.strictEqual(hubDb.doQuery.callCount, 1);
        });

        it('leaves reads on doQuery, where an empty result is a real answer', async function () {
            const hubDb = { doQuery: sinon.stub().resolves([]), doQueryStrict: sinon.stub().resolves([]) };
            const sync  = makeSync(hubDb);

            const out = await sync._applyWrite('SELECT 1', []);
            assert.ok(hubDb.doQueryStrict.calledOnce, 'sanity: _applyWrite is the write path');
            assert.deepStrictEqual(out, []);

            // The read helpers this module uses for column probes call hubDb.doQuery
            // directly and are untouched by the write routing.
            hubDb.doQuery.resetHistory();
            await hubDb.doQuery('SHOW COLUMNS FROM policy_snapshots');
            assert.strictEqual(hubDb.doQuery.callCount, 1);
        });
    });

    describe('the watermark gate reads the apply-failure latch', function () {

        function drained() {
            const sync = makeSync({ doQuery: sinon.stub().resolves([]) });
            sync._bootstrapDrained = true;
            sync.streamWatermark   = 1000;
            return sync;
        }

        // One heartbeat, driven the way the socket handler drives it: the hub tip is noted
        // before the gate, then the frame goes through the gate.
        function heartbeat(sync, ts, heights) {
            sync._noteHubTip(ts);
            sync._handleWatermarkFrame({ ts, heights });
        }

        it('advances on a heartbeat while no apply has failed', function () {
            const sync = drained();
            heartbeat(sync, 2000);
            assert.strictEqual(sync.streamWatermark, 2000);
        });

        it('refuses to advance once an apply has failed', function () {
            const sync = drained();
            sync._applyFailureSeen = true;
            heartbeat(sync, 2000);
            assert.strictEqual(sync.streamWatermark, 1000,
                'a heartbeat after a failed apply certifies coverage over a row that was never written');
        });

        it('refuses to install the frame height map once an apply has failed', function () {
            const sync = drained();
            sync._applyFailureSeen = true;
            heartbeat(sync, 2000, { oracle_prices: { BTC: 42 } });
            assert.deepStrictEqual(sync.heightWatermarks || {}, {},
                'a height map certifies coverage exactly like the seconds watermark does');
        });

        it('still records the refused hub tip, so the stall detector can see the freeze', function () {
            const sync = drained();
            sync._applyFailureSeen = true;
            heartbeat(sync, 2000);
            assert.strictEqual(sync._hubTipTs, 2000);
        });

        it('advances again once the latch is cleared', function () {
            const sync = drained();
            sync._applyFailureSeen = true;
            heartbeat(sync, 2000);
            sync._applyFailureSeen = false;               // what a clean re-bootstrap drain does
            heartbeat(sync, 2000);
            assert.strictEqual(sync.streamWatermark, 2000);
        });
    });

    describe('a failed buffered price replay latches too', function () {

        it('keeps the failed event buffered, reports not-drained, and sets the latch', async function () {
            const sync = makeSync({ doQuery: sinon.stub().resolves([]) });
            sync._applyRow = sinon.stub().rejects(new Error('write failed'));
            sync._pendingPriceEvents = [{ type: 'row:inserted', row: { round_number: 7 } }];

            const drainedOk = await sync._flushPendingPriceEvents();

            assert.strictEqual(drainedOk, false);
            assert.strictEqual(sync._pendingPriceEvents.length, 1, 'the failed event must stay at the head');
            assert.strictEqual(sync._applyFailureSeen, true);
        });

        it('leaves the latch clear when every buffered event applies', async function () {
            const sync = makeSync({ doQuery: sinon.stub().resolves([]) });
            sync._applyRow = sinon.stub().resolves();
            sync._pendingPriceEvents = [{ type: 'row:inserted', row: { round_number: 7 } }];

            const drainedOk = await sync._flushPendingPriceEvents();

            assert.strictEqual(drainedOk, true);
            assert.strictEqual(sync._pendingPriceEvents.length, 0);
            assert.strictEqual(sync._applyFailureSeen, false);
        });
    });
});
