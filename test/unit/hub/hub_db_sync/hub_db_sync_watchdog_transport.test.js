// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ITEM 2477: the liveness stamp this._lastHeartbeatAt used to run ONLY inside the
// serialized _msgChain, behind awaited row applies, while the watchdog terminates
// the socket at idleMs >= watermarkTimeoutMs. A row-apply backlog longer than the
// timeout thus TERMINATED a healthy socket and forced a re-bootstrap (a self-
// reinforcing loop). The fix stamps _lastHeartbeatAt at frame ARRIVAL in the raw
// ws.on('message') handler, before enqueueing to _msgChain, so the watchdog measures
// TRANSPORT liveness, not processing. Watermark ADVANCEMENT stays serialized behind
// row applies (unchanged). Half-open detection (no frames => terminate) is intact.
//
// These tests drive the real ws.on('message') handler against an in-process ws
// server (no DB, no HTTP bootstrap) so the arrival-stamp wiring itself is exercised.

const assert = require('assert');
const sinon = require('sinon');
const ws = require('ws');
const WebSocketServer = ws.WebSocketServer || ws.Server;

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

// Shared poll-until / fixed-settle helpers. waitUntil() is for a case that
// asserts an event DID happen; a case asserting an event did NOT happen has
// nothing to poll and keeps its fixed sleep() settle.
const { sleep, waitUntil } = require('../../../helpers/wait.js');

let server, port, sync;

function makeSync() {
    const s = new HubDbSync({ doQuery: sinon.stub().resolves([]) },
        { hubUrl: 'http://127.0.0.1:' + port, watermarkIntervalMs: 50 }); // timeout = 150ms
    s.running = true;
    return s;
}

describe('HubDbSync watchdog measures transport not processing (ITEM 2477) @regression @tier2', function () {
    this.timeout(15000);

    beforeEach(async function () {
        server = new WebSocketServer({ port: 0 });
        port = await new Promise((res) => server.on('listening', () => res(server.address().port)));
    });

    afterEach(function () {
        if (sync) { sync.running = false; try { sync.stop(); } catch (e) { /* ignore */ } sync = null; }
        if (server) { try { server.close(); } catch (e) { /* ignore */ } server = null; }
    });

    it('a watermark frame arriving during a long row-apply backlog keeps the watchdog quiet', async function () {
        let serverWs;
        server.on('connection', (conn) => { serverWs = conn; conn.send(JSON.stringify({ type: 'ready' })); });

        sync = makeSync();
        // A slow row apply holds _msgChain busy far longer than the 150ms watchdog timeout.
        sinon.stub(sync, 'handleRowEvent').callsFake(() => sleep(600));

        await sync.connectWebSocket();                 // resolves on 'ready'
        const terminateSpy = sinon.spy(sync.ws, 'terminate');

        // Deliver a row frame -> enqueued to _msgChain -> handleRowEvent hangs 600ms.
        serverWs.send(JSON.stringify({ type: 'row:inserted', table: 'oracle_prices', row: { id: 1 } }));
        // Watermark frames keep arriving on the socket every 40ms; each must stamp
        // _lastHeartbeatAt at ARRIVAL even though the message chain is stuck on the apply.
        const hb = setInterval(() => {
            try { serverWs.send(JSON.stringify({ type: 'watermark', ts: Date.now() })); } catch (e) { /* closed */ }
        }, 40);

        await sleep(350);                               // > 2x the 150ms timeout, chain still stuck
        clearInterval(hb);

        assert.strictEqual(terminateSpy.called, false,
            'a healthy socket with frames arriving must NOT be terminated by a processing backlog');
    });
});

describe('HubDbSync anchor-stamp stream delivery @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('updates only an already-admitted match and has no insert fallback', async function () {
        const write = sinon.stub().resolves({ affectedRows: 1 });
        const s = new HubDbSync({ doQuery: write, doQueryStrict: write },
            { hubUrl: 'http://hub.test' });

        s.enqueueStreamFrame({
            type: 'row:anchor-stamped', table: 'cross_chain_matches',
            match_id: 'm-after-window', anchor_txid: 'dogetx_after_window'
        });
        await s._msgChain;

        assert.strictEqual(write.callCount, 1, 'one metadata update reaches the mirror');
        assert.strictEqual(write.firstCall.args[0],
            'UPDATE cross_chain_matches SET anchor_txid = COALESCE(anchor_txid, ?) WHERE match_id = ?');
        assert.deepStrictEqual(write.firstCall.args[1], ['dogetx_after_window', 'm-after-window']);
        assert.ok(!/INSERT/i.test(write.firstCall.args[0]),
            'an absent match must stay absent until REST bootstrap admits it');
    });
});

describe('HubDbSync watchdog measures transport not processing (ITEM 2477) @regression @tier2', function () {
    this.timeout(15000);

    beforeEach(async function () {
        server = new WebSocketServer({ port: 0 });
        port = await new Promise((res) => server.on('listening', () => res(server.address().port)));
    });

    afterEach(function () {
        if (sync) { sync.running = false; try { sync.stop(); } catch (e) { /* ignore */ } sync = null; }
        if (server) { try { server.close(); } catch (e) { /* ignore */ } server = null; }
    });

    it('half-open detection intact: no frames for the timeout window STILL terminates the socket', async function () {
        server.on('connection', (conn) => { conn.send(JSON.stringify({ type: 'ready' })); });

        sync = makeSync();
        await sync.connectWebSocket();
        const terminateSpy = sinon.spy(sync.ws, 'terminate');

        // Send NO further frames after 'ready'. Idle grows past the 150ms timeout.
        await waitUntil(() => terminateSpy.called);

        assert.strictEqual(terminateSpy.called, true,
            'a half-open socket that stops delivering frames must still be terminated');
    });
});
