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
 **********************************************************************/

// test/unit/db.test/validator_capabilities.test.js
//
// Covers capability threshold sources, delegated keys, and configuration detection.

'use strict';

const { assert, sinon, getTestConfig, Database } = require('./helpers/db.js');

// ---------------------------------------------------------------------------
// describe: getValidatorsByCapability (MIN_STAKE threshold source)
// ---------------------------------------------------------------------------
// Regression guard: the validator-set snapshot must filter by the caller-supplied
// threshold (the hub's authoritative MIN_STAKE) VERBATIM when one is provided, and
// only fall back to this indexer's local config when it is absent. The local floor
// must NEVER clamp an explicit caller value: if it did, two hubs pointing at
// differently-configured indexers would compute different validator sets for the
// same block and break PBFT quorum determinism. Anti-inflation lives at the hub +
// on-chain-validation layers, not in this read path.
describe('Database.getValidatorsByCapability() threshold source @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        db = {
            config,
            getValidatorsByCapability: Database.prototype.getValidatorsByCapability,
            _effectiveCapabilitySetSql: Database.prototype._effectiveCapabilitySetSql,
            getStatusId: sinon.stub().resolves(1),
            doQuery:     sinon.stub().resolves([]),
            // The caller value is honoured verbatim (no clamp), so util.bcgte is
            // not exercised on the threshold-resolution path. Stubbed for parity.
            util: { bcgte: sinon.stub().callsFake((a, b) => parseFloat(a) >= parseFloat(b)) },
        };
    });

    // The effective-set union binds the HAVING threshold twice: once for the
    // stake-key branch (arg 6) and once for the delegated-key source-aggregate
    // branch (arg 10). Both MUST carry the same resolved threshold. (Indices 6/10,
    // not 5/9: each branch carries a slash-exclusion blockIndex arg.)
    function thresholdArgs() {
        const a = db.doQuery.firstCall.args[1];
        return [a[6], a[10]];
    }

    it('uses the caller-supplied override over local config', async function () {
        await db.getValidatorsByCapability.call(db, 'attestation', 100, '25000');
        assert.deepStrictEqual(thresholdArgs(), ['25000', '25000']);
    });

    it('coerces a numeric override to a string', async function () {
        await db.getValidatorsByCapability.call(db, 'attestation', 100, 25000);
        assert.deepStrictEqual(thresholdArgs(), ['25000', '25000']);
    });

    it('falls back to local config when no override is supplied', async function () {
        await db.getValidatorsByCapability.call(db, 'attestation', 100);
        assert.deepStrictEqual(thresholdArgs(), ['10000', '10000']);
    });

    it('treats a 0 override as a real threshold (not a falsy fallback)', async function () {
        // 0 is an explicit caller value and is honoured VERBATIM (no clamp to the
        // local floor). This matches getStakeWeightsByCapability, so both the count
        // and weight paths resolve the identical qualifying set; cross-indexer
        // determinism is preserved because no path reads this indexer's local floor
        // when the hub passes an explicit threshold.
        await db.getValidatorsByCapability.call(db, 'attestation', 100, 0);
        assert.deepStrictEqual(thresholdArgs(), ['0', '0']);
    });
});

// ---------------------------------------------------------------------------
// describe: getActiveCapabilityCount / hasCapability (threshold source)
// ---------------------------------------------------------------------------
// Companions to getValidatorsByCapability: both expose the same optional
// caller-supplied MIN_STAKE override (falling back to local config when absent)
// so the API is symmetric and a future hub caller can drive the threshold the
// same way the validator-set snapshot already does. Current internal callers
// (price/attest block processing) omit the override and keep using local config.
describe('Database.getActiveCapabilityCount() threshold source @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        db = {
            config,
            getActiveCapabilityCount: Database.prototype.getActiveCapabilityCount,
            _effectiveCapabilitySetSql: Database.prototype._effectiveCapabilitySetSql,
            getStatusId: sinon.stub().resolves(1),
            getLatestBlockIndex: sinon.stub().resolves(100),
            doQuery:     sinon.stub().resolves([{ cnt: 0 }]),
            // The caller value is honoured verbatim (no clamp); util.bcgte stubbed
            // for parity but not exercised on the threshold-resolution path.
            util: { bcgte: sinon.stub().callsFake((a, b) => parseFloat(a) >= parseFloat(b)) },
        };
    });

    // Same effective-set union as getValidatorsByCapability: the threshold
    // binds at args 6 (stake-key branch) and 10 (delegated-key branch). (Not
    // 5/9, because of the slash-exclusion blockIndex arg in each branch.)
    function thresholdArgs() {
        const a = db.doQuery.firstCall.args[1];
        return [a[6], a[10]];
    }

    it('uses the caller-supplied override over local config', async function () {
        await db.getActiveCapabilityCount.call(db, 'attestation', 100, '25000');
        assert.deepStrictEqual(thresholdArgs(), ['25000', '25000']);
    });

    it('falls back to local config when no override is supplied', async function () {
        await db.getActiveCapabilityCount.call(db, 'attestation', 100);
        assert.deepStrictEqual(thresholdArgs(), ['10000', '10000']);
    });

    it('treats a 0 override as a real threshold (not a falsy fallback)', async function () {
        // 0 is an explicit caller value, honoured VERBATIM (no clamp to the local
        // floor) so this count matches the set membership every other indexer resolves.
        await db.getActiveCapabilityCount.call(db, 'attestation', 100, 0);
        assert.deepStrictEqual(thresholdArgs(), ['0', '0']);
    });

    it('counts over the SAME effective-set SQL as getValidatorsByCapability (quorum agreement)', async function () {
        await db.getActiveCapabilityCount.call(db, 'attestation', 100);
        const sql = db.doQuery.firstCall.args[0];
        assert.ok(sql.includes('COUNT(DISTINCT pubkey)'));
        assert.ok(sql.includes('stake_key_revocations'));   // revoked stake keys excluded
        assert.ok(sql.includes('delegations'));             // delegated keys included
    });
});

describe('Database.hasCapability() threshold source @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        db = {
            config,
            hasCapability:       Database.prototype.hasCapability,
            getStatusId:         sinon.stub().resolves(1),
            getPubkeyId:         sinon.stub().resolves(3),
            getLatestBlockIndex: sinon.stub().resolves(100),
            // Not slashed (the permanent-disqualification guard): stubbed so the
            // threshold-source assertions exercise the stake/delegated branches; the
            // disqualification path has its own dedicated coverage.
            isPubkeySlashedAt:  sinon.stub().resolves(false),
            // Stake-key branch resolves a per-pubkey aggregate of 15000
            doQuery:             sinon.stub().resolves([{ total: '15000' }]),
            // The caller value is honoured verbatim (no clamp); util.bcgte is used
            // only for the stake comparison bcgte(total, minStake).
            util:                { bcgte: sinon.stub().callsFake((a, b) => parseFloat(a) >= parseFloat(b)) },
        };
    });

    // hasCapability resolves the threshold, then calls util.bcgte(total, minStake)
    // for each branch (stake key, then delegated key). The threshold is honoured
    // verbatim, so bcgte's second arg is the resolved minStake; lastCall reads the
    // threshold used in the actual stake comparison regardless of call count.
    function thresholdArg() {
        return db.util.bcgte.lastCall.args[1];
    }

    it('uses the caller-supplied override over local config', async function () {
        await db.hasCapability.call(db, 'pk', 'attestation', 100, '25000');
        assert.strictEqual(thresholdArg(), '25000');
    });

    it('coerces a numeric override to a string', async function () {
        await db.hasCapability.call(db, 'pk', 'attestation', 100, 25000);
        assert.strictEqual(thresholdArg(), '25000');
    });

    it('falls back to local config when no override is supplied', async function () {
        await db.hasCapability.call(db, 'pk', 'attestation', 100);
        assert.strictEqual(thresholdArg(), '10000');
    });

    it('treats a 0 override as a real threshold (not a falsy fallback)', async function () {
        // 0 is an explicit caller value, honoured VERBATIM (no clamp to the local
        // floor) so this per-pubkey test agrees with the qualifying set resolved
        // by every other indexer for the block.
        await db.hasCapability.call(db, 'pk', 'attestation', 100, 0);
        assert.strictEqual(thresholdArg(), '0');
    });

});

describe('Database.hasCapability() threshold source @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        db = {
            config,
            hasCapability:       Database.prototype.hasCapability,
            getStatusId:         sinon.stub().resolves(1),
            getPubkeyId:         sinon.stub().resolves(3),
            getLatestBlockIndex: sinon.stub().resolves(100),
            // Not slashed (the permanent-disqualification guard): stubbed so the
            // threshold-source assertions exercise the stake/delegated branches; the
            // disqualification path has its own dedicated coverage.
            isPubkeySlashedAt:  sinon.stub().resolves(false),
            // Stake-key branch resolves a per-pubkey aggregate of 15000
            doQuery:             sinon.stub().resolves([{ total: '15000' }]),
            // The caller value is honoured verbatim (no clamp); util.bcgte is used
            // only for the stake comparison bcgte(total, minStake).
            util:                { bcgte: sinon.stub().callsFake((a, b) => parseFloat(a) >= parseFloat(b)) },
        };
    });

    it('falls through to the delegated-key branch when the stake branch misses', async function () {
        // Stake branch: no rows. Delegation branch: source aggregate 15000.
        db.doQuery.onFirstCall().resolves([{ total: null }]);
        db.doQuery.onSecondCall().resolves([{ total: '15000' }]);
        db.util.bcgte.returns(true);
        const ok = await db.hasCapability.call(db, 'pk', 'attestation', 100);
        assert.strictEqual(ok, true);
        assert.strictEqual(db.doQuery.callCount, 2);
        assert.ok(db.doQuery.secondCall.args[0].includes('delegations'));
    });

    it('returns false when neither branch qualifies', async function () {
        db.doQuery.resolves([{ total: null }]);
        const ok = await db.hasCapability.call(db, 'pk', 'attestation', 100);
        assert.strictEqual(ok, false);
    });
});
