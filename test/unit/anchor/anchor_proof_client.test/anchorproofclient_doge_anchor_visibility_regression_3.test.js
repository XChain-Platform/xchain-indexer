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
 * test/unit/anchor/anchor_proof_client.test/anchorproofclient_doge_anchor_visibility_regression_3.test.js
 *
 * Sibling block of the anchor_proof_client.test.js suite, carrying:
 *   AnchorProofClient (DOGE anchor visibility) @regression @tier2
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const AnchorProofClient = require('../../../../src/consensus/doge_peer_clients/anchor_proof_client.js');

const TXID = 'b'.repeat(64);





function anchor(overrides) {
    return Object.assign({
        status: 'valid', version: 1,
        checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
        block_index: 500, checkpoint_seq: 99, snapshot_block: 900,
        publisher: 'aa'.repeat(32), match_batch_seq: 12,
        block_index_doge: 100, confirmations: 60
    }, overrides || {});
}

function expectation(overrides) {
    return Object.assign({
        txid: TXID, rewardType: 'anchor_archive', roundReference: 12,
        snapshotBlock: 900, publisher: 'aa'.repeat(32),
        network: 'regtest', minConfirmations: 60
    }, overrides || {});
}

function client() { return new AnchorProofClient({ COIN: 'BTC', NETWORK: 'regtest' }, { url: 'http://doge.invalid/' }); };

function sibling() { return anchor({ match_batch_seq: 999 }); }

const SNAP = 150208;

function section(overrides) {
return Object.assign({
status: 'valid', version: 0,
checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
block_index: 150208, checkpoint_seq: SNAP, snapshot_block: SNAP,
publisher: 'aa'.repeat(32), match_batch_seq: null,
block_index_doge: 100, confirmations: 60
}, overrides || {});
}

function bundle(overrides) {
return [section(Object.assign({ checkpoint_chain: 'BTC'  }, overrides || {})),
section(Object.assign({ checkpoint_chain: 'DOGE' }, overrides || {})),
section(Object.assign({ checkpoint_chain: 'LTC'  }, overrides || {}))];
}

function bundleReward(overrides) {
return expectation(Object.assign({
rewardType: 'anchor_bundle', roundReference: SNAP, snapshotBlock: SNAP
}, overrides || {}));
}

function ownBundle() {
return bundle().map((s, i) => Object.assign(s, { action_index: 41, section_index: i }));
}

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    describe('_judge: the v0 bundle leg', function () {
        // A DOGE transaction is not limited to one anchor action: BATCH gives each command its
        // own action_index, so anyone can ride a second ANCHOR on the transaction that carries
        // the hub's, and even a bundle too malformed to yield a section still writes a row
        // carrying its header snapshot block. Reconstructing the header as a maximum over the
        // whole TRANSACTION let such a row raise it above the real bundle's, so no genuine
        // section equalled it and judge fell through to a permanent, memoized 'rejected':
        // a legitimate COLLECT-spendable reward destroyed by a third-party write.
        describe('an unrelated anchor on the same transaction cannot suppress the reward', function () {
        // Someone else's bundle on the same transaction, at a HIGHER snapshot block.
        function sibling(overrides) {
        return section(Object.assign({
        action_index: 42, section_index: 0, snapshot_block: SNAP + 6,
        checkpoint_seq: SNAP + 6
        }, overrides || {}));
        }

        it('judges each bundle against its own header when the rows carry action identity', function () {
        const rows = ownBundle().concat([sibling({ status: 'invalid: bad sigs' })]);
        assert.strictEqual(client().judge(rows, bundleReward()), 'verified');
        });

        it('is not suppressed by a sibling whose invalidity is a NODE-CLASS verdict', function () {
        // These stay candidates on purpose (two nodes reading different DOGE indexers
        // must not decide a reward oppositely), so filtering cannot save this case and
        // only the per-action grouping can. A forged sibling naming the real publisher
        // is cheap, which is why the identity is the fix rather than the filter.
        const rows = ownBundle().concat([sibling({ status: 'invalid: SECTION 1 insufficient' })]);
        assert.strictEqual(client().judge(rows, bundleReward()), 'verified');
        });

        it('judges two VALID bundles on one transaction against their own headers', function () {
        const other = section({ action_index: 42, section_index: 0,
        snapshot_block: SNAP + 6, checkpoint_seq: SNAP + 6 });
        const rows  = ownBundle().concat([other]);
        assert.strictEqual(client().judge(rows, bundleReward()), 'verified',
        'the lower bundle still proves its own reward');
        assert.strictEqual(client().judge(rows, bundleReward({
        roundReference: SNAP + 6, snapshotBlock: SNAP + 6
        })), 'verified', 'and so does the higher one');
        });

        // Old peers serve no action_index. Answering 'unknown' there would halt block
        // processing fleet-wide, so the fallback keeps one maximum but narrows it to rows
        // that pass the same predicates the evidence loop applies; a deterministically
        // invalid or wrong-publisher sibling can no longer raise it.
        it('falls back to a FILTERED maximum against a peer serving no row identity', function () {
        for (const bad of [{ status: 'invalid: bad sigs' },
        { publisher: 'bb'.repeat(32) },
        { checkpoint_network: 'testnet' }]) {
        const rows = bundle().concat([section(Object.assign(
        { snapshot_block: SNAP + 6, checkpoint_seq: SNAP + 6 }, bad))]);
        assert.strictEqual(client().judge(rows, bundleReward()), 'verified',
        JSON.stringify(bad));
        }
        });
        });
        });
});

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    function sibling() { return anchor({ match_batch_seq: 999 }); }
    const SNAP = 150208;
    function section(overrides) {
    return Object.assign({
    status: 'valid', version: 0,
    checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
    block_index: 150208, checkpoint_seq: SNAP, snapshot_block: SNAP,
    publisher: 'aa'.repeat(32), match_batch_seq: null,
    block_index_doge: 100, confirmations: 60
    }, overrides || {});
    }
    function bundle(overrides) {
    return [section(Object.assign({ checkpoint_chain: 'BTC'  }, overrides || {})),
    section(Object.assign({ checkpoint_chain: 'DOGE' }, overrides || {})),
    section(Object.assign({ checkpoint_chain: 'LTC'  }, overrides || {}))];
    }
    function bundleReward(overrides) {
    return expectation(Object.assign({
    rewardType: 'anchor_bundle', roundReference: SNAP, snapshotBlock: SNAP
    }, overrides || {}));
    }
    function ownBundle() {
    return bundle().map((s, i) => Object.assign(s, { action_index: 41, section_index: i }));
    }

    describe('_judge: the v0 bundle leg', function () {
    describe('an unrelated anchor on the same transaction cannot suppress the reward', function () {
    // The header binding itself must not loosen: a LAGGING section of the reward's OWN
    // bundle still rides at its own older block and still cannot prove a reward there.
    it('still refuses a lagging section of its own bundle as proof at that older block', function () {
    const rows = ownBundle().concat([section({
    action_index: 41, section_index: 3,
    snapshot_block: SNAP - 40, checkpoint_seq: SNAP - 40
    })]);
    assert.strictEqual(client().judge(rows, bundleReward({
    roundReference: SNAP - 40, snapshotBlock: SNAP - 40
    })), 'rejected');
    });
    });
    });
});

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    function sibling() { return anchor({ match_batch_seq: 999 }); }
    const SNAP = 150208;
    function section(overrides) {
    return Object.assign({
    status: 'valid', version: 0,
    checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
    block_index: 150208, checkpoint_seq: SNAP, snapshot_block: SNAP,
    publisher: 'aa'.repeat(32), match_batch_seq: null,
    block_index_doge: 100, confirmations: 60
    }, overrides || {});
    }
    function bundle(overrides) {
    return [section(Object.assign({ checkpoint_chain: 'BTC'  }, overrides || {})),
    section(Object.assign({ checkpoint_chain: 'DOGE' }, overrides || {})),
    section(Object.assign({ checkpoint_chain: 'LTC'  }, overrides || {}))];
    }
    function bundleReward(overrides) {
    return expectation(Object.assign({
    rewardType: 'anchor_bundle', roundReference: SNAP, snapshotBlock: SNAP
    }, overrides || {}));
    }
    function ownBundle() {
    return bundle().map((s, i) => Object.assign(s, { action_index: 41, section_index: i }));
    }

    describe('_judge: the retired per-chain leg', function () {
    it('exposes the live and pre-restart attested versions', function () {
    // 0/1 are the live wires; 4-7 are the pre-restart bytes, kept so an attested
    // reward maturing after the version restart still finds its anchor (6/7 prove
    // their renumbered family, 4/5 reject deterministically via the family map).
    assert.deepStrictEqual(AnchorProofClient.ATTESTED_VERSIONS.slice().sort((a, b) => a - b), [0, 1, 4, 5, 6, 7]);
    });

    it('rejects every per-chain reward_type, whatever the transaction carries', function () {
    const c = client();
    for (const chain of ['BTC', 'DOGE', 'LTC']) {
    const e = expectation({ rewardType: 'anchor_' + chain });
    assert.strictEqual(c.judge([anchor({ checkpoint_chain: chain })], e), 'rejected', chain);
    assert.strictEqual(c.judge([anchor({ version: 4, checkpoint_chain: chain })], e), 'rejected', chain + '/v4');
    assert.strictEqual(c.judge([], e), 'rejected', chain + '/empty');
    }
    });

    it('leaves the two live legs proving their own rewards', function () {
    const c = client();
    assert.strictEqual(c.judge([anchor({ checkpoint_chain: 'LTC' })], expectation()), 'verified');
    assert.strictEqual(
    c.judge([anchor({ version: 0, match_batch_seq: null, checkpoint_seq: 900 })],
    expectation({ rewardType: 'anchor_bundle', roundReference: 900 })), 'verified');
    });
    });
});

// A sibling attested anchor that is NOT this tuple's: on its own it makes judge

// return the permanent 'rejected'.

// getanchorconfirmations bounds its answer. Before the walk below, a window cut off

// BEFORE the matching anchor looked identical on the wire to a complete non-matching

// set: judge read a positively-detected mis-bind, proveMined MEMOIZED it, and

// anchor_reward_derive turned that into "no reward derived" forever - a legitimate

// COLLECT-spendable reward lost silently and permanently. Reinterpreting the verdict

// was not an option: 'unknown' raises AnchorProofUnavailableError, which HALTS block

// processing on every BTC node and never clears, because the same deterministic window

// returns on every retry. So the window is removed instead, and judge is handed the

// complete set it always assumed it had.

// The three sections of one bundle, exactly as the live anchor carries them.

// The reward's own bundle, with the row identity a current DOGE indexer serves.

// section under one action_index, one publisher tail, and exactly ONE reward of type

// BUNDLE, never to a chain: proving it mined is finding the v0 anchor at that txid whose

//

// bundle transaction with N version-0 entries sharing publisher, network and status, each

// The per-chain leg is RETIRED with its wires. Its already-attested rewards stay

// deterministic permanent NO rather than an 'unknown' that would wedge the block loop
