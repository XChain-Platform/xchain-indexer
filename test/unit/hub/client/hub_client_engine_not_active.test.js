// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A reorg retraction sent to a hub that runs without the engine it targets is terminal.
//
// Every rollback that orphans an action writes xcall, match and bridge retraction rows
// ahead into pending_hub_pushes, and those *_retraction types carry no attempt cap. A hub
// started without peers never builds its cross-chain call, dex or bridge engine, and it
// answers each retraction with {error: '<x> engine not active'}. Left retryable, that reply
// keeps all three rows pending forever and every reorg adds three more. The engine that is
// absent holds no relay, match or transfer rows, so there is nothing for the push to retract.
//
// The queue half below is the load-bearing proof: it drives a real HubPushQueue over a
// real in-memory pending_hub_pushes table and asserts the rows LEAVE it.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert       = require('assert');
const sinon        = require('sinon');
const HubClient    = require('../../../../src/hub/hub_client.js');
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');

// The three reorg retractions and the exact reply each hub handler gives when its engine is absent.
const RETRACTIONS = [
    ['retractXcallRange',  'pushxcallreorg',  'xcall_retraction',  'cross-chain call engine not active'],
    ['retractMatchRange',  'pushdexreorg',    'match_retraction',  'cross-chain dex engine not active'],
    ['retractBridgeRange', 'pushbridgereorg', 'bridge_retraction', 'cross-chain bridge engine not active']
];

describe('HubClient: a reorg retraction to a hub without that engine is terminal', function(){
    afterEach(function(){
        sinon.restore();
        delete process.env.HUB_API_URL;
        delete process.env.HUB_API_KEY;
    });

    for(const [clientMethod, rpcMethod, , reply] of RETRACTIONS){
        it(clientMethod + ' resolves when the hub answers "' + reply + '"', async function(){
            let c = new HubClient('http://hub.example.com', '');
            let call = sinon.stub(c, 'call').resolves({ error: reply });
            let warn = sinon.stub(console, 'warn');
            let result = await c[clientMethod]('BTC', 100, 110, 0);
            warn.restore();
            assert.strictEqual(call.calledOnce, true);
            assert.strictEqual(call.firstCall.args[0], rpcMethod);
            assert.deepStrictEqual(result, { error: reply });
            assert.strictEqual(warn.calledOnce, true);
            assert.match(warn.firstCall.args.join(' '),
                new RegExp(rpcMethod + ' rejected terminally by the hub \\(' + reply + '\\); dropping the queued row'));
        });
    }

    // Narrow matching: a reason that describes hub state a retry can clear still throws.
    it('still throws on an unknown engine reason such as "engine busy"', async function(){
        let c = new HubClient('http://hub.example.com', '');
        sinon.stub(c, 'call').resolves({ error: 'cross-chain call engine busy' });
        await assert.rejects(() => c.retractXcallRange('BTC', 100, 110, 0), /hub rejected pushxcallreorg/);
    });

    // Bound to the method: the reply is only a verdict for the retraction aimed at that engine.
    it('does not drop a retraction on another engine\'s reply', async function(){
        let c = new HubClient('http://hub.example.com', '');
        sinon.stub(c, 'call').resolves({ error: 'cross-chain bridge engine not active' });
        await assert.rejects(() => c.retractXcallRange('BTC', 100, 110, 0), /hub rejected pushxcallreorg/);
    });

    // Bound to retractions: a forward push answered "engine not active" may be needed once the
    // engine comes up, so it keeps its row.
    it('does not drop a forward push on an engine-not-active reply', async function(){
        let c = new HubClient('http://hub.example.com', '');
        sinon.stub(c, 'call').resolves({ error: 'cross-chain engine not active' });
        await assert.rejects(() => c.pushAttestBatch({ source_chain: 'BTC', rows: [] }), /hub rejected pushattestbatch/);
    });
});

// A real HubPushQueue over a fake pending_hub_pushes table: markHubPushDelivered removes a
// row; recordHubPushAttempt keeps it pending (the retraction types pass Number.MAX_SAFE_INTEGER
// as the cap, so they never retire on their own).
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
            row.last_attempted_at = new Date(0).toISOString();
            if(row.attempts >= cap) row.status = 'failed';
        }
    };
}

function queueOver(hubClient, db){
    return new HubPushQueue({ hubClient, indexerDb: db },
        { baseBackoffMs: 0, maxBackoffMs: 0, maxAttempts: 3, failedRetentionSec: 0 });
}

// The three rows rollback stages for one orphaned action, as commit.js writes them.
function stagedRows(){
    return RETRACTIONS.map(([, , pushType], i) => ({
        id: i + 1, push_type: pushType,
        payload: JSON.stringify({ coin: 'BTC', action_index: 1858, last_action_index: 1858, retraction_generation: 0 })
    }));
}

function replyByMethod(method){
    let hit = RETRACTIONS.find(r => r[1] === method);
    return Promise.resolve({ error: hit ? hit[3] : 'unexpected method ' + method });
}

describe('HubPushQueue: engine-not-active retractions leave the queue instead of growing it', function(){

    beforeEach(function(){ sinon.stub(console, 'warn'); sinon.stub(console, 'log'); });
    afterEach(function(){ sinon.restore(); });

    it('drops all three staged retractions in one drain and never re-sends them', async function(){
        let db = fakePendingTable(stagedRows());
        let client = new HubClient('http://hub.example.com', '');
        let call = sinon.stub(client, 'call').callsFake(replyByMethod);
        let q = queueOver(client, db);

        assert.strictEqual(db.pending().length, 3);
        await q.drain();
        assert.deepStrictEqual(db.pending(), [], 'a retraction aimed at an absent engine must leave the queue');
        assert.strictEqual(db.table.size, 0, 'and leave no retired row behind either');
        assert.strictEqual(call.callCount, 3, 'each row costs exactly one delivery attempt');

        await q.drain();
        assert.strictEqual(call.callCount, 3, 'a further drain re-sends nothing');
    });

    it('keeps the rows on an unknown engine reason, so terminal matching stays narrow', async function(){
        let db = fakePendingTable(stagedRows());
        let client = new HubClient('http://hub.example.com', '');
        sinon.stub(client, 'call').resolves({ error: 'engine busy' });
        let q = queueOver(client, db);

        for(let i = 0; i < 3; i++) await q.drain();
        assert.strictEqual(db.pending().length, 3);
        for(let row of db.pending())
            assert.strictEqual(row.attempts, 3, row.push_type + ' must still be retrying');
    });
});
