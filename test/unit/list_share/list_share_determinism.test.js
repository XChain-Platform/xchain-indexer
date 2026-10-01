'use strict';

const assert = require('assert');
const path = require('path');
const H = require('./helpers/apply_harness.js');

const vectors = require(path.resolve(
    __dirname,
    '../../../../xchain-documentation/protocol/test-vectors/list_share.json'
));
const versions = vectors.canonicals;
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function requireArmedListShare(){
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

const listShare = requireArmedListShare();

function signedFixtureRows(keys){
    const rows = versions.map((version, index) => H.makeListSnapshotRow({
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
    })).map((row, index) => Object.assign(row, {
        origin_block: versions[index].origin_block,
        finalizing_view: versions[index].view,
    }));
    return H.signListRows(rows, keys, listShare.listShareCanonical);
}

async function drive(rows, validators){
    const harness = H.makeListShareCtx({
        mirrorRows: rows,
        validators,
        blockIndex: 899,
        startAction: 7000,
    });
    const results = [];
    for(const block of [899, 900, 901, 902]){
        harness.ctx.blockIndex = block;
        results.push(await listShare.processListSharePass(harness.ctx));
    }
    const mirrorIndex = harness.state.mirrors[0].action_index;
    return {
        results,
        injected: harness.state.injected,
        actions: harness.state.actions,
        mirrors: harness.state.mirrors,
        settlements: harness.state.settlements,
        membership: await harness.ctx.indexerDb.getList(mirrorIndex, 902),
    };
}

describe('list share apply determinism', function () {
    it('reaches identical state in two fresh stores over the same blocks', async function () {
        const keys = [H.makeKey(), H.makeKey(), H.makeKey()];
        const rows = signedFixtureRows(keys);
        const validators = H.snapshotSet(keys);

        const first = await drive(rows, validators);
        const second = await drive(rows.map(row => ({ ...row })), validators.map(row => ({ ...row })));

        assert.deepStrictEqual(second, first);
        assert.deepStrictEqual(first.results.map(result => result.applied.length), [0, 1, 1, 0]);
        assert.deepStrictEqual(first.injected.map(item => item.tx.vout), [0, 0, 1]);
        assert.deepStrictEqual(first.mirrors, [{
            action_index: 7000,
            home_chain: 'DOGE',
            home_list_index: versions[0].home_list_index,
            block_index: 900,
        }]);
        assert.deepStrictEqual(first.settlements.map(row => row.action_index), [7000, 7002]);
        assert.deepStrictEqual(first.membership, ['ltc1qmemberbeta', 'nmembergamma']);
    });
});
