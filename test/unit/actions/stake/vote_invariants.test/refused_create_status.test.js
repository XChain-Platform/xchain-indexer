/*
 * test/unit/actions/stake/vote_invariants.test/refused_create_status.test.js
 *
 * A refused VOTE v0 create persists its status as an inert poll row (no window, no
 * deposit, no callback) so readers report the refusal; a valid create stays live.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const settle = require('../../../../../src/actions/vote/settle.js');
const pollCreate = require('../../../../../src/db/polls/poll_create.js');

function ctx() {
    return {
        config: { GAS: 'GAS' },
        util: { bcadd: () => '0', bcgt: () => false, addAddressTicker: sinon.stub() },
        mapper: { createMappings: sinon.stub().resolves() },
        indexerDb: { createPoll: sinon.stub().resolves() },
    };
}

describe('VOTE v0 refused create status @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('a refused create writes an inert row carrying the refusal', async function () {
        const c = ctx();
        const data = { TICK: 'X', SOURCE: 'a', GAS_ESCROW: '0' };
        await settle.settleCreatePoll.call(c, data, 'invalid: TICK (missing)', '0');
        assert.strictEqual(data.STATUS, 'invalid: TICK (missing)');
        assert.ok(c.indexerDb.createPoll.calledOnce);
        assert.deepStrictEqual(c.indexerDb.createPoll.firstCall.args[1], { inert: true });
    });

    it('a valid create writes the live row', async function () {
        const c = ctx();
        const data = { TICK: 'X', SOURCE: 'a', GAS_ESCROW: '0' };
        await settle.settleCreatePoll.call(c, data, null, '0');
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(c.indexerDb.createPoll.firstCall.args[1], undefined);
    });

    it('createPoll inert stores no window, deposit or callback and skips the ticker', async function () {
        const queries = [];
        const db = Object.assign({
            createTicker: sinon.stub().rejects(new Error('must not create a ticker')),
            createStatus: sinon.stub().resolves(9),
            doQuery: async (q, a) => { queries.push([q, a]); return []; },
        }, pollCreate);
        await db.createPoll({ ACTION_INDEX: 7, BLOCK_INDEX: 100, TICK: 'bogus', STATUS: 'invalid: x' }, { inert: true });
        const [sql, args] = queries[queries.length - 1];
        assert.ok(/^INSERT INTO polls/.test(sql.trim()));
        assert.strictEqual(args[args.length - 2], 9, 'status_id');
        assert.strictEqual(args[args.length - 1], 7, 'action_index');
        assert.strictEqual(args[2], null, 'end_block stays null so no sweep selects it');
        assert.strictEqual(args[10], null, 'decide_threshold');
        assert.strictEqual(args[13], null, 'deposit_address_id');
        assert.strictEqual(args[14], null, 'callback_contract_index');
    });
});
