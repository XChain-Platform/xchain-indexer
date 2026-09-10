// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A hub rejection that arrives as a JSON-RPC ERROR is classified on the same axis as one
// that arrives inside the result.
//
// The hub's four durable push handlers now refuse an unknown chain by throwing -32602
// instead of describing the refusal in a result field. _call rejects on a top-level
// envelope `error`, which happens BEFORE _requireHubAccepted ever sees a payload, so the
// in-result patterns cannot reach it. Unclassified, that rejection reads as a transport
// failure: the durable push types (oracle_price, price_batch, attest_batch and the
// retractions) carry no attempt cap, and the queued row replays the same source_chain into
// the same refusal on every drain, forever.
//
// The queue half below is the load-bearing proof: it drives a real HubPushQueue over a
// real in-memory pending_hub_pushes table and asserts the row LEAVES it.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert       = require('assert');
const sinon        = require('sinon');
const HubClient    = require('../../src/hub_client.js');
const HubPushQueue = require('../../src/hub_push_queue.js');

// The rejection _call builds from a hub envelope carrying { code, message }.
function rpcError(code, message){
    let err = new Error(message);
    err.rpcCode = code;
    return err;
}

const UNKNOWN_CHAIN = 'chain must be one of: BTC, LTC, DOGE';

// The four durable push handlers the hub moved, with a payload for each.
const PUSHES = [
    ['pushPriceRound',  'pushpriceround',  { source_chain: 'ETH', round: 1, pairs: [] }],
    ['pushPriceBatch',  'pushpricebatch',  { source_chain: 'ETH', first_round: 1, last_round: 6, rounds: [] }],
    ['pushAttestBatch', 'pushattestbatch', { source_chain: 'ETH', rows: [], sigs: [] }],
    ['pushOraclePrice', 'pushoracleprice', { source_chain: 'ETH', coin: 'BTC', tick: 'XCP', fiat: 'USD', value: '1' }]
];

describe('HubClient: a thrown hub rejection is classified like an in-result one', function(){

    afterEach(function(){
        sinon.restore();
        delete process.env.HUB_API_URL;
        delete process.env.HUB_API_KEY;
    });

    describe('terminal: -32602 resolves so the queued row is dropped', function(){

        for(const [clientMethod, rpcMethod, payload] of PUSHES){
            it(clientMethod + ' resolves rather than throwing when the hub answers -32602', async function(){
                let c = new HubClient('http://hub.example.com', '');
                let call = sinon.stub(c, '_call').rejects(rpcError(-32602, UNKNOWN_CHAIN));
                // Resolving IS the terminal verdict: HubPushQueue and XChainIndexer both key
                // on throw-versus-resolve, so a resolve retires the durable row.
                let result = await c[clientMethod](payload);
                assert.strictEqual(call.calledOnce, true);
                assert.strictEqual(call.firstCall.args[0], rpcMethod);
                // The shape the hub itself returned for this refusal before it moved the
                // guard into the error slot, so nothing downstream sees a new value.
                assert.deepStrictEqual(result, { error: UNKNOWN_CHAIN });
            });
        }

        it('logs the drop, worded like the in-result branch so one grep finds both', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(rpcError(-32602, UNKNOWN_CHAIN));
            let warn = sinon.stub(console, 'warn');
            await c.pushOraclePrice({ source_chain: 'ETH' });
            warn.restore();
            assert.strictEqual(warn.calledOnce, true);
            assert.match(warn.firstCall.args.join(' '),
                /pushoracleprice rejected terminally by the hub \(chain must be one of: BTC, LTC, DOGE\); dropping the queued row/);
        });

        // The hub stamps `code` on the error it throws; _call re-homes it as `rpcCode` so it
        // cannot collide with Node's own string `code` on a socket error. A numeric `code` is
        // honoured too, for a caller handing back the hub's error object as the hub stamped it.
        it('honours a numeric `code` when `rpcCode` is absent', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let err = new Error(UNKNOWN_CHAIN);
            err.code = -32602;
            sinon.stub(c, '_call').rejects(err);
            assert.deepStrictEqual(await c.pushPriceBatch({ source_chain: 'ETH' }), { error: UNKNOWN_CHAIN });
        });

        it('classifies the retraction rails on the same code', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(rpcError(-32602, UNKNOWN_CHAIN));
            assert.deepStrictEqual(await c.retractPriceRange('ETH', 10), { error: UNKNOWN_CHAIN });
        });
    });

    describe('transient: everything else still throws so the row is retried', function(){

        // Each of these describes the HUB's state or the wire between it and this node, never
        // the payload, so a later attempt can clear it and the durable row must survive.
        const TRANSIENT = [
            ['-32000 (a server error)',        rpcError(-32000, 'internal hub failure')],
            ['-32603 (JSON-RPC internal)',     rpcError(-32603, 'Internal error')],
            ['-32601 (method not available)',  rpcError(-32601, 'Method not available on this port')],
            ['a socket error',                 Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
            ['a response the hub truncated',   new Error('hub closed the connection before the response body was complete')]
        ];

        for(const [label, err] of TRANSIENT){
            for(const [clientMethod] of PUSHES){
                it(clientMethod + ' throws on ' + label, async function(){
                    let c = new HubClient('http://hub.example.com', '');
                    sinon.stub(c, '_call').rejects(err);
                    await assert.rejects(() => c[clientMethod]({ source_chain: 'BTC' }));
                });
            }
        }

        // The one collision the code-keyed classifier exists to avoid. This message comes from
        // THIS client's own parse path, not from the hub, and /^invalid\b/ in the in-result
        // pattern list matches it: judging a rejection by its message would drop a durable row
        // on a truncated body.
        it('does not read a local parse failure as the payload-invalid pattern', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').rejects(new Error('Invalid JSON response: Unexpected token T'));
            await assert.rejects(() => c.pushAttestBatch({ source_chain: 'BTC' }), /Invalid JSON response/);
        });

        // A throttle is the hub declining to LOOK at the payload, so it is never a verdict on
        // it, whatever code rides along.
        it('never treats a rate-limited rejection as terminal', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let err = rpcError(-32602, 'hub rate limit exceeded');
            err.rateLimited  = true;
            err.retryAfterMs = 60000;
            sinon.stub(c, '_call').rejects(err);
            await assert.rejects(() => c.pushPriceBatch({ source_chain: 'BTC' }), (thrown) => {
                assert.strictEqual(thrown.rateLimited, true);
                return true;
            });
        });
    });

    // The in-result path is unchanged by the new branch: a hub that has not moved its guard
    // yet, or any of the other rejections that still ride inside the envelope, are judged
    // exactly as before.
    describe('the in-result path is untouched', function(){
        it('still resolves an in-result terminal rejection', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').resolves({ error: UNKNOWN_CHAIN });
            assert.deepStrictEqual(await c.pushPriceBatch({ source_chain: 'ETH' }), { error: UNKNOWN_CHAIN });
        });

        it('still throws an in-result transient rejection', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').resolves({ accepted: false, reason: 'validator snapshot unavailable' });
            await assert.rejects(() => c.pushPriceBatch({ source_chain: 'BTC' }), /hub rejected pushpricebatch/);
        });

        it('still resolves an accepted push untouched', async function(){
            let c = new HubClient('http://hub.example.com', '');
            sinon.stub(c, '_call').resolves({ accepted: true, stored: 6 });
            assert.deepStrictEqual(await c.pushPriceBatch({ source_chain: 'BTC' }), { accepted: true, stored: 6 });
        });
    });
});

// ---------------------------------------------------------------------------
// The durable queue itself, over a real HubPushQueue and a real in-memory
// pending_hub_pushes table. markHubPushDelivered removes a row; recordHubPushAttempt
// keeps it pending (the durable types pass Number.MAX_SAFE_INTEGER as the cap, so they
// never retire), which is exactly how the table grows when a rejection is misclassified.
// ---------------------------------------------------------------------------
function fakePendingTable(rows){
    let table = new Map(rows.map(r => [r.id, Object.assign({ attempts: 0, status: 'pending', last_attempted_at: null }, r)]));
    return {
        table,
        pending(){ return [...table.values()].filter(r => r.status === 'pending'); },
        async getPendingHubPushes(){ return this.pending(); },
        async markHubPushDelivered(id){ table.delete(id); },
        async recordHubPushAttempt(id, message, cap){
            let row = table.get(id);
            if(!row) return;
            row.attempts   = (row.attempts || 0) + 1;
            row.last_error = message;
            // Epoch, so the row is due again on the very next drain and the test measures
            // classification rather than backoff.
            row.last_attempted_at = new Date(0).toISOString();
            if(row.attempts >= cap) row.status = 'failed';
        }
    };
}

function queueOver(hubClient, db){
    // baseBackoffMs 0 so a retried row is due immediately; the cap only bites on the
    // best-effort price_round type, which is the point of the last case below.
    return new HubPushQueue({ hubClient, indexerDb: db },
        { baseBackoffMs: 0, maxBackoffMs: 0, maxAttempts: 3, failedRetentionSec: 0 });
}

// One row per push type the four moved handlers back. price_round is the only capped one.
const QUEUE_ROWS = [
    { id: 1, push_type: 'price_round',  payload: JSON.stringify({ source_chain: 'ETH', round: 1, pairs: [] }) },
    { id: 2, push_type: 'price_batch',  payload: JSON.stringify({ source_chain: 'ETH', first_round: 1, last_round: 6, rounds: [] }) },
    { id: 3, push_type: 'attest_batch', payload: JSON.stringify({ source_chain: 'ETH', rows: [], sigs: [] }) },
    { id: 4, push_type: 'oracle_price', payload: JSON.stringify({ source_chain: 'ETH', coin: 'BTC', tick: 'XCP', fiat: 'USD', value: '1' }) }
];

describe('HubPushQueue: a -32602 rejection empties the queue instead of growing it', function(){

    let warn;
    beforeEach(function(){ warn = sinon.stub(console, 'warn'); sinon.stub(console, 'log'); });
    afterEach(function(){ sinon.restore(); });

    it('drops every durable row the hub refuses on the payload, in one attempt each', async function(){
        let db = fakePendingTable(QUEUE_ROWS);
        let client = new HubClient('http://hub.example.com', '');
        let call = sinon.stub(client, '_call').rejects(rpcError(-32602, UNKNOWN_CHAIN));
        let q = queueOver(client, db);

        assert.strictEqual(db.pending().length, 4);
        await q.drain();
        assert.deepStrictEqual(db.pending(), [], 'a payload the hub can never accept must leave the queue');
        assert.strictEqual(db.table.size, 0, 'and leave no retired row behind either');
        assert.strictEqual(call.callCount, 4, 'each row costs exactly one delivery attempt');

        // Nothing left to replay, so a further drain is free.
        await q.drain();
        assert.strictEqual(call.callCount, 4);
    });

    // The falsification control, and the failure this whole change is about: before the
    // classifier, this is what -32602 did.
    it('keeps every durable row when the hub answers a transient error, growing attempts without bound', async function(){
        let db = fakePendingTable(QUEUE_ROWS);
        let client = new HubClient('http://hub.example.com', '');
        sinon.stub(client, '_call').rejects(rpcError(-32000, 'internal hub failure'));
        let q = queueOver(client, db);

        for(let i = 0; i < 5; i++) await q.drain();

        // price_round is the capped best-effort type and retires at maxAttempts; the three
        // durable types never do, which is why misclassifying a payload refusal is unbounded.
        let durable = db.pending().map(r => r.push_type).sort();
        assert.deepStrictEqual(durable, ['attest_batch', 'oracle_price', 'price_batch']);
        for(let row of db.pending())
            assert.strictEqual(row.attempts, 5, row.push_type + ' must still be retrying');
        assert.strictEqual(db.table.get(1).status, 'failed', 'the capped type still retires');
    });

    it('reports the drop once per row so an operator sees the standing condition', async function(){
        let db = fakePendingTable([QUEUE_ROWS[3]]);
        let client = new HubClient('http://hub.example.com', '');
        sinon.stub(client, '_call').rejects(rpcError(-32602, UNKNOWN_CHAIN));
        await queueOver(client, db).drain();
        let lines = warn.getCalls().map(c => c.args.join(' '));
        assert.strictEqual(lines.filter(l => /rejected terminally by the hub/.test(l)).length, 1);
    });

    it('still delivers a row the hub accepts', async function(){
        let db = fakePendingTable([{ id: 9, push_type: 'attest_batch', payload: JSON.stringify({ source_chain: 'DOGE', rows: [] }) }]);
        let client = new HubClient('http://hub.example.com', '');
        sinon.stub(client, '_call').resolves({ accepted: true });
        await queueOver(client, db).drain();
        assert.strictEqual(db.table.size, 0);
    });
});
