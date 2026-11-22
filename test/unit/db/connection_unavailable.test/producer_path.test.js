'use strict';

const assert = require('assert');
const sinon = require('sinon');

const connections = require('../../../../src/db/database/connections.js');
const blocks = require('../../../../src/db/blocks/index.js');
const { runTargetExecution } = require('../../../../src/actions/xexec/run_target.js');
const XChainIndexer = require('../../../../src/XChainIndexer.js');
const {
    DB_CONNECTION_UNAVAILABLE,
    rethrowIfInfraFault
} = require('../../../../src/consensus/fault_guard.js');

const OPEN_MESSAGE = 'Circuit breaker open - database connections rejected until cooldown expires';

function connectionContext(overrides = {}){
    return Object.assign({
        transactionConnection: null,
        circuitState: 'closed',
        circuitOpenUntil: 0,
        circuitFailures: 0,
        circuitThreshold: 100,
        circuitCooldown: 30000,
        pool: { getConnection: sinon.stub().rejects(new Error('pool unavailable')) },
        util: {
            sleep: sinon.stub().resolves(),
            throwError(error){ throw error instanceof Error ? error : new Error(String(error)); }
        }
    }, overrides);
}

async function openCircuitError(){
    const ctx = connectionContext({ circuitState: 'open', circuitOpenUntil: Date.now() + 60000 });
    try {
        await connections.getConnection.call(ctx);
    } catch (error){
        return error;
    }
    throw new Error('open circuit did not reject');
}

function assertUnavailable(error, message){
    assert.strictEqual(error.code, DB_CONNECTION_UNAVAILABLE);
    assert.strictEqual(error.message, message);
    return true;
}

describe('database connection-unavailable fault propagation @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('tags every connection-acquisition refusal without changing its message', async function () {
        const alreadyOpen = await openCircuitError();
        assertUnavailable(alreadyOpen, OPEN_MESSAGE);

        const newlyOpen = connectionContext({ circuitThreshold: 1 });
        await assert.rejects(() => connections.getConnection.call(newlyOpen), (error) =>
            assertUnavailable(error,
                'Circuit breaker opened after 1 consecutive failures - cooling down for 30s'));

        const exhausted = connectionContext();
        await assert.rejects(() => connections.getConnection.call(exhausted), (error) =>
            assertUnavailable(error, 'Could not connect to MariaDB after 30 attempts. Giving up.'));
        assert.strictEqual(exhausted.pool.getConnection.callCount, 30,
            'retry exhaustion must exercise the negative producer path');
    });

    it('rethrows the typed outage but leaves a contract-shaped error alone', async function () {
        const outage = await openCircuitError();
        assert.throws(() => rethrowIfInfraFault(outage), (error) => error === outage);
        assert.doesNotThrow(() => rethrowIfInfraFault(new Error('contract rejected')));
    });

    it('rolls back and rejects target execution instead of returning an error verdict', async function () {
        const outage = await openCircuitError();
        const ctx = {
            indexerDb: {
                createSavepoint: sinon.stub().resolves('target'),
                rollbackToSavepoint: sinon.stub().resolves(),
                releaseSavepoint: sinon.stub().resolves()
            },
            actions: { actionExecute: { parse: sinon.stub().rejects(outage) } },
            mapFailureStatus: sinon.stub()
        };

        await assert.rejects(() => runTargetExecution.call(ctx, {}, [], {}, 7),
            (error) => error === outage);
        assert.ok(ctx.indexerDb.rollbackToSavepoint.calledOnceWithExactly('target'));
        assert.ok(ctx.indexerDb.releaseSavepoint.notCalled);
    });

    it('makes consensus block-time reads reject instead of returning absence', async function () {
        const outage = await openCircuitError();
        const ctx = {
            _blockTimeCache: { block_index: null, block_time: null },
            doQueryStrict: sinon.stub().rejects(outage)
        };

        await assert.rejects(() => blocks.getRawBlockTime.call(ctx, 8), (error) => error === outage);
        await assert.rejects(() => blocks.getPreviousBlockTimes.call(ctx, 8, 3),
            (error) => error === outage);
    });

    it('keeps all typed producer messages recognizable as ride-out outages', async function () {
        const errors = [await openCircuitError()];
        const opened = connectionContext({ circuitThreshold: 1 });
        try { await connections.getConnection.call(opened); } catch (error) { errors.push(error); }
        const exhausted = connectionContext();
        try { await connections.getConnection.call(exhausted); } catch (error) { errors.push(error); }

        assert.strictEqual(errors.length, 3, 'all negative producer paths must reject');
        for(const error of errors){
            assert.strictEqual(XChainIndexer.isDbOutageError(error), true, error.message);
            assert.strictEqual(XChainIndexer.isDbOutageError(
                new Error('beginTransaction error=' + String(error))), true, error.message);
        }
    });
});
