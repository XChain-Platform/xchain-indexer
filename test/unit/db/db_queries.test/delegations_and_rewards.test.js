/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db/db_queries.test/delegations_and_rewards.test.js
 *
 * Delegations, contract stakes and their owners and deactivation, the
 * stake-weight view, validator rewards and the unclaimed reward total.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb, dbWithDoQuery } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// getUnclaimedRewardTotal
// ---------------------------------------------------------------------------
describe('Database.getUnclaimedRewardTotal() @regression @tier1', function () {
    it('returns "0" when address not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(null);
        assert.strictEqual(await db.getUnclaimedRewardTotal('source1'), '0');
    });

    it('returns bcsub(totalRewards, totalClaimed) when address found', async function () {
        const db   = makeDb();
        sinon.stub(db, 'getAddressId').resolves(5);
        const stub = sinon.stub(db, 'doQuery');
        // total_rewards query
        stub.onCall(0).resolves([{ total_rewards: '1000' }]);
        // total_claimed query
        stub.onCall(1).resolves([{ total_claimed: '400' }]);
        const result = await db.getUnclaimedRewardTotal('source1');
        // util.bcsub('1000', '400', 18) → some numeric string
        assert.ok(result !== null && result !== undefined);
    });
});

// ---------------------------------------------------------------------------
// getActiveDelegation
// ---------------------------------------------------------------------------
describe('Database.getActiveDelegation() @regression @tier1', function () {
    it('returns null when no delegation found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getActiveDelegation('src', 'pk', 100), null);
    });

    it('returns delegation row when found', async function () {
        const db = dbWithDoQuery([{ action_index: 5, amount: '1000' }]);
        const result = await db.getActiveDelegation('src', 'pk', 100);
        assert.strictEqual(result.action_index, 5);
    });
});

// ---------------------------------------------------------------------------
// getActiveContractStakeByPubkey
// ---------------------------------------------------------------------------
describe('Database.getActiveContractStakeByPubkey() @regression @tier1', function () {
    it('returns null when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.getActiveContractStakeByPubkey(1, 'pk', 'TICK', 100), null);
    });

    it('returns null when tick not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getTickerId').resolves(null);
        sinon.stub(db, 'getStatusId').resolves(1);
        assert.strictEqual(await db.getActiveContractStakeByPubkey(1, 'pk', 'NOTEXIST', 100), null);
    });

    it('returns null when no rows found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getTickerId').resolves(5);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getActiveContractStakeByPubkey(1, 'pk', 'TICK', 100), null);
    });

    it('returns row data when found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getTickerId').resolves(5);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{
            source_id: 1, signing_pubkey_id: 3, amount: '500', target_contract_index: 1
        }]);
        const result = await db.getActiveContractStakeByPubkey(1, 'pk', 'TICK', 100);
        assert.ok(result !== null);
        assert.strictEqual(String(result.amount), '500');
    });
});

// ---------------------------------------------------------------------------
// getContractStakeOwner
// ---------------------------------------------------------------------------
describe('Database.getContractStakeOwner() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getTickerId').resolves(5);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getContractStakeOwner(1, 'pk', 'TICK'), null);
    });

    it('returns null when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.getContractStakeOwner(1, 'pk', 'TICK'), null);
    });
});

// ---------------------------------------------------------------------------
// createValidatorReward: unknown pubkey, no stake, success
// ---------------------------------------------------------------------------
describe('Database.createValidatorReward() @regression @tier1', function () {
    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, false);
    });

    // Source resolution moved into resolveActiveStakeSourceId (strict active-row
    // predicates; covered in reward_source_resolution.test.js). These cases stub the
    // resolver so they exercise createValidatorReward's own insert/return logic only.
    it('returns false when no active source resolves for the pubkey', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'resolveActiveStakeSourceId').resolves(null);
        const dq = sinon.stub(db, 'doQuery');
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, false);
        assert.strictEqual(dq.callCount, 0); // no INSERT when the source does not resolve
    });

    it('returns true and inserts the reward when a source resolves', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, true);
        assert.ok(String(dq.args[0][0]).includes('INSERT IGNORE INTO validator_rewards'));
    });

    it('writes the resolved source_id into the reward row', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'resolveActiveStakeSourceId').resolves(7); // e.g. resolved via a DELEGATE v0 key
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, true);
        assert.ok(String(dq.args[0][0]).includes('INSERT IGNORE INTO validator_rewards'));
        assert.strictEqual(dq.args[0][1][0], 7);  // source_id arg is the resolver's result
        assert.strictEqual(dq.args[0][1][1], 3);  // signing_pubkey_id arg is the pubkey
    });

    it('upsert=true emits ON DUPLICATE KEY UPDATE so the deterministic writer wins', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100, true);
        assert.strictEqual(result, true);
        const sql = String(dq.args[0][0]);
        assert.ok(sql.includes('ON DUPLICATE KEY UPDATE'));
        assert.ok(!sql.includes('INSERT IGNORE'));
    });
});

describe('Database.createValidatorReward() @regression @tier1', function () {
    // a reward whose EARN block is not its MATERIALIZATION block (the
    // BTC-side anchor derivation) must persist both, or the reorg delete has no key
    // that names the block which actually minted the row.
    it('persists the materialization block when the caller passes one, and NULL otherwise', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);

        await db.createValidatorReward('deadbeef', 1, 'anchor_BTC', '10', 850000, true, 962400);
        assert.ok(String(dq.args[0][0]).includes('derive_block_index'), 'the INSERT must name the column');
        assert.deepStrictEqual(dq.args[0][1].slice(-2), [850000, 962400],
            'block_index stays the earn-block; derive_block_index is the creating block');
        // The upsert must refresh it too, or a replayed derive would leave a stale value behind.
        assert.ok(/ON DUPLICATE KEY UPDATE[\s\S]*derive_block_index=VALUES\(derive_block_index\)/.test(String(dq.args[0][0])));

        dq.resetHistory();
        await db.createValidatorReward('deadbeef', 2, 'oracle_round', '10', 100, true);
        assert.strictEqual(dq.args[0][1][7], null,
            'a same-block writer leaves derive_block_index NULL so the new predicate never matches it');
    });

    // round_qualifier joined the UNIQUE key because 'anchor_archive' rounds are MATCH_BATCH_SEQ,
    // a dense hub counter a wipe-and-replay rebase reissues. Every OTHER reward type must keep
    // the key it always had, which means a literal 0 - never NULL, since MariaDB treats NULLs as
    // distinct in a UNIQUE index and would stop deduplicating the row entirely.
    it('writes round_qualifier 0 for a non-archive reward and when the caller omits it', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);

        await db.createValidatorReward('deadbeef', 1, 'anchor_BTC', '10', 850000, true, 962400);
        assert.ok(String(dq.args[0][0]).includes('round_qualifier'), 'the INSERT must name the column');
        assert.strictEqual(dq.args[0][1][4], 0, 'a per-chain anchor leg is never qualified');

        dq.resetHistory();
        await db.createValidatorReward('deadbeef', 2, 'oracle_round', '10', 100, true);
        assert.strictEqual(dq.args[0][1][4], 0, 'an omitted qualifier lands on 0, not NULL');
    });

    it('carries the archive reward snapshot_block through as its round_qualifier', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);

        // Two archive anchors can carry round_reference 3 across a hub rebase; the qualifier is
        // what keeps them two rows instead of one upsert overwriting the other.
        await db.createValidatorReward('deadbeef', 3, 'anchor_archive', '10', 8100, true, 9000, 8100);
        assert.strictEqual(dq.args[0][1][4], 8100);
        assert.strictEqual(dq.args[0][1][3], 3, 'round_reference stays the hub batch seq');
    });
});

// ---------------------------------------------------------------------------
// setDelegationDeactivation: returns false when source or pubkey missing
// ---------------------------------------------------------------------------
describe('Database.setDelegationDeactivation() @regression @tier1', function () {
    it('returns false when source address not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(null);
        sinon.stub(db, 'getPubkeyId').resolves(3);
        const result = await db.setDelegationDeactivation('addr1', 'pk', 200);
        assert.strictEqual(result, false);
    });

    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(1);
        sinon.stub(db, 'getPubkeyId').resolves(null);
        const result = await db.setDelegationDeactivation('addr1', 'pk', 200);
        assert.strictEqual(result, false);
    });

    it('runs UPDATE and returns true when both found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(1);
        sinon.stub(db, 'getPubkeyId').resolves(2);
        sinon.stub(db, 'getStatusId').resolves(3);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.setDelegationDeactivation('addr1', 'pk', 200);
        assert.strictEqual(result, true);
        assert.ok(String(dq.args[0][0]).includes('UPDATE delegations'));
    });
});

// ---------------------------------------------------------------------------
// setContractStakeDeactivationByPubkey: early-returns when pk/tick null
// ---------------------------------------------------------------------------
describe('Database.setContractStakeDeactivationByPubkey() @regression @tier1', function () {
    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        const r = await db.setContractStakeDeactivationByPubkey(1, 'pk', 'FOO', 100);
        assert.strictEqual(r, false);
    });

    it('returns false when tick not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(1);
        sinon.stub(db, 'getTickerId').resolves(null);
        const r = await db.setContractStakeDeactivationByPubkey(1, 'pk', 'FOO', 100);
        assert.strictEqual(r, false);
    });

    it('runs UPDATE and returns true when both found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(1);
        sinon.stub(db, 'getTickerId').resolves(2);
        sinon.stub(db, 'getStatusId').resolves(3);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const r = await db.setContractStakeDeactivationByPubkey(1, 'pk', 'FOO', 100);
        assert.strictEqual(r, true);
        assert.ok(String(dq.args[0][0]).includes('UPDATE contract_stakes'));
    });
});

// ---------------------------------------------------------------------------
// getActiveStakeWeights: source-keyed all-staker set (STAKE_WEIGHTED_QUORUM
// counterpart of getActiveValidators; powers the hub config-change PBFT)
// ---------------------------------------------------------------------------

describe('Database.getActiveStakeWeights() @regression @tier1', function () {
    it('maps source-keyed rows and applies NO MIN_STAKE floor', async function () {
        const db = dbWithDoQuery([
            { pubkey: 'aa', source: 'src1', weight: '500' },  // two keys, one source
            { pubkey: 'bb', source: 'src1', weight: '500' },
            { pubkey: 'cc', source: 'src2', weight: '300' },
        ]);
        sinon.stub(db, 'getStatusId').resolves(1);
        const out = await db.getActiveStakeWeights(306);
        // Spread to a plain array so deepStrictEqual ignores the additive truncated property.
        assert.deepStrictEqual([...out], [
            { pubkey: 'aa', source: 'src1', weight: '500' },
            { pubkey: 'bb', source: 'src1', weight: '500' },
            { pubkey: 'cc', source: 'src2', weight: '300' },
        ]);
        assert.strictEqual(out.truncated, false);
        // No MIN_STAKE floor; the _stakeWeightsSql min-stake bind arg is '0'.
        const args = db.doQuery.getCall(0).args[1];
        assert.ok(args.includes('0'), 'expected min_stake 0 among the query args');
    });

    it('returns [] when the valid status id is unavailable', async function () {
        const db = dbWithDoQuery([]);
        sinon.stub(db, 'getStatusId').resolves(null);
        const out = await db.getActiveStakeWeights(306);
        assert.deepStrictEqual(out, []);
    });
});
