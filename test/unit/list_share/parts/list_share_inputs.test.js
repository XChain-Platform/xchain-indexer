'use strict';

const assert = require('assert');
const { planListShareInputs } = require('../../../../src/consensus/list_share_settle/inputs.js');

const snapshot = (seq, height) => ({
    seq,
    admit_block_btc: height,
    snapshot_id: 'snapshot-' + seq
});

function fakeDb({ heads = [], counts = [], tails = {} } = {}){
    const reads = [];
    const mirror = {
        getListSnapshotHeads: async (network, coin) => {
            reads.push(['heads', network, coin]);
            return heads;
        },
        getListSnapshotsAfter: async (network, homeChain, homeListIndex, applied) => {
            reads.push(['after', network, homeChain, homeListIndex, applied]);
            return tails[homeChain + ':' + homeListIndex] || [];
        }
    };
    const db = {
        mirrorDb: () => mirror,
        getAppliedListShareCounts: async () => {
            reads.push(['counts']);
            return counts;
        }
    };

    return { db, reads };
}

const plan = (db, extra = {}) => planListShareInputs(db, {
    network: 'regtest',
    coin: 'BTC',
    blockIndex: 101,
    cap: 10,
    ...extra
});

describe('planListShareInputs', () => {
    it('reads only the tail for a list ahead of its numeric applied count', async () => {
        const doge2 = snapshot(2, 100);
        const doge3 = snapshot(3, 101);
        const { db, reads } = fakeDb({
            heads: [
                { home_chain: 'DOGE', home_list_index: 5, max_seq: 3 },
                { home_chain: 'LTC', home_list_index: 9, max_seq: 2 }
            ],
            counts: [
                { src_chain: 'DOGE', src_action_index: '5', applied_seq: 1 },
                { src_chain: 'LTC', src_action_index: 9, applied_seq: 2 }
            ],
            tails: { 'DOGE:5': [doge2, doge3] }
        });

        const out = await plan(db);

        assert.deepStrictEqual(out.due, [doge2, doge3]);
        assert.deepStrictEqual(reads, [
            ['heads', 'regtest', 'BTC'],
            ['counts'],
            ['after', 'regtest', 'DOGE', 5, 1]
        ]);
    });

    it('returns only rows admitted at the current block', async () => {
        const due = snapshot(2, 100);
        const future = snapshot(3, 101);
        const { db } = fakeDb({
            heads: [{ home_chain: 'DOGE', home_list_index: 5, max_seq: 3 }],
            counts: [{ src_chain: 'DOGE', src_action_index: 5, applied_seq: 1 }],
            tails: { 'DOGE:5': [due, future] }
        });

        assert.deepStrictEqual((await plan(db, { blockIndex: 100 })).due, [due]);
    });

    it('passes the cap to the due-version planner', async () => {
        const first = snapshot(1, 100);
        const second = snapshot(2, 100);
        const { db } = fakeDb({
            heads: [{ home_chain: 'DOGE', home_list_index: 5, max_seq: 2 }],
            tails: { 'DOGE:5': [first, second] }
        });

        assert.deepStrictEqual((await plan(db, { cap: 1 })).due, [first]);
    });

    it('returns a sequence-gap halt without throwing', async () => {
        const { db } = fakeDb({
            heads: [{ home_chain: 'DOGE', home_list_index: 5, max_seq: 3 }],
            tails: { 'DOGE:5': [snapshot(1, 100), snapshot(3, 100)] }
        });

        const out = await plan(db);

        assert.deepStrictEqual(out, {
            halt: {
                reason: 'SEQ_GAP',
                home_chain: 'DOGE',
                home_list_index: 5,
                seq: 2
            }
        });
    });

    it('returns an empty plan for no heads without reading a tail', async () => {
        const { db, reads } = fakeDb();

        assert.deepStrictEqual(await plan(db), { due: [] });
        assert.deepStrictEqual(reads, [
            ['heads', 'regtest', 'BTC'],
            ['counts']
        ]);
    });
});
