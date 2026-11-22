'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { countFulfilledResponses } = require('../../../bin/repair-validator-stats.js');

function aggregate(rows){
    const stats = new Map();
    const errors = [];
    const ensure = (pubkey, provider) => {
        const key = pubkey + '|' + provider;
        if(!stats.has(key)) stats.set(key, { fulfilled: 0, lastBlock: 0 });
        return stats.get(key);
    };
    countFulfilledResponses(rows, ensure, message => errors.push(String(message)));
    return { stats, errors };
}

describe('repair-validator-stats fulfilled_count @regression', function(){
    it('logs and skips unparseable signatures while retaining valid counts', function(){
        const valid = JSON.stringify([{ pubkey: 'AA' }, { pubkey: 'aa' }]);
        const { stats, errors } = aggregate([
            { request_id: 'good', provider_id: 'p1', validator_signatures: valid, block_index: 12 },
            { request_id: 'bad-json', provider_id: 'p1', validator_signatures: '{bad', block_index: 13 }
        ]);
        assert.deepStrictEqual(stats.get('aa|p1'), { fulfilled: 2, lastBlock: 12 });
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0], /malformed validator_signatures/);
        assert.match(errors[0], /request bad-json, provider p1, block 13/);
    });

    it('logs and skips non-array signatures but accepts null as empty', function(){
        const { stats, errors } = aggregate([
            { request_id: 'bad-shape', provider_id: 'p2', validator_signatures: '{}', block_index: 20 },
            { request_id: 'empty', provider_id: 'p2', validator_signatures: 'null', block_index: 21 }
        ]);
        assert.strictEqual(stats.size, 0);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0], /non-array validator_signatures/);
        assert.match(errors[0], /request bad-shape, provider p2, block 20/);
    });
});
