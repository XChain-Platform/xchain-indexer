'use strict';

const assert = require('assert');
const path = require('path');
const sinon = require('sinon');

const H = require('./helpers/apply_harness.js');
const gateRegistry = require('../../../src/consensus/gate_registry.js');
const { listMembershipHash } = require('../../../src/consensus/list_share_hash.js');
const {
    ListShareHaltError,
    LIST_SHARE_HALT_REASON,
} = require('../../../src/consensus/list_share_settle/halt.js');

const fixture = require(path.resolve(
    __dirname,
    '../../fixtures/list_share_ticker_mirror.json'
));
const TICK_GATE = 'list_tick_coin_activation.LIST_TICK_COIN_ACTIVATION';

function requireListShare(){
    const twin = require.resolve('../../../src/consensus/gates/mirror_admission_gate.js');
    const entry = require.resolve('../../../src/consensus/list_share_settle.js');
    const saved = [[twin, require.cache[twin]], [entry, require.cache[entry]]];
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = 'armed';
    delete require.cache[twin];
    delete require.cache[entry];
    try {
        return require(entry);
    } finally {
        for(const [file, cached] of saved){
            if(cached === undefined) delete require.cache[file];
            else require.cache[file] = cached;
        }
        if(savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
}

const listShare = requireListShare();

function signedRows(keys){
    const rows = fixture.versions.map((version, index) => H.makeListSnapshotRow({
        seq: version.seq,
        added: version.added,
        removed: version.removed,
        members: version.members,
        membersHash: version.members_hash,
        listType: fixture.list_type,
        admit: { btc: 900 + index },
    }));
    return H.signListRows(rows, keys, listShare.listShareCanonical);
}

function stubTickGate(active){
    const original = gateRegistry.activeAt;
    return sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
        key === TICK_GATE ? active : original(key, ...args));
}

function isMembersHashHalt(error){
    return error instanceof ListShareHaltError &&
        error.reason === LIST_SHARE_HALT_REASON.MEMBERS_HASH;
}

describe('list share ticker apply pass', function () {
    afterEach(function () { sinon.restore(); });

    it('stores full and delta ticker membership exactly as signed', async function () {
        stubTickGate(true);
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const rows = signedRows(keys);
        const { ctx, state } = H.makeListShareCtx({
            mirrorRows: rows,
            validators: H.snapshotSet(keys),
            blockIndex: 900,
            tickerRows: fixture.preinterned,
        });

        assert.deepStrictEqual(await listShare.processListSharePass(ctx), {
            applied: [rows[0].snapshot_id],
        });
        assert.strictEqual(state.mirrors.length, 1);
        const mirrorIndex = state.mirrors[0].action_index;
        assert.strictEqual(state.lists.get(mirrorIndex).owner, H.BRIDGE_DOGE_ON_BTC);
        assert.deepStrictEqual(await ctx.indexerDb.getList(mirrorIndex, 900),
            fixture.versions[0].members);
        assert.strictEqual(
            listMembershipHash(await ctx.indexerDb.getList(mirrorIndex, 900)),
            rows[0].members_hash
        );
        assert.strictEqual(state.tickers.some((row) => row.tick === 'doge:pepe'), true);
        assert.strictEqual(state.tickers.some((row) => row.tick === 'DOGE:PEPE'), true);
        assert.deepStrictEqual(state.tokenInfoCalls, []);

        ctx.blockIndex = 901;
        ctx.indexerDb.blockIndex = 901;
        assert.deepStrictEqual(await listShare.processListSharePass(ctx), {
            applied: [rows[1].snapshot_id],
        });
        assert.deepStrictEqual(await ctx.indexerDb.getList(mirrorIndex, 901),
            fixture.versions[1].members);
        assert.strictEqual(
            listMembershipHash(await ctx.indexerDb.getList(mirrorIndex, 901)),
            rows[1].members_hash
        );
        assert.deepStrictEqual(state.tokenInfoCalls, []);
    });

    it('halts before settlement when ticker qualification is unarmed', async function () {
        stubTickGate(false);
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const [row] = signedRows(keys);
        const { ctx, state, runInTransaction } = H.makeListShareCtx({
            mirrorRows: [row],
            validators: H.snapshotSet(keys),
            blockIndex: 900,
            tickerRows: fixture.preinterned,
        });
        const tickersBefore = state.tickers.map((ticker) => Object.assign({}, ticker));

        await assert.rejects(
            runInTransaction(() => listShare.processListSharePass(ctx)),
            isMembersHashHalt
        );
        assert.strictEqual(state.lists.size, 0);
        assert.deepStrictEqual(state.mirrors, []);
        assert.deepStrictEqual(state.settlements, []);
        assert.deepStrictEqual(state.settlementWrites, []);
        assert.deepStrictEqual(state.actions, []);
        assert.deepStrictEqual(state.tickers, tickersBefore);
        assert.deepStrictEqual(state.tokenInfoCalls, fixture.versions[0].added);
    });
});
