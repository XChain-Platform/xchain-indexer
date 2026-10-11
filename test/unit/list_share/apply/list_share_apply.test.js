'use strict';

const assert = require('assert');
const path = require('path');
const H = require('../helpers/apply_harness.js');
const {
    ListShareHaltError,
    LIST_SHARE_HALT_REASON,
} = require('../../../../src/consensus/list_share_settle/halt.js');

const vectors = require(path.resolve(
    __dirname,
    '../../../../../xchain-documentation/protocol/test-vectors/list_share.json'
));
const versions = vectors.canonicals;
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function requireListShare(armed){
    const twin = require.resolve('../../../../src/consensus/gates/mirror_admission_gate.js');
    const entry = require.resolve('../../../../src/consensus/list_share_settle.js');
    const saved = [[twin, require.cache[twin]], [entry, require.cache[entry]]];
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    if(armed) process.env.XC_MIRROR_ADMISSION_ACTIVATION = 'armed';
    else delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
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

const armed = requireListShare(true);
const inert = requireListShare(false);

function vectorRows(overrides = {}){
    return versions.map((version, index) => H.makeListSnapshotRow({
        seq: version.seq,
        added: version.seq === 1 ? version.members : version.added,
        removed: version.removed || [],
        members: version.seq === 1 ? version.members : version.prev
            .filter(member => !version.removed.includes(member))
            .concat(version.added).sort(byBytes),
        membersHash: version.members_hash,
        listType: version.list_type,
        homeListIndex: version.home_list_index,
        snapshotBlock: version.snapshot_block,
        admit: { btc: 900 + index },
        ...overrides,
    })).map((row, index) => Object.assign(row, {
        origin_block: versions[index].origin_block,
        finalizing_view: versions[index].view,
    }));
}

function signedRows(rows, keys){
    return H.signListRows(rows, keys, armed.listShareCanonical);
}

function haltReason(reason){
    return error => error instanceof ListShareHaltError && error.reason === reason;
}

function noWriteState(state){
    assert.deepStrictEqual(state.injected, []);
    assert.deepStrictEqual(state.mirrors, []);
    assert.deepStrictEqual(state.settlements, []);
    assert.deepStrictEqual(state.actions, []);
}

function registerGateTests(){
    it('does no read or write while mirror admission is unarmed', async function () {
        const { ctx, state } = H.makeListShareCtx({ mirrorRows: vectorRows() });
        ctx.indexerDb.mirrorDb = () => { throw new Error('mirror read'); };
        assert.deepStrictEqual(await inert.processListSharePass(ctx), { applied: [] });
        noWriteState(state);
    });

    it('does no read or write while the list consumer gate is unarmed', async function () {
        const { ctx, state } = H.makeListShareCtx({ mirrorRows: vectorRows() });
        ctx.network = 'testnet';
        ctx.config.NETWORK = 'testnet';
        ctx.blockIndex = 154614;
        ctx.indexerDb.mirrorDb = () => { throw new Error('mirror read'); };
        assert.deepStrictEqual(await armed.processListSharePass(ctx), { applied: [] });
        noWriteState(state);
    });
}

function registerApplyTests(){
    it('creates the fixture full list under the home bridge owner and records it', async function () {
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const [full] = signedRows(vectorRows().slice(0, 1), keys);
        const { ctx, state } = H.makeListShareCtx({
            mirrorRows: [full],
            validators: H.snapshotSet(keys),
            blockIndex: 900,
        });

        assert.deepStrictEqual(await armed.processListSharePass(ctx), {
            applied: [full.snapshot_id],
        });
        assert.strictEqual(state.injected.length, 1);
        assert.strictEqual(state.injected[0].isGenesis, true);
        assert.strictEqual(state.injected[0].tx.vout, 0);
        assert.strictEqual(state.injected[0].tx.source, H.BRIDGE_DOGE_ON_BTC);
        assert.strictEqual(state.mirrors.length, 1);
        assert.strictEqual(state.settlements.length, 1);
        assert.strictEqual(state.settlements[0].kind, 'list');
        assert.strictEqual(state.settlements[0].transfer_id, full.snapshot_id);
        const index = state.mirrors[0].action_index;
        assert.deepStrictEqual(await ctx.indexerDb.getList(index, 900), versions[0].members);
    });

    it('injects the fixture delta as REMOVE vout 0 then ADD vout 1', async function () {
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const rows = signedRows(vectorRows(), keys);
        const { ctx, state } = H.makeListShareCtx({
            mirrorRows: rows,
            validators: H.snapshotSet(keys),
            blockIndex: 901,
        });

        await armed.processListSharePass(ctx);
        assert.deepStrictEqual(state.injected.map(item => item.tx.vout), [0, 0, 1]);
        assert.deepStrictEqual(state.injected[1].tx.data.split('|').slice(0, 5),
            ['LIST', '1', '2', String(state.mirrors[0].action_index), '']);
        assert.deepStrictEqual(state.injected[2].tx.data.split('|').slice(0, 5),
            ['LIST', '1', '1', String(state.mirrors[0].action_index), '']);
        assert.deepStrictEqual(
            await ctx.indexerDb.getList(state.mirrors[0].action_index, 901),
            ['ltc1qmemberbeta', 'nmembergamma']
        );
        assert.strictEqual(state.settlements.length, 2);
    });
}

function registerValidationTests(){
    it('halts on a members hash mismatch before injecting or recording', async function () {
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const [row] = vectorRows();
        row.members_hash = '0'.repeat(64);
        const [signed] = signedRows([row], keys);
        const { ctx, state } = H.makeListShareCtx({
            mirrorRows: [signed], validators: H.snapshotSet(keys), blockIndex: 900,
        });
        await assert.rejects(armed.processListSharePass(ctx),
            haltReason(LIST_SHARE_HALT_REASON.MEMBERS_HASH));
        noWriteState(state);
    });

    it('re-reads the injected mirror and halts before recording a bad result', async function () {
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const [row] = signedRows(vectorRows().slice(0, 1), keys);
        const { ctx, state } = H.makeListShareCtx({
            mirrorRows: [row], validators: H.snapshotSet(keys), blockIndex: 900,
        });
        let nextAction = 7000;
        ctx.actions.processTransaction = async (tx, isGenesis) => {
            state.injected.push({ tx, isGenesis });
            return { ACTION_INDEX: nextAction++, STATUS: 'valid' };
        };

        await assert.rejects(armed.processListSharePass(ctx),
            haltReason(LIST_SHARE_HALT_REASON.MEMBERS_HASH));
        assert.strictEqual(state.injected.length, 1);
        assert.strictEqual(state.mirrors.length, 1);
        assert.deepStrictEqual(state.settlements, []);
    });

    it('records an empty delta through a LIST_SHARE action anchor', async function () {
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const [full] = vectorRows();
        const empty = H.makeListSnapshotRow({
            seq: 2,
            added: [],
            removed: [],
            members: versions[0].members,
            membersHash: versions[0].members_hash,
            listType: versions[0].list_type,
            homeListIndex: versions[0].home_list_index,
            snapshotBlock: versions[0].snapshot_block,
            admit: { btc: 901 },
        });
        const rows = signedRows([full, empty], keys);
        const { ctx, state } = H.makeListShareCtx({
            mirrorRows: rows, validators: H.snapshotSet(keys), blockIndex: 901,
        });

        await armed.processListSharePass(ctx);
        assert.strictEqual(state.injected.length, 1);
        assert.deepStrictEqual(state.actions, [{ ACTION: 'LIST_SHARE', BLOCK_INDEX: 901, FORMAT: 0 }]);
        assert.deepStrictEqual(state.settlements.map(row => row.action_index), [7000, 7001]);
    });
}

function registerGuardTests(){
    it('halts on a failed quorum before injecting or recording', async function () {
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const [row] = vectorRows();
        const { ctx, state } = H.makeListShareCtx({
            mirrorRows: [row], validators: H.snapshotSet(keys), blockIndex: 900,
        });
        await assert.rejects(armed.processListSharePass(ctx),
            haltReason(LIST_SHARE_HALT_REASON.QUORUM));
        noWriteState(state);
    });

    it('halts on an absent capability snapshot before injecting or recording', async function () {
        const keys = [H.makeKey()];
        const [row] = signedRows(vectorRows().slice(0, 1), keys);
        const { ctx, state } = H.makeListShareCtx({ mirrorRows: [row], blockIndex: 900 });
        await assert.rejects(armed.processListSharePass(ctx),
            haltReason(LIST_SHARE_HALT_REASON.SNAPSHOT_ABSENT));
        noWriteState(state);
    });

    it('halts on a sequence gap before applying a later row', async function () {
        const keys = [H.makeKey()];
        const [row] = signedRows(vectorRows().slice(1), keys);
        const { ctx, state } = H.makeListShareCtx({
            mirrorRows: [row], validators: H.snapshotSet(keys), blockIndex: 901,
        });
        await assert.rejects(armed.processListSharePass(ctx),
            haltReason(LIST_SHARE_HALT_REASON.SEQ_GAP));
        noWriteState(state);
    });

    it('skips rows homed on the consuming chain', async function () {
        const [row] = vectorRows({ homeChain: 'BTC', homeListIndex: 88 });
        const { ctx, state } = H.makeListShareCtx({ mirrorRows: [row], blockIndex: 900 });
        assert.deepStrictEqual(await armed.processListSharePass(ctx), { applied: [] });
        noWriteState(state);
    });
}

describe('list share consuming-chain apply pass', function () {
    registerGateTests();
    registerApplyTests();
    registerValidationTests();
    registerGuardTests();
});
