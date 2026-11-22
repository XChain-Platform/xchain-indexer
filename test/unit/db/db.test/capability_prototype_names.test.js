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

// test/unit/db/db.test/capability_prototype_names.test.js
//
// Capability names that match Object.prototype members are not configured
// capabilities. Every read below runs the real Database method against a BTC
// config, so a name that resolved an inherited member would reach the stake
// queries with a zero floor instead of answering the unconfigured result.

'use strict';

const { assert, sinon, Utility, Database } = require('./helpers/db.js');
const observability = require('../../../../src/observability/index.js');
const { buildCapabilitiesRpc } = require('../../../../src/api/rpc/capabilities.js');
const { bountyTreasurySplit } = require('../../../../src/actions/slash/bounty.js');
const { fakeIndexer } = require('../../api/rpc/helpers/fake_indexer.js');

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
const STAKER = { pubkey: 'aa'.repeat(32), source: 'source-a', weight: '50000', total: '50000' };

// A BTC indexer whose every storage read answers a qualifying staker, so any
// lookup that gets past the capability check returns a non-empty answer and
// leaves a recorded call behind.
function btcDb(){
    const reads = sinon.stub().resolves(1);
    return {
        config: {
            COIN: 'BTC',
            NETWORK: 'regtest',
            VALIDATOR_QUERY_LIMIT: 100,
            STAKING: { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } },
        },
        util: new Utility(),
        isCapabilityConfigured: Database.prototype.isCapabilityConfigured,
        getStakeWeightsByCapability: Database.prototype.getStakeWeightsByCapability,
        getValidatorsByCapability: Database.prototype.getValidatorsByCapability,
        getActiveCapabilityCount: Database.prototype.getActiveCapabilityCount,
        hasCapability: Database.prototype.hasCapability,
        getStatusId: reads,
        getPubkeyId: reads,
        getLatestBlockIndex: sinon.stub().resolves(500),
        isPubkeySlashedAt: sinon.stub().resolves(false),
        effectiveCapabilitySetSql: sinon.stub().returns({ sql: 'SELECT 1', args: [] }),
        stakeWeightsWithCap: sinon.stub().resolves({ rows: [STAKER], truncated: false }),
        doQuery: sinon.stub().resolves([Object.assign({ cnt: 1 }, STAKER)]),
    };
}

function storageCalls(db){
    return db.getStatusId.callCount + db.getLatestBlockIndex.callCount +
        db.stakeWeightsWithCap.callCount + db.doQuery.callCount;
}

afterEach(function(){ sinon.restore(); });

describe('capability reads refuse Object.prototype member names @regression @tier1', function(){
    it('answers the unconfigured result from all four DB reads without touching storage', async function(){
        for(const name of INHERITED){
            const db = btcDb();
            assert.deepStrictEqual(await db.getStakeWeightsByCapability(name, 200), [], name);
            assert.deepStrictEqual(await db.getValidatorsByCapability(name, 200), [], name);
            assert.strictEqual(await db.getActiveCapabilityCount(name, 200), 0, name);
            assert.strictEqual(await db.hasCapability(STAKER.pubkey, name, 200), false, name);
            assert.strictEqual(storageCalls(db), 0, name);
        }
    });

    it('still answers a configured capability from storage', async function(){
        const db = btcDb();
        assert.strictEqual((await db.getStakeWeightsByCapability('attestation', 200)).length, 1);
        assert.strictEqual((await db.getValidatorsByCapability('attestation', 200)).length, 1);
        assert.strictEqual(await db.getActiveCapabilityCount('attestation', 200), 1);
        assert.ok(storageCalls(db) > 0);
    });

    it('getcapabilityvalidators and getstakeweightsbycapability report the name as not configured', async function(){
        sinon.stub(observability.getLogger(), 'info');
        for(const name of INHERITED){
            const db = btcDb();
            const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view: db }) });
            const expected = { error: 'capability not configured: ' + name };
            assert.deepStrictEqual(
                await rpc.getcapabilityvalidators({ capability: name, block_index: 200 }), expected);
            assert.deepStrictEqual(
                await rpc.getstakeweightsbycapability({ capability: name, block_index: 200 }), expected);
            assert.strictEqual(storageCalls(db), 0, name);
        }
    });

    it('the RPC still serves a configured capability through the same wiring', async function(){
        sinon.stub(observability.getLogger(), 'info');
        const db = btcDb();
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view: db }) });
        const answer = await rpc.getstakeweightsbycapability({ capability: 'attestation', block_index: 200 });
        assert.strictEqual(answer.capability, 'attestation');
        assert.strictEqual(answer.count, 1);
    });

    it('bountyTreasurySplit reads only a capability config the object owns', function(){
        const util = new Utility();
        const slash = { SLASH: { BOUNTY_BPS: 5000, TREASURY_ADDRESS: 'addrT' } };
        const owned = { STAKING: { CAPABILITIES: { attestation: slash } } };
        const inherited = { STAKING: { CAPABILITIES: Object.create({ attestation: slash }) } };
        assert.strictEqual(Number(bountyTreasurySplit(owned, util, 'attestation', '1000').bounty), 500);
        const burn = bountyTreasurySplit(inherited, util, 'attestation', '1000');
        assert.deepStrictEqual(burn, bountyTreasurySplit(owned, util, 'unknown', '1000'));
        assert.strictEqual(burn.treasuryAddr, null);
        for(const name of INHERITED)
            assert.deepStrictEqual(bountyTreasurySplit(owned, util, name, '1000'), burn, name);
    });
});
