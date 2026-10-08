/*
 * test/unit/db/stakes/db_stake_snapshot_slash_window.test.js
 *
 * STAKE_SNAPSHOT_SLASH_WINDOW: a slash inside the unstake activation-delay window debits the
 * contract_unstakes cooldown row, so the snapshot must stop counting the slashed amount on
 * an armed chain and keep the legacy figure on an unarmed one.
 *
 * Activation is decided by the callers through ProtocolChanges.isEnabled, which reads the
 * decoder DB's time for the block. The indexer DB has no blocks row for the block being
 * processed until finalizeBlock, so its getBlockTime answers false here, as it does live.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');
const protocolChanges   = require('../../../../src/protocol_changes');

const ROW = 'protocol_changes.changes.STAKE_SNAPSHOT_SLASH_WINDOW';
const ENV = 'STAKE_SNAPSHOT_SLASH_WINDOW_REGTEST_TIME';

// Decide activation exactly as both VM-snapshot callers do, with the decoder DB stamping
// the block at blockTime; regtestTime arms the regtest row through its env override.
async function slashWindowActive(network, regtestTime, blockTime = 2000) {
    const saved = process.env[ENV];
    if (regtestTime === undefined) delete process.env[ENV];
    else process.env[ENV] = String(regtestTime);
    try {
        const pc = new protocolChanges({ config: { NETWORK: network }, util: new Utility(),
            decoderDb: { getBlockTime: async () => blockTime }, indexerDb: {} });
        return await pc.isEnabled('STAKE_SNAPSHOT_SLASH_WINDOW', 100);
    } finally {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    }
}

function makeDb(network) {
    const config  = Object.assign({}, getTestConfig(), { NETWORK: network, COIN: 'BTC' });
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
    // The in-block state: the indexer blocks row for the current height is not written yet.
    sinon.stub(db, 'getBlockTime').resolves(false);
    // cooldown holds what is left after a slash of 40 against an unstaked 100; the UNSTAKE ran
    // at block 494, so its window closes at deactivation_block 500 under the delay of 6
    sinon.stub(db, 'doQuery').callsFake(async (q) => {
        if (/JOIN contract_unstakes/.test(q)) return [];
        if (/FROM contract_stakes/.test(q))
            return [{ action_index: 7, signing_pubkey_id: 5, pubkey: 'AA', tick_id: 3, tick: 'XCHAIN',
                      amount: '100', activation_block: 1, deactivation_block: 500 }];
        if (/FROM contract_unstakes/.test(q))
            return [{ signing_pubkey_id: 5, tick_id: 3, block_index: 494, amount: '60' }];
        return [];
    });
    return db;
}

afterEach(function () { sinon.restore(); });

describe('getContractStakeDataForVM() slash-window cap @regression @tier1', function () {
    it('armed: a slash inside the window lowers the stake the snapshot shows', async function () {
        const active = await slashWindowActive('regtest', 1000);
        assert.strictEqual(active, true);
        const db   = makeDb('regtest');
        const snap = await db.getContractStakeDataForVM(1, 100, active);
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '60');
        assert.strictEqual(String(snap.totalByTick['XCHAIN']), '60');
        // Never read the indexer's own block time: that row does not exist mid-block.
        assert.strictEqual(db.getBlockTime.callCount, 0);
    });

    it('armed: an unslashed window row is unchanged', async function () {
        const db = makeDb('regtest');
        db.doQuery.callsFake(async (q) => /JOIN contract_unstakes/.test(q) ? [] : /FROM contract_stakes/.test(q)
            ? [{ action_index: 7, signing_pubkey_id: 5, pubkey: 'AA', tick_id: 3, tick: 'XCHAIN', amount: '100', activation_block: 1, deactivation_block: 500 }]
            : [{ signing_pubkey_id: 5, tick_id: 3, block_index: 494, amount: '100' }]);
        const snap = await db.getContractStakeDataForVM(1, 100, await slashWindowActive('regtest', 1000));
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100');
    });

    it('unarmed (regtest env unset): legacy snapshot keeps the full row amount', async function () {
        const active = await slashWindowActive('regtest');
        assert.strictEqual(active, false);
        const snap = await makeDb('regtest').getContractStakeDataForVM(1, 100, active);
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100');
    });

    it('unarmed (testnet and mainnet ship inert): legacy snapshot', async function () {
        for (const net of ['testnet', 'mainnet']) {
            const active = await slashWindowActive(net, 1000);
            assert.strictEqual(active, false, net);
            const snap = await makeDb(net).getContractStakeDataForVM(1, 100, active);
            assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100', net);
            sinon.restore();
        }
    });

    it('armed but block time before the flag day: legacy snapshot', async function () {
        const active = await slashWindowActive('regtest', 5000);
        assert.strictEqual(active, false);
        const snap = await makeDb('regtest').getContractStakeDataForVM(1, 100, active);
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100');
    });
});

describe('STAKE_SNAPSHOT_SLASH_WINDOW registry row @regression @tier1', function () {
    it('ships UNARMED on mainnet and testnet', function () {
        const row = protocolChanges.get(ROW);
        assert.strictEqual(row.mainnet_time, protocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, protocolChanges.UNARMED);
    });
});

describe('slashContractStake then snapshot @regression @tier1', function () {
    function statefulDb(network) {
        const db = makeDb(network);
        const stakes   = [{ action_index: 7, signing_pubkey_id: 5, pubkey: 'AA', tick_id: 3, tick: 'XCHAIN',
                            amount: '100', activation_block: 1, deactivation_block: 500, source_address: 'addr' }];
        const unstakes = [{ action_index: 8, signing_pubkey_id: 5, tick_id: 3, block_index: 494, amount: '100', source_address: 'addr' }];
        db.createContractSlashDebit = sinon.stub().resolves();
        db.doQuery.callsFake(async (q, params) => {
            if (/^UPDATE contract_unstakes/.test(q)) { unstakes.find(r => r.action_index === params[1]).amount = params[0]; return []; }
            if (/^UPDATE contract_stakes/.test(q))   { stakes.find(r => r.action_index === params[1]).amount = params[0]; return []; }
            if (/ORDER BY cs.action_index DESC/.test(q) || /JOIN contract_unstakes/.test(q)) return [];
            if (/FROM contract_stakes/.test(q))   return stakes.map(r => Object.assign({}, r));
            if (/FROM contract_unstakes/.test(q)) return unstakes.map(r => Object.assign({}, r));
            return [];
        });
        return db;
    }

    it('armed: the slash debits the cooldown row and the snapshot shows the remainder', async function () {
        const db  = statefulDb('regtest');
        const res = await db.slashContractStake(1, 5, 3, '40', 100, 1, 0);
        assert.strictEqual(res.total, '40');
        const snap = await db.getContractStakeDataForVM(1, 100, await slashWindowActive('regtest', 1000));
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '60');
    });

    it('unarmed: the same slash leaves the legacy snapshot figure', async function () {
        const db  = statefulDb('regtest');
        const res = await db.slashContractStake(1, 5, 3, '40', 100, 1, 0);
        assert.strictEqual(res.total, '40');
        const snap = await db.getContractStakeDataForVM(1, 100, await slashWindowActive('regtest'));
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100');
    });
});

// A row-level model of the contract_stakes and contract_unstakes reads the snapshot and
// slashContractStake issue, applying each query's own predicates to the fixture rows.
// BTC regtest delay is 6, so an UNSTAKE at block U sweeps rows to deactivation_block U + 6.
function modelDb(stakes, unstakes) {
    const db = makeDb('regtest');
    db.createContractSlashDebit = sinon.stub().resolves();
    const live = (r, b) => r.activation_block <= b && (r.deactivation_block === null || r.deactivation_block > b);
    const copy = (rows) => rows.map(r => Object.assign({ pubkey: 'AA', tick: 'XCHAIN', source_address: 'addr' }, r));
    db.doQuery.callsFake(async (q, params) => {
        if (/^UPDATE contract_unstakes/.test(q)) { unstakes.find(r => r.action_index === params[1]).amount = params[0]; return []; }
        if (/^UPDATE contract_stakes/.test(q))   { stakes.find(r => r.action_index === params[1]).amount = params[0]; return []; }
        if (/JOIN contract_unstakes/.test(q))
            return copy(stakes.filter(r => r.deactivation_block === null && r.activation_block > params[2]
                && unstakes.some(u => u.action_index === r.action_index)));
        if (/ORDER BY cs.action_index DESC/.test(q))
            return copy(stakes.filter(r => r.deactivation_block === null && Number(r.amount) > 0).sort((a, b) => b.action_index - a.action_index));
        if (/ORDER BY cu.action_index DESC/.test(q))
            return copy(unstakes.filter(r => r.status_id !== 3 && Number(r.amount) > 0).sort((a, b) => b.action_index - a.action_index));
        if (/FROM contract_stakes/.test(q)) return copy(stakes.filter(r => live(r, params[2])));
        if (/FROM contract_unstakes/.test(q)) return copy(unstakes.filter(r => params.slice(1).includes(r.status_id)));
        return [];
    });
    return db;
}

async function armedStake(db, blockIndex) {
    const snap = await db.getContractStakeDataForVM(1, blockIndex, await slashWindowActive('regtest', 1000));
    return String(snap.stakeByPubkeyTick['aa|XCHAIN'] || '0');
}

// Full UNSTAKE of 100 at block 10, a re-STAKE of 50, then a full UNSTAKE of it at block 200.
function sequentialUnstakes() {
    return modelDb(
        [{ action_index: 1, signing_pubkey_id: 5, tick_id: 3, amount: '100', activation_block: 1,   deactivation_block: 16 },
         { action_index: 3, signing_pubkey_id: 5, tick_id: 3, amount: '50',  activation_block: 106, deactivation_block: 206 }],
        [{ action_index: 2, signing_pubkey_id: 5, tick_id: 3, amount: '100', block_index: 10,  status_id: 1 },
         { action_index: 4, signing_pubkey_id: 5, tick_id: 3, amount: '50',  block_index: 200, status_id: 1 }]);
}

// Partial UNSTAKE of 30 out of 100 at block 1000: the residual 70 re-stakes under the
// UNSTAKE's own action_index and activates when the swept row deactivates.
function partialUnstake(cooldownStatus = 1, extraStakes = []) {
    return modelDb(
        [{ action_index: 1, signing_pubkey_id: 5, tick_id: 3, amount: '100', activation_block: 1,    deactivation_block: 1006 },
         { action_index: 2, signing_pubkey_id: 5, tick_id: 3, amount: '70',  activation_block: 1006, deactivation_block: null },
         ...extraStakes],
        [{ action_index: 2, signing_pubkey_id: 5, tick_id: 3, amount: '30',  block_index: 1000, status_id: cooldownStatus }]);
}

describe('slash-window cap scoped to the UNSTAKE that opened the window @regression @tier1', function () {
    it('armed: an older open cooldown does not hide a slash on the newer window', async function () {
        const db = sequentialUnstakes();
        assert.strictEqual(await armedStake(db, 201), '50');
        const res = await db.slashContractStake(1, 5, 3, '50', 201, 1, 0);
        assert.strictEqual(res.total, '50');
        assert.strictEqual(await armedStake(db, 201), '0');
    });

    it('armed: two windows open at once are each capped by their own cooldown', async function () {
        const db = modelDb(
            [{ action_index: 1, signing_pubkey_id: 5, tick_id: 3, amount: '100', activation_block: 1,   deactivation_block: 206 },
             { action_index: 2, signing_pubkey_id: 5, tick_id: 3, amount: '40',  activation_block: 205, deactivation_block: 211 }],
            [{ action_index: 3, signing_pubkey_id: 5, tick_id: 3, amount: '100', block_index: 200, status_id: 1 },
             { action_index: 4, signing_pubkey_id: 5, tick_id: 3, amount: '40',  block_index: 205, status_id: 1 }]);
        assert.strictEqual(await armedStake(db, 205), '140');
        await db.slashContractStake(1, 5, 3, '40', 205, 1, 0);
        assert.strictEqual(await armedStake(db, 205), '100');
    });

    it('armed: an in-window row whose UNSTAKE left no open cooldown shows nothing', async function () {
        const db = modelDb(
            [{ action_index: 1, signing_pubkey_id: 5, tick_id: 3, amount: '100', activation_block: 1, deactivation_block: 206 }],
            [{ action_index: 2, signing_pubkey_id: 5, tick_id: 3, amount: '100', block_index: 10, status_id: 1 }]);
        assert.strictEqual(await armedStake(db, 201), '0');
    });
});

describe('slash-window cap counts a partial UNSTAKE residual @regression @tier1', function () {
    it('armed: an unslashed partial UNSTAKE shows the full stake, as unarmed does', async function () {
        assert.strictEqual(await armedStake(partialUnstake(), 1003), '100');
        const snap = await partialUnstake().getContractStakeDataForVM(1, 1003, await slashWindowActive('regtest'));
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100');
    });

    it('armed: a slash that lands on the pending residual is visible', async function () {
        const db = partialUnstake();
        await db.slashContractStake(1, 5, 3, '50', 1003, 1, 0);
        assert.strictEqual(await armedStake(db, 1003), '50');
    });

    it('armed: a slash through the residual into the cooldown is visible', async function () {
        const db = partialUnstake();
        const res = await db.slashContractStake(1, 5, 3, '90', 1003, 1, 0);
        assert.strictEqual(res.total, '90');
        assert.strictEqual(await armedStake(db, 1003), '10');
    });

    it('armed: the residual still counts after its cooldown was already refunded', async function () {
        assert.strictEqual(await armedStake(partialUnstake(3), 1003), '70');
    });

    it('armed: a fresh STAKE still inside its activation delay stays hidden', async function () {
        const topUp = { action_index: 9, signing_pubkey_id: 5, tick_id: 3, amount: '25', activation_block: 1008, deactivation_block: null };
        assert.strictEqual(await armedStake(partialUnstake(1, [topUp]), 1003), '100');
    });

    it('unarmed: the residual lookup is never issued', async function () {
        const db = partialUnstake();
        await db.getContractStakeDataForVM(1, 1003, await slashWindowActive('regtest'));
        assert.ok(db.doQuery.getCalls().every(c => !/JOIN contract_unstakes/.test(c.args[0])));
    });
});
