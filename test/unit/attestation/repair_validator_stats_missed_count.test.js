'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { missChargeContext } = require('../../../scripts/repair-validator-stats.js');
const Rollback = require('../../../src/rollback/attestation_stats.js');

const PK = ch => ch.repeat(64);
const REQ = { request_id: 'e'.repeat(64), provider_id: 'p1', redundancy: 2, block_index: 100, deadline_block: 110 };

function run(req, db, config){
    let stats  = new Map();
    let ensure = (pubkey, provider) => {
        let key = pubkey + '|' + provider;
        if(!stats.has(key)) stats.set(key, { pubkey, provider, fulfilled: 0, missed: 0, lastBlock: 0 });
        return stats.get(key);
    };
    return missChargeContext({ config, indexerDb: db }).countExpiredMisses([req], ensure).then(() => stats);
}

describe('repair-validator-stats missed_count @regression', function(){
    it('charges the pinned responsible set and never re-derives', async function(){
        let db = { getValidatorsByCapability: sinon.stub().rejects(new Error('re-derived')),
                   getStakeWeightsByCapability: sinon.stub().rejects(new Error('re-derived')) };
        let stats = await run(Object.assign({}, REQ, { responsible_set_json: JSON.stringify([PK('A'), PK('b')]) }),
                              db, { COIN: 'BTC', NETWORK: 'regtest' });
        assert.deepStrictEqual([...stats.values()].map(s => s.pubkey).sort(), [PK('a'), PK('b')]);
        assert.ok([...stats.values()].every(s => s.missed === 1 && s.lastBlock === 111));
        sinon.assert.notCalled(db.getValidatorsByCapability);
    });

    it('an empty pin charges nobody', async function(){
        let db = { getValidatorsByCapability: sinon.stub().rejects(new Error('re-derived')) };
        let stats = await run(Object.assign({}, REQ, { responsible_set_json: '[]' }), db, { COIN: 'BTC', NETWORK: 'regtest' });
        assert.strictEqual(stats.size, 0);
    });

    it('a legacy row re-derives through the same routine the reorg recompute uses', async function(){
        let ctx = missChargeContext({ config: { COIN: 'BTC', NETWORK: 'regtest' }, indexerDb: {} });
        assert.strictEqual(ctx.countExpiredMisses, Rollback.countExpiredMisses);
        assert.strictEqual(ctx.responsibleSet, Rollback.responsibleSet);
        assert.strictEqual(ctx.capabilitySnapshotForBlock, Rollback.capabilitySnapshotForBlock);

        let snap = sinon.stub(ctx, 'capabilitySnapshotForBlock').resolves({
            weighted: false,
            validators: [PK('a'), PK('b'), PK('c')].map(pubkey => ({ pubkey, source: pubkey }))
        });
        let stats = new Map();
        await ctx.countExpiredMisses([REQ], (pk, p) => { let s = { pubkey: pk, provider: p, missed: 0, lastBlock: 0 }; stats.set(pk, s); return s; });
        sinon.assert.calledOnceWithExactly(snap, 100);
        assert.strictEqual(stats.size, 2);
    });
});
