/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const observability = require('../../../src/observability/index.js');
const stakeWeights = require('../../../src/db/database/stake_weights.js');
const activeStake = require('../../../src/db/stakes/active_stake.js');
const capabilityMembership = require('../../../src/db/stakes/capability_membership.js');
const { buildCapabilitiesRpc } = require('../../../src/api/rpc/capabilities.js');
const { recordingView, fakeIndexer } = require('../api/rpc/helpers/fake_indexer.js');

const SNAPSHOT_BLOCK = 120;
const MIN_STAKE = '25';
const FILTERED_ROWS = [
    { pubkey: 'key-shared', source: 'source-a', weight: '40' },
    { pubkey: 'key-shared', source: 'source-b', weight: '70' },
    { pubkey: 'key-only', source: 'source-b', weight: '30' },
];
const ORACLE_ROWS = FILTERED_ROWS.concat([
    { pubkey: 'key-absent', source: 'source-absent', weight: '90' },
]);

function btcDb(){
    return {
        config: {
            COIN: 'BTC',
            NETWORK: 'regtest',
            STAKING: { CAPABILITIES: { oracle_publish: { MIN_STAKE: '10' } } },
        },
        util: { bcgt: (left, right) => BigInt(left) > BigInt(right) },
        getStakeWeightsByCapability: stakeWeights.getStakeWeightsByCapability,
        getValidatorsByCapability: activeStake.getValidatorsByCapability,
        getActiveCapabilityCount: activeStake.getActiveCapabilityCount,
        hasCapability: capabilityMembership.hasCapability,
        isCapabilityConfigured: stakeWeights.isCapabilityConfigured,
        getStatusId: sinon.stub().resolves(1),
        stakeWeightsWithCap: sinon.stub().callsFake(async function(){
            return { rows: ORACLE_ROWS.slice(), truncated: false };
        }),
        getLatestRolledRollcallAbsentSources: sinon.stub().resolves(['source-absent']),
    };
}

afterEach(function(){ sinon.restore(); });

describe('archive_publish BTC capability reads @regression @tier1', function(){
    it('derives weights, validators, distinct count and membership from the filtered set', async function(){
        let db = btcDb();

        let weights = await db.getStakeWeightsByCapability(
            'archive_publish', SNAPSHOT_BLOCK, MIN_STAKE);
        let validators = await db.getValidatorsByCapability(
            'archive_publish', SNAPSHOT_BLOCK, MIN_STAKE);
        let count = await db.getActiveCapabilityCount(
            'archive_publish', SNAPSHOT_BLOCK, MIN_STAKE);
        let member = await db.hasCapability(
            'KEY-SHARED', 'archive_publish', SNAPSHOT_BLOCK, MIN_STAKE);
        let absent = await db.hasCapability(
            'key-absent', 'archive_publish', SNAPSHOT_BLOCK, MIN_STAKE);

        assert.deepStrictEqual(weights, FILTERED_ROWS);
        assert.deepStrictEqual(validators, [
            { pubkey: 'key-shared', amount: '70' },
            { pubkey: 'key-only', amount: '30' },
        ]);
        assert.strictEqual(count, 2);
        assert.strictEqual(member, true);
        assert.strictEqual(absent, false);
        assert.strictEqual(db.stakeWeightsWithCap.callCount, 5);
        for(let call of db.stakeWeightsWithCap.getCalls())
            assert.strictEqual(call.args[2], MIN_STAKE);
        for(let call of db.getLatestRolledRollcallAbsentSources.getCalls())
            assert.deepStrictEqual(call.args, [SNAPSHOT_BLOCK]);
    });

    it('treats archive_publish as configured exactly when oracle_publish is configured', function(){
        let configured = btcDb();
        assert.strictEqual(configured.isCapabilityConfigured('archive_publish'), true);

        configured.config.STAKING.CAPABILITIES = {};
        assert.strictEqual(configured.isCapabilityConfigured('archive_publish'), false);
    });

    it('serves archive_publish through getstakeweightsbycapability without rewriting the key', async function(){
        sinon.stub(observability.getLogger(), 'info');
        let rows = FILTERED_ROWS.slice();
        let view = recordingView({
            isCapabilityConfigured: capability => capability === 'archive_publish',
            getLatestBlockIndex: 200,
            getStakeWeightsByCapability: rows,
        }, { sync: ['isCapabilityConfigured'] });
        let rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view }) });

        let result = await rpc.getstakeweightsbycapability({
            capability: 'archive_publish', block_index: SNAPSHOT_BLOCK,
            min_stake: MIN_STAKE,
        });

        assert.strictEqual(result.capability, 'archive_publish');
        assert.deepStrictEqual(result.validators, rows);
        assert.deepStrictEqual(view.calls, [
            ['isCapabilityConfigured', 'archive_publish'],
            ['getLatestBlockIndex'],
            ['getStakeWeightsByCapability', 'archive_publish', SNAPSHOT_BLOCK, MIN_STAKE],
        ]);
    });
});
