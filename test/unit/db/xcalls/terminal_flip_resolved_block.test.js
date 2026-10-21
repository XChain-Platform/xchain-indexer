'use strict';

const assert = require('assert');

const xcalls = require('../../../../src/db/xcalls/index.js');
const { parseExpire } = require('../../../../src/actions/xcall/expire.js');
const { processResult } = require('../../../../src/actions/xcall/result.js');

const CALL_ID = 'A'.repeat(64);

function makeDb(request) {
    const queries = [];
    const db = {
        queries,
        async doQuery(sql, args) {
            queries.push({ sql, args });
            return [];
        },
        async getCrossChainCallRequestById() { return request; },
        async createActionIndex() { return 91; },
        async updateCrossChainCallRequestStatus(...args) {
            return xcalls.updateCrossChainCallRequestStatus.call(db, ...args);
        },
        async recordCrossChainCallCallback() {},
        async setCrossChainCallCallbackIndex() {},
    };
    return db;
}

function assertTerminalFlip(db, expectedArgs) {
    assert.strictEqual(db.queries.length, 1);
    const { sql, args } = db.queries[0];
    assert.match(sql, /SET request_status = \?, result_status = \?, result_payload = \?, resolved_block = \?/);
    assert.deepStrictEqual(args, expectedArgs);
}

describe('terminal XCALL resolved_block @regression @tier1', function () {
    it('stamps expiry with the processing BLOCK_INDEX, not the request block', async function () {
        const request = {
            request_status: 'pending',
            block_index: 101,
            deadline_block: 500,
        };
        const db = makeDb(request);
        const handler = {
            indexerDb: db,
            async injectCallback() {},
            mapper: { async createMappings() {} },
        };

        await parseExpire.call(handler, [], {
            IS_SYNTHETIC: true,
            CALL_ID,
            BLOCK_INDEX: 812,
        }, null);

        assertTerminalFlip(db, ['expired', 'expired', '', 812, CALL_ID.toLowerCase()]);
    });

    it('stamps completion with the processing BLOCK_INDEX, not the request block', async function () {
        const request = {
            request_status: 'pending',
            block_index: 202,
            target_chain: 'DOGE',
        };
        const db = makeDb(request);
        const handler = {
            config: { NETWORK: 'regtest' },
            indexerDb: db,
            async verifyResultQuorum() {
                return { synced: true, N: 1, validSigners: ['validator'], quorumMet: true };
            },
            async retireUndeliverableResult() { return false; },
            async injectCallback() { return null; },
            mapper: { async createMappings() {} },
        };

        await processResult.call(handler, {
            call_id: CALL_ID,
            network: 'regtest',
            target_chain: 'DOGE',
            result_status: 'ok',
            return_payload_b64: Buffer.from('done').toString('base64'),
        }, { BLOCK_INDEX: 913 });

        assertTerminalFlip(db, ['completed', 'ok', 'done', 913, CALL_ID.toLowerCase()]);
    });
});
