'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const { UNARMED }       = require('../../../src/protocol_changes/core');

const VALID = 1;

function makeDb(state) {
    const config  = getTestConfig();
    const util    = new Utility();
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'test', 'test', 'test', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query: sinon.stub().resolves([]), release: sinon.stub().resolves()
    }) };
    sinon.stub(db, 'getStatusId').callsFake(async name => name === 'valid' ? VALID : 2);
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        if (/FROM contract_delegations d\b/.test(sql)) return state.delegation ? [state.delegation] : [];
        if (/SELECT action_index, signing_pubkey_id FROM contract_stakes/.test(sql)) {
            if (/deactivation_block > \?/.test(sql) && state.stake.deactivation_block > args[4])
                return [{ action_index: state.stake.action_index, signing_pubkey_id: state.stake.signing_pubkey_id }];
            return [];
        }
        if (/SELECT action_index, signing_pubkey_id FROM contract_unstakes/.test(sql))
            return [{ action_index: state.unstake.action_index, signing_pubkey_id: state.unstake.signing_pubkey_id }];
        if (/^UPDATE contract_stakes SET signing_pubkey_id/.test(sql)) {
            state.stake.signing_pubkey_id = args[0];
            return [];
        }
        if (/^UPDATE contract_unstakes SET signing_pubkey_id/.test(sql)) {
            state.unstake.signing_pubkey_id = args[0];
            return [];
        }
        if (/^\s*INSERT INTO contract_delegation_rotations/.test(sql)) return [];
        if (/FROM contract_delegation_rotations r/.test(sql))
            return args[0] === 'contract_stakes' ? (state.rotations || []) : [];
        if (/JOIN contract_unstakes/.test(sql)) return [];
        if (/FROM contract_stakes cs/.test(sql)) {
            if (state.stake.activation_block > args[2] || state.stake.deactivation_block <= args[3]) return [];
            return [Object.assign({}, state.stake, {
                pubkey: state.stake.signing_pubkey_id === 77 ? 'bb' : 'aa', tick: 'XCHAIN'
            })];
        }
        if (/FROM contract_unstakes cu/.test(sql)) return [Object.assign({}, state.unstake)];
        return [];
    });
    return db;
}

function state() {
    return {
        delegation: {
            action_index: 900, source_id: 5, signing_pubkey_id: 77,
            target_contract_index: 42, tick_id: 20
        },
        stake: {
            action_index: 100, source_id: 5, signing_pubkey_id: 11,
            target_contract_index: 42, tick_id: 20, amount: '10',
            activation_block: 100, deactivation_block: 312, status_id: VALID
        },
        unstake: {
            action_index: 200, source_id: 5, signing_pubkey_id: 11,
            target_contract_index: 42, tick_id: 20, amount: '10',
            block_index: 306, status_id: VALID
        }
    };
}

afterEach(function () {
    sinon.restore();
});

describe('DELEGATION_ROTATE_IN_WINDOW protocol row @regression @tier1', function () {
    it('ships unarmed and supports the regtest drill override', function () {
        const saved = process.env.DELEGATION_ROTATE_IN_WINDOW_REGTEST_TIME;
        delete process.env.DELEGATION_ROTATE_IN_WINDOW_REGTEST_TIME;
        const row = require('../../../src/protocol_changes/changes_5')
            .find(([name]) => name === 'DELEGATION_ROTATE_IN_WINDOW');
        assert.ok(row);
        assert.strictEqual(row[2], UNARMED);
        assert.strictEqual(row[3], UNARMED);
        assert.strictEqual(row[4](), UNARMED);
        process.env.DELEGATION_ROTATE_IN_WINDOW_REGTEST_TIME = '1000';
        assert.strictEqual(row[4](), 1000);
        if(saved === undefined) delete process.env.DELEGATION_ROTATE_IN_WINDOW_REGTEST_TIME;
        else process.env.DELEGATION_ROTATE_IN_WINDOW_REGTEST_TIME = saved;
    });
});

describe('Utility.processContractDelegationMaterializations() in-window gate @regression @tier1', function () {
    it('passes the new flag decision to the database sweep', async function () {
        const util = new Utility();
        const isEnabled = sinon.stub();
        isEnabled.withArgs('CONTRACT_DELEGATION_MATERIALIZE', 306).resolves(true);
        isEnabled.withArgs('DELEGATION_ROTATE_IN_WINDOW', 306).resolves(false);
        const db = { materializeContractDelegations: sinon.stub().resolves([]) };

        await util.processContractDelegationMaterializations({ protocolChanges: { isEnabled } }, db, 306);

        assert.ok(db.materializeContractDelegations.calledOnceWithExactly(306, undefined, false));
    });
});

describe('DELEGATE rotation during the UNSTAKE window @regression @tier1', function () {
    it('keeps the historical selection below the flag day', async function () {
        const model = state();
        const db = makeDb(model);

        await db.materializeContractDelegations(306, undefined, false);
        const snapshot = await db.getContractStakeDataForVM(42, 306, true);

        assert.strictEqual(model.stake.signing_pubkey_id, 11);
        assert.strictEqual(model.unstake.signing_pubkey_id, 77);
        assert.strictEqual(snapshot.stakeByPubkeyTick['bb|XCHAIN'], undefined);
        assert.strictEqual(String(snapshot.stakeByPubkeyTick['aa|XCHAIN']), '0');
    });

    it('rotates the visible stake row and keeps getContractStakeDataForVM aligned with cooldown stake', async function () {
        const model = state();
        const db = makeDb(model);

        const applied = await db.materializeContractDelegations(306, undefined, true);
        const snapshot = await db.getContractStakeDataForVM(42, 306, true);

        assert.deepStrictEqual(applied.map(row => row.target_table), ['contract_stakes', 'contract_unstakes']);
        assert.strictEqual(model.stake.signing_pubkey_id, 77);
        assert.strictEqual(model.unstake.signing_pubkey_id, 77);
        assert.strictEqual(String(snapshot.stakeByPubkeyTick['bb|XCHAIN']), '10');
        assert.strictEqual(snapshot.stakeByPubkeyTick['aa|XCHAIN'], undefined);
    });

    it('does not rotate a stake row at its deactivation height', async function () {
        const model = state();
        model.stake.deactivation_block = 306;
        const db = makeDb(model);

        await db.materializeContractDelegations(306, undefined, true);

        assert.strictEqual(model.stake.signing_pubkey_id, 11);
        assert.strictEqual(model.unstake.signing_pubkey_id, 77);
    });

    it('reverts an in-window row when its delegation is no longer governing', async function () {
        const model = state();
        model.delegation = null;
        model.stake.signing_pubkey_id = 77;
        model.rotations = [{
            stake_action_index: 100, delegation_action_index: 900,
            original_pubkey_id: 11, current_pubkey_id: 77,
            target_contract_index: 42, source_id: 5, tick_id: 20
        }];
        const db = makeDb(model);

        await db.materializeContractDelegations(306, undefined, true);

        assert.strictEqual(model.stake.signing_pubkey_id, 11);
    });
});
