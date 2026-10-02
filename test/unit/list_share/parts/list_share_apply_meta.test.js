'use strict';

const assert = require('assert');
const H = require('../helpers/apply_harness.js');
const createApply = require('../../../../src/consensus/list_share_settle/apply.js');

function screenedFields(row){
    return {
        snapshot_id: row.snapshot_id,
        snapshot_block: row.snapshot_block,
        home_chain: row.home_chain,
        home_list_index: row.home_list_index,
        list_type: row.list_type,
        seq: row.seq,
        added: JSON.parse(row.added),
        removed: JSON.parse(row.removed),
        name: row.name,
        description: row.description,
        meta_hash: row.meta_hash,
    };
}

function makeApply(isListMetaApplyActive){
    const deps = {
        screen: { screenListSnapshot: row => ({ fields: screenedFields(row) }) },
        quorum: { verifyQuorum: async () => ({ met: true }) },
        canonical: { listShareCanonical: () => 'canonical' },
    };
    if(isListMetaApplyActive !== undefined)
        deps.isListMetaApplyActive = isListMetaApplyActive;
    return createApply(deps).applyListShareSnapshot;
}

function namedRow(seq, overrides = {}){
    return Object.assign(H.makeListSnapshotRow({
        seq,
        added: seq === 1 ? ['nA'] : [],
        removed: [],
        members: ['nA'],
        admit: { btc: 800 },
    }), {
        name: 'Friends',
        description: 'People I know',
        meta_hash: 'screened-meta-hash',
    }, overrides);
}

function prepare(overrides = {}){
    const made = H.makeListShareCtx({ blockIndex: 901 });
    const data = [];
    const original = made.ctx.actions.processTransaction;
    made.ctx.actions.processTransaction = async (tx, isGenesis) => {
        data.push(tx.data);
        const fields = tx.data.split('|');
        if(fields[1] === '5')
            return { ACTION_INDEX: 8100 + data.length, STATUS: 'valid' };
        if(fields[1] === '4'){
            const rewritten = Object.assign({}, tx, {
                data: ['LIST', '0', fields[2], ''].concat(fields.slice(6)).join('|'),
            });
            return original(rewritten, isGenesis);
        }
        return original(tx, isGenesis);
    };
    let metaReads = 0;
    made.ctx.indexerDb.getListMeta = async (...args) => {
        metaReads += 1;
        if(overrides.onMetaRead) return overrides.onMetaRead(...args);
        return overrides.currentMeta || null;
    };
    return Object.assign(made, { data, metaReads: () => metaReads });
}

function seedMirror(made, actionIndex = 77){
    made.state.mirrors.push({
        action_index: actionIndex,
        home_chain: H.HOME,
        home_list_index: H.HOME_LIST_INDEX,
        block_index: made.ctx.blockIndex - 1,
    });
    made.state.lists.set(actionIndex, { type: 2, owner: H.BRIDGE_DOGE_ON_BTC,
        members: new Set(['nA']) });
}

describe('list share apply metadata wiring', function () {
    it('keeps today\'s create leg and skips metadata reads without a reader', async function () {
        const made = prepare();

        await makeApply()(namedRow(1), made.ctx);

        assert.deepStrictEqual(made.data, ['LIST|0|2||nA']);
        assert.strictEqual(made.metaReads(), 0);
    });

    it('keeps today\'s create leg and skips metadata reads below the gate', async function () {
        const made = prepare();
        const calls = [];
        const active = (...args) => { calls.push(args); return false; };

        await makeApply(active)(namedRow(1), made.ctx);

        assert.deepStrictEqual(calls, [[made.ctx.coin, made.ctx.network, made.ctx.blockIndex]]);
        assert.deepStrictEqual(made.data, ['LIST|0|2||nA']);
        assert.strictEqual(made.metaReads(), 0);
    });

    it('reads current metadata and processes one rename-only leg at the gate', async function () {
        const reads = [];
        const made = prepare({
            currentMeta: { name: 'Old friends', description: 'People I know' },
            onMetaRead: (index, blockIndex) => {
                reads.push([index, blockIndex]);
                return { name: 'Old friends', description: 'People I know' };
            },
        });
        seedMirror(made);
        const calls = [];
        const active = (...args) => { calls.push(args); return true; };

        await makeApply(active)(namedRow(2), made.ctx);

        assert.deepStrictEqual(calls, [[made.ctx.coin, made.ctx.network, made.ctx.blockIndex]]);
        assert.deepStrictEqual(reads, [[77, made.ctx.blockIndex]]);
        assert.deepStrictEqual(made.data, ['LIST|5|77|Friends|People I know|']);
    });

    it('processes no leg when current metadata is unchanged', async function () {
        const made = prepare({ currentMeta: { name: 'Friends', description: 'People I know' } });
        seedMirror(made);

        await makeApply(() => true)(namedRow(2), made.ctx);

        assert.deepStrictEqual(made.data, []);
        assert.strictEqual(made.metaReads(), 1);
    });

    it('processes a named seq 1 create without reading current metadata', async function () {
        const made = prepare();

        await makeApply(() => true)(namedRow(1), made.ctx);

        assert.deepStrictEqual(made.data, ['LIST|4|2|Friends|People I know||nA']);
        assert.strictEqual(made.metaReads(), 0);
    });
});
