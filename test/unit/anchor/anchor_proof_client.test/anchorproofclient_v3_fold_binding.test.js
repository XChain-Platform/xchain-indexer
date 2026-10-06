/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/anchor/anchor_proof_client.test/anchorproofclient_v3_fold_binding.test.js
 *
 * The BTC-side reward proof against v3 fold anchors: a fold's chain sections
 * prove its anchor_bundle reward, its archive row never does, and the version
 * lists stay in step with the DOGE parse so a new wire cannot halt the chain.
 */
'use strict';

const assert = require('assert');
const AnchorProofClient = require('../../../../src/consensus/doge_peer_clients/anchor_proof_client.js');
const binding = require('../../../../src/consensus/doge_peer_clients/anchor_proof_client/binding.js');
const { CHECKPOINT_VERSIONS } = require('../../../../src/db/anchor_sql.js');
const { rewardTypeFor } = require('../../../../src/actions/anchor/reward_family.js');
const Anchor = require('../../../../src/actions/anchor/index.js');

const TXID = 'c'.repeat(64);
const SNAP = 150208;
const PUBLISHER = 'aa'.repeat(32);

// Build one v3 chain-section row as getanchorconfirmations serves it.
function foldSection(overrides) {
    return Object.assign({
        status: 'valid', version: 3, action_index: 51, section_index: 0,
        checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
        block_index: SNAP, checkpoint_seq: SNAP, snapshot_block: SNAP,
        publisher: PUBLISHER, match_batch_seq: null,
        block_index_doge: 100, confirmations: 60
    }, overrides || {});
}

// Build the fold's archive row: no chain, a batch seq, the header block.
function foldArchive(overrides) {
    return foldSection(Object.assign({
        checkpoint_chain: null, block_index: null, checkpoint_seq: null,
        match_batch_seq: 72
    }, overrides || {}));
}

// Build a full fold: two sections at the header, one lagging, then the archive row.
function fold() {
    return [
        foldSection({ section_index: 0, checkpoint_chain: 'BTC' }),
        foldSection({ section_index: 1, checkpoint_chain: 'DOGE' }),
        foldSection({ section_index: 2, checkpoint_chain: 'LTC',
            snapshot_block: SNAP - 40, checkpoint_seq: SNAP - 40 }),
        foldArchive({ section_index: 3 })
    ];
}

function bundleReward(overrides) {
    return Object.assign({
        txid: TXID, rewardType: 'anchor_bundle', roundReference: SNAP,
        snapshotBlock: SNAP, publisher: PUBLISHER,
        network: 'regtest', minConfirmations: 60
    }, overrides || {});
}

function client() { return new AnchorProofClient({ COIN: 'BTC', NETWORK: 'regtest' }, { url: 'http://doge.invalid/' }); }

describe('AnchorProofClient v3 fold binding @regression @tier2', () => {
    describe('a fold proves its own anchor_bundle reward', function () {
        it('verifies the reward at the fold header block once buried', function () {
            assert.strictEqual(client().judge(fold(), bundleReward()), 'verified');
        });

        it('answers unknown for a matching fold that is still too shallow', function () {
            const rows = fold().map(r => Object.assign(r, { confirmations: 5 }));
            assert.strictEqual(client().judge(rows, bundleReward()), 'unknown');
        });

        it('refuses the lagging section as proof at its own older block', function () {
            assert.strictEqual(client().judge(fold(), bundleReward({
                roundReference: SNAP - 40, snapshotBlock: SNAP - 40
            })), 'rejected');
        });

        it('rejects rather than defers a fold naming another publisher', function () {
            assert.strictEqual(client().judge(fold(), bundleReward({
                publisher: 'bb'.repeat(32)
            })), 'rejected');
        });
    });
});

describe('AnchorProofClient v3 fold binding @regression @tier2', () => {
    describe('a fold archive row is never bundle proof', function () {
        it('rejects an archive-only fold offered as bundle proof at its header block', function () {
            const rows = [foldArchive({ action_index: 60, section_index: 0 })];
            assert.strictEqual(client().judge(rows, bundleReward()), 'rejected');
        });

        it('rejects an empty fold row (no chain, no archive) as bundle proof', function () {
            const rows = [foldArchive({ action_index: 61, match_batch_seq: null })];
            assert.strictEqual(client().judge(rows, bundleReward()), 'rejected');
        });

        it('keeps a fold archive row from raising a header it does not belong to', function () {
            // The archive row is excluded from header reconstruction, so a row above the
            // sections in the same action cannot lift the header past every real section.
            const rows = fold().concat([foldArchive({ section_index: 4,
                snapshot_block: SNAP + 6 })]);
            assert.strictEqual(client().judge(rows, bundleReward()), 'verified');
        });

        it('keeps an archive-only fold from raising the old-peer header maximum', function () {
            const strip = r => { delete r.action_index; delete r.section_index; return r; };
            const v0 = ['BTC', 'DOGE', 'LTC'].map(c => strip(foldSection({
                version: 0, checkpoint_chain: c })));
            const rows = v0.concat([strip(foldArchive({ snapshot_block: SNAP + 6 }))]);
            assert.strictEqual(client().judge(rows, bundleReward()), 'verified');
        });

        it('never lets a v3 row prove an anchor_archive reward', function () {
            const e = bundleReward({ rewardType: 'anchor_archive', roundReference: 72 });
            assert.strictEqual(client().judge(fold(), e), 'rejected');
        });
    });
});

describe('AnchorProofClient v3 fold binding @regression @tier2', () => {
    describe('status handling matches the v0 bundle leg', function () {
        it('drops a deterministically invalid fold as evidence and rejects', function () {
            const rows = fold().map(r => Object.assign(r, {
                status: 'invalid: SECTION 0 CHECKPOINT_SEQ (stale; replay of an older checkpoint)' }));
            assert.strictEqual(client().judge(rows, bundleReward()), 'rejected');
        });

        it('rejects, never defers, a v3 byte parsed before the fold was armed', function () {
            const rows = [foldArchive({ status: 'invalid: VERSION (unknown)',
                match_batch_seq: null })];
            assert.strictEqual(client().judge(rows, bundleReward()), 'rejected');
        });

        it('keeps a node-class-dependent status as evidence, like v0', function () {
            const rows = fold().map(r => Object.assign(r, { status: 'unverified' }));
            assert.strictEqual(client().judge(rows, bundleReward()), 'verified');
        });
    });

    describe('a fold and an unrelated v0 bundle on one transaction', function () {
        it('judges each against its own header', function () {
            const v0 = ['BTC', 'DOGE'].map((c, i) => foldSection({
                version: 0, action_index: 52, section_index: i, checkpoint_chain: c,
                snapshot_block: SNAP + 6, checkpoint_seq: SNAP + 6 }));
            const rows = fold().concat(v0);
            assert.strictEqual(client().judge(rows, bundleReward()), 'verified', 'the fold');
            assert.strictEqual(client().judge(rows, bundleReward({
                roundReference: SNAP + 6, snapshotBlock: SNAP + 6 })), 'verified', 'the v0 bundle');
        });
    });
});

describe('AnchorProofClient v3 fold binding @regression @tier2', () => {
    describe('version lists stay in step with the DOGE parse', function () {
        it('gives every rewarded checkpoint version an attested family on the BTC side', function () {
            for (const v of CHECKPOINT_VERSIONS) {
                for (const foldActive of [false, true]) {
                    const type = rewardTypeFor(v, foldActive);
                    if (type === 'anchor_bundle') {
                        assert.ok(binding.REWARD_FAMILY_VERSIONS.bundle.includes(v), 'bundle family lacks v' + v);
                        assert.ok(binding.ATTESTED_VERSIONS.includes(v), 'attested set lacks v' + v);
                    }
                    if (type === 'anchor_archive') {
                        assert.ok(binding.REWARD_FAMILY_VERSIONS.archive.includes(v), 'archive family lacks v' + v);
                        assert.ok(binding.ATTESTED_VERSIONS.includes(v), 'attested set lacks v' + v);
                    }
                }
            }
        });

        // Walk the parser's own wire table, not CHECKPOINT_VERSIONS: a version added to the
        // DOGE parse but to no hand-kept list must still fail here, not defer a block forever.
        it('gives every publisher-carrying wire in the parse table an attested family', function () {
            const formats = new Anchor({}).formats;
            const versions = Object.keys(formats).map(Number);
            assert.ok(versions.length > 0, 'the parse table is empty');
            for (const v of versions) {
                for (const foldActive of [false, true]) {
                    const type = rewardTypeFor(v, foldActive);
                    if (type === 'anchor_bundle')
                        assert.ok(binding.REWARD_FAMILY_VERSIONS.bundle.includes(v), 'bundle family lacks v' + v);
                    if (type === 'anchor_archive')
                        assert.ok(binding.REWARD_FAMILY_VERSIONS.archive.includes(v), 'archive family lacks v' + v);
                    if (type !== null)
                        assert.ok(binding.ATTESTED_VERSIONS.includes(v), 'attested set lacks rewarded v' + v);
                }
                if (String(formats[v]).split('|').includes('PUBLISHER'))
                    assert.ok(binding.ATTESTED_VERSIONS.includes(v), 'attested set lacks publisher-carrying v' + v);
            }
        });

        it('keeps the fold wire out of the archive family', function () {
            assert.ok(!binding.REWARD_FAMILY_VERSIONS.archive.includes(3));
        });

        it('leaves every non-v3 row a bundle section candidate', function () {
            for (const v of [0, 1, 4, 5, 6, 7])
                assert.strictEqual(binding.isBundleSectionRow({ version: v, checkpoint_chain: null, match_batch_seq: 9 }), true, 'v' + v);
        });
    });
});
