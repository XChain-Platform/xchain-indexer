'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// AnchorRecovery stake cross-checks: the --verify-stakes existence check (direct
// stakes, delegated keys, capped resolutions, bare query handles) and the
// key-source binding check (REC-BIND-1) that stops an attacker key wearing an
// honest validator's staking source. Part of the suite whose entry is
// test/unit/recovery.test.js.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../../bin/recovery.js');

// Publisher-faithful archive builder and the database stubs, shared with the
// suite entry test/unit/recovery.test.js.
const { makeKeypair, buildBatch, rawMatch } = require('../../../fixtures/anchor-archive.js');
const { util, memDb, btcDbStub, rawStakeHandleStub, capSetFromKeys, rewardBtcDbStub } = require('../../../helpers/recovery_stubs.js');

// Fresh federation keys for every test. Held at module scope so the fixture
// builders in this file read the current test's keys, exactly as they did when
// the whole suite was one describe block.
let oracleKeys, crossKeys;
function freshKeys() {
    oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
}
const quiet = { log: () => {}, util };

// An archive where `attacker` occupies the row of honest validator `victim`: the
// source and the weight are byte-identical to the honest archive, only the signing
// key changed, and the attacker re-signed the batch with their own key.
function forgedBatch() {
    let victim   = crossKeys[0];
    let attacker = makeKeypair();
    let forgedCross = [attacker].concat(crossKeys.slice(1));
    let victimSource = 'src_' + victim.pubkey.slice(0, 16);
    let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, forgedCross, {
        snapSourceFor: pk => (pk === attacker.pubkey ? victimSource : 'src_' + pk.slice(0, 16))
    });
    // The attacker really does hold stake, under their OWN source, which is what
    // makes the existence guard pass.
    let staked = oracleKeys.map(k => k.pubkey)
        .concat(crossKeys.slice(1).map(k => k.pubkey))
        .concat([attacker.pubkey]);
    // On chain the victim's source is still the victim's: the archived set the
    // resolver reports is unchanged, so completeness has nothing to object to.
    let capSets = {
        cross_chain: capSetFromKeys(crossKeys),
        oracle_publish: capSetFromKeys(oracleKeys)
    };
    return { v1, staked, capSets, attacker, victimSource };
}

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    it('--verify-stakes kills a fabricated validator set with no on-chain stakes', async function () {
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        // All keys staked → passes. One cross_chain key unstaked → batch rejected.
        let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
        let okReport = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: btcDbStub(allStaked), verifyStakes: true }, quiet)).run();
        assert.strictEqual(okReport.verified, 1);

        let partial = allStaked.filter(p => p !== crossKeys[0].pubkey);
        let badReport = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: btcDbStub(partial), verifyStakes: true }, quiet)).run();
        assert.strictEqual(badReport.verified, 0);
        assert.ok(badReport.failed[0].reason.includes('no on-chain stake'));
    });

    it('certifies an archive whose validator signs by DELEGATION, holding no direct stake row (#4270)', async function () {
        // DELEGATE.md: a source may authorize signing keys that carry no `stakes` row of
        // their own; db.js UNIONs those active delegations into the effective signer set,
        // so an honest archive legitimately contains such a key. The existence check must
        // resolve through that same effective set - a direct-stake-only query rejected the
        // whole batch and left AnchorRecovery unable to certify valid live state.
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        let allKeys  = oracleKeys.concat(crossKeys).map(k => k.pubkey);
        let delegate = crossKeys[0].pubkey;
        let directOnly = allKeys.filter(p => p !== delegate);   // the delegated key has no stakes row
        let report = await new AnchorRecovery(memDb([v1], []),
            Object.assign({ btcDb: btcDbStub(directOnly, { effective: allKeys }), verifyStakes: true }, quiet)).run();
        assert.strictEqual(report.verified, 1);
        assert.strictEqual(report.failed.length, 0);
        // and a key that is neither staked nor delegated is still a forge.
        let ghost = makeKeypair();
        let bad = await new AnchorRecovery(memDb([v1], []),
            Object.assign({ btcDb: btcDbStub(directOnly, { effective: directOnly.concat([ghost.pubkey]) }), verifyStakes: true }, quiet)).run();
        assert.strictEqual(bad.verified, 0);
        assert.ok(bad.failed[0].reason.includes('no on-chain stake or delegation'));
    });

    it('a directly-staked key is answered by the direct query alone, never by a capped resolver', async function () {
        // Stage ordering is the fix, not an optimisation: the direct query is uncapped, so a key
        // it accepts must never be re-adjudicated by a resolver whose result caps could deny it.
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
        let btcDb = btcDbStub(allStaked);
        let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
        assert.strictEqual(report.verified, 1);
        assert.ok(!btcDb.calls.some(c => c.minStake === '0'),
                  'no key lacked a direct stake row, so the existence check must not have resolved at all');
        assert.ok(btcDb.calls.every(c => c.minStake === null),
                  'only the completeness resolution (no threshold override) may reach the resolver here');
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    it('delegated-key admission resolves the KEY-COMPLETE count resolver at a LOOSE threshold', async function () {
        // Two properties in one, both false-reject guards:
        //  - threshold '0', because slashCapabilityStake rewrites stakes.amount in place, so a
        //    MIN_STAKE-thresholded existence resolution would deny a source slashed AFTER the block;
        //  - getValidatorsByCapability, NOT getStakeWeightsByCapability: _cappedStakeWeightsSql
        //    drops a source's keys past STAKE_WEIGHT_MAX_KEYS_PER_SOURCE (64) and by design does
        //    NOT set truncated, so the weight resolver cannot answer a per-KEY existence question.
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        let allKeys = oracleKeys.concat(crossKeys).map(k => k.pubkey);
        let directOnly = allKeys.filter(p => p !== crossKeys[0].pubkey);
        let btcDb = btcDbStub(directOnly, { effective: allKeys });
        let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
        assert.strictEqual(report.verified, 1);
        let admissions = btcDb.calls.filter(c => c.minStake === '0');
        assert.ok(admissions.length > 0, 'the delegated-only key must have been resolved');
        assert.ok(admissions.every(c => c.method === 'getValidatorsByCapability'),
                  'the source-capped weight resolver must never answer a per-key existence probe');
        assert.ok(btcDb.calls.every(c => c.minStake === '0' || c.minStake === null),
                  'no archive-derived threshold may reach the resolver');
    });

    it('a truncated delegation resolution fails closed rather than declaring a key absent', async function () {
        // A capped resolution cannot prove a key ABSENT. The cap binds only on keys the direct
        // query already rejected, so this turns a certain rejection into one that names the cap.
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        let allKeys = oracleKeys.concat(crossKeys).map(k => k.pubkey);
        let directOnly = allKeys.filter(p => p !== crossKeys[0].pubkey);
        let btcDb = btcDbStub(directOnly, { effective: directOnly, truncated: ['cross_chain'] });
        let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('truncated'));
        assert.ok(report.failed[0].reason.includes('cannot be proven absent'));
    });

    it('a raw doQuery handle keeps the legacy direct-stake existence check', async function () {
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
        let ok = await new AnchorRecovery(memDb([v1], []),
            Object.assign({ btcDb: rawStakeHandleStub(allStaked), verifyStakes: true }, quiet)).run();
        assert.strictEqual(ok.verified, 1);

        let partial = allStaked.filter(p => p !== crossKeys[0].pubkey);
        let bad = await new AnchorRecovery(memDb([v1], []),
            Object.assign({ btcDb: rawStakeHandleStub(partial), verifyStakes: true }, quiet)).run();
        assert.strictEqual(bad.verified, 0);
        assert.ok(bad.failed[0].reason.includes('has no on-chain stake at block'));
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    it('stake cross-check is gated on the explicit flag, not btcDb presence (restore runs against an EMPTY pre-reindex BTC DB)', async function () {
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        // btcDb present but knows NO stakes (pre-reindex) and the flag is off;
        // the batch must still verify, or the reward-restore step of the
        // recovery runbook would fail every batch before the reindex runs.
        let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: rewardBtcDbStub() }, quiet)).run();
        assert.strictEqual(report.verified, 1);
    });

    // Key-source binding: the archive decides which SOURCE a signing key speaks for, and under
    // weighted quorum the source carries the stake. Existence answers "is this key staked
    // somewhere" and weighted completeness reduces the archive to source -> amount before it
    // looks, so signing-key identity left the weighted path entirely and an attacker holding
    // any small stake could write their own key onto an honest source's row.
    describe('key-source binding cross-check (REC-BIND-1)', function () {
        it('rejects an attacker key wearing an honest validator\'s staking source', async function () {
            let { v1, staked, capSets, attacker, victimSource } = forgedBatch();
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(staked, { capSets }), verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('key-binding forge'), report.failed[0].reason);
            assert.ok(report.failed[0].reason.includes(attacker.pubkey.substring(0, 16)));
            assert.ok(report.failed[0].reason.includes(victimSource.substring(0, 24)));
        });

        it('and EVERY other guard passes that same forge, which is why this check exists', async function () {
            // Negative control for the case above: with only the binding probe disabled, the
            // forged archive certifies. Existence, completeness, the weight equality and the
            // weighted quorum all read it as honest, so a green run here is the pre-fix
            // behaviour and not an artefact of the fixture.
            let { v1, staked, capSets } = forgedBatch();
            let rec = new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(staked, { capSets }), verifyStakes: true }, quiet));
            rec.verifyKeySourceBinding = async () => {};
            let report = await rec.run();
            assert.strictEqual(report.verified, 1, JSON.stringify(report.failed));
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('key-source binding cross-check (REC-BIND-1)', function () {
        it('admits a key legitimately backed by TWO sources under either of them', async function () {
            // Existence semantics, not stake_source.js's "latest row wins": picking one
            // answer per key would condemn an honest archive that names the other source.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let staked  = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let shared  = crossKeys[0].pubkey;
            let capSets = { cross_chain: capSetFromKeys(crossKeys), oracle_publish: capSetFromKeys(oracleKeys) };
            let btcDb = btcDbStub(staked, { capSets,
                bindings: { [shared]: ['src_other_source', 'src_' + shared.slice(0, 16)] } });
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 1, JSON.stringify(report.failed));
        });

        it('runs on a bare doQuery handle, where the resolver-based checks skip', async function () {
            let { v1, staked, attacker } = forgedBatch();
            let bad = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: rawStakeHandleStub(staked), verifyStakes: true }, quiet)).run();
            assert.strictEqual(bad.verified, 0);
            assert.ok(bad.failed[0].reason.includes('key-binding forge'), bad.failed[0].reason);
            assert.ok(bad.failed[0].reason.includes(attacker.pubkey.substring(0, 16)));
        });

        it('leaves the legacy count-quorum path byte-unchanged', async function () {
            // Below the stake-weighted flag day the source carries no weight and older
            // archives may not populate it at all, so binding is not enforced there:
            // enforcing it would false-reject honest archives and halt recovery.
            let poisoned = { async doQuery(){ throw new Error('the binding probe must not run under count quorum'); } };
            let rec = new AnchorRecovery(memDb([], []),
                Object.assign({ btcDb: poisoned, verifyStakes: true }, quiet));
            // mainnet arms stake-weighted quorum at 961000; 960999 is the last count block.
            await rec.verifyKeySourceBinding(
                [{ snapshot_block: 960999, capability: 'cross_chain', signing_pubkey: 'ab'.repeat(32), source: '', amount: '5' }],
                'mainnet');
            // ... and at the activation height it does run, against the same blank source.
            await assert.rejects(
                rec.verifyKeySourceBinding(
                    [{ snapshot_block: 961000, capability: 'cross_chain', signing_pubkey: 'ab'.repeat(32), source: '', amount: '5' }],
                    'mainnet'),
                /no staking source/);
        });
    });
});
