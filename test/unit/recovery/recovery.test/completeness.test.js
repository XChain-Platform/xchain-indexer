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

// AnchorRecovery completeness cross-check (REC-SUBSET-1): an archived snapshot
// must hold every source that qualified on chain as of its block, judged at the
// threshold and weights reconstructed for that block rather than this node's
// live config. Part of the suite whose entry is test/unit/recovery.test.js.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../../bin/recovery.js');

// Publisher-faithful archive builder and the database stubs, shared with the
// suite entry test/unit/recovery.test.js.
const { makeKeypair, buildBatch, rawMatch } = require('../../../fixtures/anchor-archive.js');
const { util, memDb, btcDbStub, capSetFromKeys } = require('../../../helpers/recovery_stubs.js');

// Fresh federation keys for every test. Held at module scope so the fixture
// builders in this file read the current test's keys, exactly as they did when
// the whole suite was one describe block.
let oracleKeys, crossKeys;
function freshKeys() {
    oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
}
const quiet = { log: () => {}, util };

// The frozen table in capability_min_stake_history.js ships EMPTY on every network
// (arming an entry is a coordinated flag day, not a test fixture), so a ratified
// governance history enters the way a DR operator would supply one.
const GOVERNANCE_10 = {
    cross_chain:    [{ activation_block: 0, value: '10' }],
    oracle_publish: [{ activation_block: 0, value: '10' }]
};

// An archive an honest hub built at governance MIN_STAKE 10 while THIS node's coin
// config still reads 1: its snapshot legitimately omits every source below 10, and
// one such source (src_below_governance) is live on-chain to prove the omission is
// not a forge.
function highThresholdArchive() {
    let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { snapAmount: '10' });
    let capSets = {
        cross_chain: capSetFromKeys(crossKeys, '10')
            .concat([{ pubkey: makeKeypair().pubkey, source: 'src_below_governance', weight: '5' }]),
        oracle_publish: capSetFromKeys(oracleKeys, '10')
    };
    return { v1, capSets, staked: oracleKeys.concat(crossKeys).map(k => k.pubkey) };
}

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('completeness cross-check (REC-SUBSET-1)', function () {
        it('an honest full archived snapshot passes the source completeness check', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let capSets = { cross_chain: capSetFromKeys(crossKeys), oracle_publish: capSetFromKeys(oracleKeys) };
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(allStaked, { capSets }), verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 1);
            assert.strictEqual(report.failed.length, 0);
        });

        it('rejects a subset snapshot that dropped a qualifying source (the forge)', async function () {
            // The archive carries the honest 4-source cross_chain set, but on-chain a FIFTH
            // qualifying source exists that the archive omitted (an evicted honest source).
            // Existence (_verifyStakes) passes - every ARCHIVED key is staked - but the
            // completeness resolver reports the dropped source, so the batch must fail.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let ghost = makeKeypair();
            let capSets = {
                cross_chain: capSetFromKeys(crossKeys).concat([{ pubkey: ghost.pubkey, source: 'src_ghost', weight: '5' }]),
                oracle_publish: capSetFromKeys(oracleKeys)
            };
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(allStaked, { capSets }), verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('incomplete'));
            assert.ok(report.failed[0].reason.includes('cross_chain'));
        });

        it('fails closed when the on-chain resolution is truncated', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let capSets = { cross_chain: capSetFromKeys(crossKeys), oracle_publish: capSetFromKeys(oracleKeys) };
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(allStaked, { capSets, truncated: ['cross_chain'] }), verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('truncated'));
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('completeness cross-check (REC-SUBSET-1)', function () {
        it('rejects a dropped source whose weight is below the archive OWN minimum (threshold-inflation forge, #4269)', async function () {
            // A completeness threshold set at the archive's own minimum admitted weight would
            // let the archive pick its own bar: drop every lower-weight qualifying source
            // and that minimum RISES, so the resolver returns only the retained high-weight
            // sources and the subset check passes while the dropped stake is missing from S.
            // The threshold is now the capability's protocol MIN_STAKE (what the resolver
            // applies when no override is passed), so a source qualifying there and absent from
            // the archive is a forge signal whatever its weight.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let dropped = makeKeypair();
            let capSets = {
                cross_chain: capSetFromKeys(crossKeys).concat([{ pubkey: dropped.pubkey, source: 'src_low', weight: '1' }]),
                oracle_publish: capSetFromKeys(oracleKeys)
            };
            let btcDb = btcDbStub(allStaked, { capSets });
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('incomplete'));
            assert.ok(report.failed[0].reason.includes('src_low'));
            // And the resolution that caught it passed NO archive-derived threshold. This
            // handle carries no coin config, so nothing is reconstructable and db.js is left
            // to apply its own local floor - the pre- path, unchanged.
            assert.ok(btcDb.calls.some(c => c.minStake === null), 'completeness must resolve at the protocol floor');
            assert.ok(btcDb.calls.every(c => c.minStake === null || c.minStake === '0'),
                      'no archive-derived threshold may reach the resolver');
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('completeness cross-check (REC-SUBSET-1)', function () {
        // the bar and the weights are reconstructed AS OF the snapshot block instead
        // of being read off this node's live local config, which is neither the bar the archive
        // was built at nor the weights it was built from.
        describe('as-of-block threshold + weight reconstruction', function () {
            it('certifies an archive built at a governance MIN_STAKE ABOVE the local floor', async function () {
                // The residual this closes: resolving at the local floor reports sources the
                // honest hub correctly excluded, so completeness condemns an honest archive and
                // DISASTER RECOVERY HALTS. Reconstructed at the archive's own block, it passes.
                let { v1, capSets, staked } = highThresholdArchive();
                let btcDb = btcDbStub(staked, { capSets, localFloor: '1' });
                let report = await new AnchorRecovery(memDb([v1], []),
                    Object.assign({ btcDb, verifyStakes: true, minStakeActivations: GOVERNANCE_10 }, quiet)).run();
                assert.deepStrictEqual(report.failed, [], 'an honest high-threshold archive must certify');
                assert.strictEqual(report.verified, 1);
                let completeness = btcDb.calls.filter(c => c.minStake !== '0');
                assert.ok(completeness.length > 0, 'the completeness check must have resolved');
                assert.ok(completeness.every(c => c.minStake === '10'),
                          'completeness must resolve at the reconstructed governance MIN_STAKE, not the local floor');
            });

            it('false-rejects that same archive when the threshold falls back to the local floor', async function () {
                // The control for the test above: with no governance history to reconstruct
                // from, the bar is this node's floor and the honest archive is condemned. This
                // is the exact failure removes, kept as a live demonstration.
                let { v1, capSets, staked } = highThresholdArchive();
                let btcDb = btcDbStub(staked, { capSets, localFloor: '1' });
                let report = await new AnchorRecovery(memDb([v1], []),
                    Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
                assert.strictEqual(report.verified, 0);
                assert.ok(report.failed[0].reason.includes('incomplete'));
                assert.ok(report.failed[0].reason.includes('src_below_governance'));
            });
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('completeness cross-check (REC-SUBSET-1)', function () {
        describe('as-of-block threshold + weight reconstruction', function () {
            it('resolves the threshold at the BURIED block, on the same plane as the set', async function () {
                // The hub buries the declared height before resolving BOTH its threshold and
                // its set (CapabilitySnapshot.getSnapshot), so a threshold resolved at the raw
                // height would reintroduce, in the bar, the split the reorg buffer removes.
                // SNAPSHOT_BLOCK 100 buries to 94 on regtest, so an activation AT 94 is in
                // force and one at 95 is not.
                let staked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
                let capSets = { cross_chain: capSetFromKeys(crossKeys), oracle_publish: capSetFromKeys(oracleKeys) };
                async function thresholdWith(activationBlock) {
                    let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
                    let hist = { cross_chain:    [{ activation_block: 0, value: '1' }, { activation_block: activationBlock, value: '10' }],
                                 oracle_publish: [{ activation_block: 0, value: '1' }, { activation_block: activationBlock, value: '10' }] };
                    let btcDb = btcDbStub(staked, { capSets, localFloor: '1' });
                    await new AnchorRecovery(memDb([v1], []),
                        Object.assign({ btcDb, verifyStakes: true, minStakeActivations: hist }, quiet)).run();
                    return btcDb.calls.filter(c => c.minStake !== '0').map(c => c.minStake);
                }
                assert.ok((await thresholdWith(94)).every(t => t === '10'),
                          'an activation at the buried height must be in force');
                assert.ok((await thresholdWith(95)).every(t => t === '1'),
                          'an activation ABOVE the buried height must not be, even though it is below the declared one');
            });

            it('unwinds a post-snapshot slash instead of condemning the archived weight', async function () {
                // slashCapabilityStake rewrites stakes.amount IN PLACE, so re-resolving the
                // snapshot block after a slash reports the POST-slash weight. Comparing the
                // archived weight against that raw number would reject an honest archive; the
                // debits recorded after the block restore it to what the hub actually saw.
                let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
                let staked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
                let slashedSource = 'src_' + crossKeys[0].pubkey.slice(0, 16);
                let cross = capSetFromKeys(crossKeys);
                cross[0].weight = '2';                                   // 3 of its 5 burned later
                let btcDb = btcDbStub(staked, {
                    capSets: { cross_chain: cross, oracle_publish: capSetFromKeys(oracleKeys) },
                    localFloor: '1',
                    slashRestores: [{ source: slashedSource, restored: '3' }]
                });
                let report = await new AnchorRecovery(memDb([v1], []),
                    Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
                assert.deepStrictEqual(report.failed, [], 'a weight restored by its slash debits must match the archive');
                assert.strictEqual(report.verified, 1);
            });
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('completeness cross-check (REC-SUBSET-1)', function () {
        describe('as-of-block threshold + weight reconstruction', function () {
            it('condemns that same archive when the slash is NOT unwound', async function () {
                // The control for the test above: without the capability_slash_debits
                // reconstruction the post-slash weight is all there is, so the honest archived
                // weight reads as forged - which is exactly why the archived amount had to be
                // taken on trust before.
                let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
                let staked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
                let cross = capSetFromKeys(crossKeys);
                cross[0].weight = '2';
                let btcDb = btcDbStub(staked, {
                    capSets: { cross_chain: cross, oracle_publish: capSetFromKeys(oracleKeys) },
                    localFloor: '1'                                   // no slashRestores
                });
                let report = await new AnchorRecovery(memDb([v1], []),
                    Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
                assert.strictEqual(report.verified, 0);
                assert.ok(report.failed[0].reason.includes('forged weight'));
            });

            it('rejects an archive that understates a source weight (S-deflation forge)', async function () {
                // The archived per-source amount IS the quorum denominator S. Understating other
                // sources lowers the bar a forged signature set must clear, and nothing checked
                // it until the as-of-block weights existed to check it against.
                let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);   // archives weight 5
                let staked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
                let cross = capSetFromKeys(crossKeys);
                cross[0].weight = '9';                                   // on-chain it held 9, not 5
                let btcDb = btcDbStub(staked, {
                    capSets: { cross_chain: cross, oracle_publish: capSetFromKeys(oracleKeys) },
                    localFloor: '1'
                });
                let report = await new AnchorRecovery(memDb([v1], []),
                    Object.assign({ btcDb, verifyStakes: true }, quiet)).run();
                assert.strictEqual(report.verified, 0);
                assert.ok(report.failed[0].reason.includes('forged weight'));
                assert.ok(report.failed[0].reason.includes('archived 5, on-chain as of that block 9'));
            });
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('completeness cross-check (REC-SUBSET-1)', function () {
        describe('as-of-block threshold + weight reconstruction', function () {
            it('rejects a snapshot spelling two weights for one source', async function () {
                // Every key of a source carries the SAME aggregate (capability_snapshots.sql),
                // so two spellings are a way to hide an inflated weight behind an honest row.
                let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
                let staked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
                // Two archived rows for ONE source: the fixture's per-key sources are distinct,
                // so drive verifyWeightedCompleteness directly with the crafted group.
                let rec = new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: btcDbStub(staked, {}) }, quiet));
                let g = { capability: 'cross_chain', block: 100, rows: [
                    { source: 'src_a', signing_pubkey: 'a'.repeat(64), amount: '5' },
                    { source: 'src_a', signing_pubkey: 'b'.repeat(64), amount: '50' }] };
                await assert.rejects(() => rec.verifyWeightedCompleteness(g, [], 94, '1'),
                                     /two different weights/);
            });
        });
    });
});
