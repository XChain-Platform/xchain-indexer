/*
 * test/unit/db/stakes/db_stake_snapshot_slash_window.test.js
 *
 * STAKE_SNAPSHOT_SLASH_WINDOW: a slash inside the unstake activation-delay window debits the
 * contract_unstakes cooldown row, so the snapshot must stop counting the slashed amount on
 * an armed chain and keep the legacy figure on an unarmed one.
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

function makeDb(network, armedAt) {
    const config  = Object.assign({}, getTestConfig(), { NETWORK: network, COIN: 'BTC' });
    const row     = Object.assign({}, protocolChanges.get(ROW));
    if (armedAt !== undefined) row[network + '_time'] = armedAt;
    sinon.stub(protocolChanges, 'get').callsFake((key) => (key === ROW ? row : protocolChanges.get.wrappedMethod(key)));
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
    sinon.stub(db, 'getBlockTime').resolves(2000);
    // cooldown holds what is left after a slash of 40 against an unstaked 100
    sinon.stub(db, 'doQuery').callsFake(async (q) => {
        if (/FROM contract_stakes/.test(q))
            return [{ action_index: 7, signing_pubkey_id: 5, pubkey: 'AA', tick_id: 3, tick: 'XCHAIN',
                      amount: '100', activation_block: 1, deactivation_block: 500 }];
        if (/FROM contract_unstakes/.test(q))
            return [{ signing_pubkey_id: 5, tick_id: 3, amount: '60' }];
        return [];
    });
    return db;
}

afterEach(function () { sinon.restore(); });

describe('getContractStakeDataForVM() slash-window cap @regression @tier1', function () {
    it('armed: a slash inside the window lowers the stake the snapshot shows', async function () {
        const snap = await makeDb('regtest', 1000).getContractStakeDataForVM(1, 100);
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '60');
        assert.strictEqual(String(snap.totalByTick['XCHAIN']), '60');
    });

    it('armed: an unslashed window row is unchanged', async function () {
        const db = makeDb('regtest', 1000);
        db.doQuery.callsFake(async (q) => /FROM contract_stakes/.test(q)
            ? [{ action_index: 7, signing_pubkey_id: 5, pubkey: 'AA', tick_id: 3, tick: 'XCHAIN', amount: '100', activation_block: 1, deactivation_block: 500 }]
            : [{ signing_pubkey_id: 5, tick_id: 3, amount: '100' }]);
        const snap = await db.getContractStakeDataForVM(1, 100);
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100');
    });

    it('unarmed (regtest env unset): legacy snapshot keeps the full row amount', async function () {
        const snap = await makeDb('regtest').getContractStakeDataForVM(1, 100);
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100');
    });

    it('unarmed (testnet and mainnet ship inert): legacy snapshot', async function () {
        for (const net of ['testnet', 'mainnet']) {
            const snap = await makeDb(net).getContractStakeDataForVM(1, 100);
            assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100', net);
            sinon.restore();
        }
    });

    it('armed but block time before the flag day: legacy snapshot', async function () {
        const snap = await makeDb('regtest', 5000).getContractStakeDataForVM(1, 100);
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
    function statefulDb(network, armedAt) {
        const db = makeDb(network, armedAt);
        const stakes   = [{ action_index: 7, signing_pubkey_id: 5, pubkey: 'AA', tick_id: 3, tick: 'XCHAIN',
                            amount: '100', activation_block: 1, deactivation_block: 500, source_address: 'addr' }];
        const unstakes = [{ action_index: 8, signing_pubkey_id: 5, tick_id: 3, amount: '100', source_address: 'addr' }];
        db.createContractSlashDebit = sinon.stub().resolves();
        db.doQuery.callsFake(async (q, params) => {
            if (/^UPDATE contract_unstakes/.test(q)) { unstakes.find(r => r.action_index === params[1]).amount = params[0]; return []; }
            if (/^UPDATE contract_stakes/.test(q))   { stakes.find(r => r.action_index === params[1]).amount = params[0]; return []; }
            if (/ORDER BY cs.action_index DESC/.test(q)) return [];
            if (/FROM contract_stakes/.test(q))   return stakes.map(r => Object.assign({}, r));
            if (/FROM contract_unstakes/.test(q)) return unstakes.map(r => Object.assign({}, r));
            return [];
        });
        return db;
    }

    it('armed: the slash debits the cooldown row and the snapshot shows the remainder', async function () {
        const db  = statefulDb('regtest', 1000);
        const res = await db.slashContractStake(1, 5, 3, '40', 100, 1, 0);
        assert.strictEqual(res.total, '40');
        const snap = await db.getContractStakeDataForVM(1, 100);
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '60');
    });

    it('unarmed: the same slash leaves the legacy snapshot figure', async function () {
        const db  = statefulDb('regtest');
        const res = await db.slashContractStake(1, 5, 3, '40', 100, 1, 0);
        assert.strictEqual(res.total, '40');
        const snap = await db.getContractStakeDataForVM(1, 100);
        assert.strictEqual(String(snap.stakeByPubkeyTick['aa|XCHAIN']), '100');
    });
});
