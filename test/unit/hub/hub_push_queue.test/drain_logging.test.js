// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The drain timer's log line. A failing drain passed err.message as the logger's fields
// argument, which the logger drops, so a regtest indexer logged an empty
// "HubPushQueue: drain error:" every 30 s. The cause now rides in the message, and a
// drain that finds no rows logs nothing.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert       = require('assert');
const sinon        = require('sinon');
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');
const { makeIndexer } = require('./helpers/fixtures.js');

function makeLogger(){
    return { info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
}

// The one warn line a failing drain wrote, asserted to be a single string argument.
function onlyWarning(logger){
    assert.strictEqual(logger.warn.callCount, 1, 'one warning per failed drain');
    const args = logger.warn.firstCall.args;
    assert.strictEqual(args.length, 1, 'the cause is in the message, not a dropped fields argument');
    return args[0];
}

function registerFailureTests(){
    it('logs the drain error message on a failed drain', async function(){
        const q = new HubPushQueue(makeIndexer());
        sinon.stub(q, 'drain').rejects(new Error('database unavailable'));
        const logger = makeLogger();

        await q.drainAndLog(logger);

        assert.strictEqual(onlyWarning(logger), 'HubPushQueue: drain error: database unavailable');
    });

    it('logs the inner causes of an AggregateError, whose own message is empty', async function(){
        const q = new HubPushQueue(makeIndexer());
        const refused = (addr) => Object.assign(new Error('connect ECONNREFUSED ' + addr), { code: 'ECONNREFUSED' });
        sinon.stub(q, 'drain').rejects(new AggregateError([refused('127.0.0.1:3306'), refused('::1:3306')], ''));
        const logger = makeLogger();

        await q.drainAndLog(logger);

        assert.strictEqual(onlyWarning(logger),
            'HubPushQueue: drain error: connect ECONNREFUSED 127.0.0.1:3306; connect ECONNREFUSED ::1:3306');
    });

    it('never writes an empty cause, even for an error with no message', async function(){
        const q = new HubPushQueue(makeIndexer());
        sinon.stub(q, 'drain').rejects(Object.assign(new Error(''), { code: 'ER_GET_CONNECTION_TIMEOUT' }));
        const logger = makeLogger();

        await q.drainAndLog(logger);

        assert.strictEqual(onlyWarning(logger), 'HubPushQueue: drain error: ER_GET_CONNECTION_TIMEOUT');
    });

    it('resolves rather than rejecting, so a failed tick never becomes an unhandled rejection', async function(){
        const q = new HubPushQueue(makeIndexer());
        sinon.stub(q, 'drain').rejects(new Error('boom'));
        await q.drainAndLog(makeLogger());
    });
}

function registerQuietTests(){
    it('logs nothing when the drain finds no rows', async function(){
        const indexer = makeIndexer();
        const q = new HubPushQueue(indexer, { failedRetentionSec: 0 });
        const logger = makeLogger();

        await q.drainAndLog(logger);

        assert.strictEqual(indexer.indexerDb.getPendingHubPushes.callCount, 1, 'the drain really ran');
        assert.strictEqual(logger.warn.callCount, 0);
        assert.strictEqual(logger.error.callCount, 0);
        assert.strictEqual(logger.info.callCount, 0);
    });
}

function registerTimerTests(){
    let clock;
    beforeEach(function(){ clock = sinon.useFakeTimers(); });
    afterEach(function(){ clock.restore(); sinon.restore(); });

    it('routes every timer tick through drainAndLog', async function(){
        const q = new HubPushQueue(makeIndexer(), { intervalMs: 1000 });
        const tick = sinon.stub(q, 'drainAndLog').resolves();
        q.start();
        try {
            clock.tick(3000);
            assert.strictEqual(tick.callCount, 3);
            assert.deepStrictEqual(tick.firstCall.args, [], 'the tick takes the default logger');
        } finally {
            q.stop();
        }
    });
}

describe('HubPushQueue drain logging @regression', function(){
    afterEach(function(){ sinon.restore(); });
    describe('a failed drain', registerFailureTests);
    describe('an empty drain', registerQuietTests);
    describe('the drain timer', registerTimerTests);
});
