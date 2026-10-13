'use strict';

const assert = require('assert');
const { judgeAnchors } = require('../../../../src/consensus/doge_peer_clients/anchor_proof_client/binding.js');

const SNAP = 150208;

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
        rewardType: 'anchor_archive', roundReference: 12,
        snapshotBlock: 900, publisher: 'aa'.repeat(32),
        network: 'regtest', minConfirmations: 60
    }, overrides || {});
}

function section(overrides) {
    return Object.assign({
        status: 'valid', version: 0,
        checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
        block_index: SNAP, checkpoint_seq: SNAP, snapshot_block: SNAP,
        publisher: 'aa'.repeat(32), match_batch_seq: null,
        block_index_doge: 100, confirmations: 60
    }, overrides || {});
}

function bundleReward(overrides) {
    return expectation(Object.assign({
        rewardType: 'anchor_bundle', roundReference: SNAP, snapshotBlock: SNAP
    }, overrides || {}));
}

describe('judgeAnchors legacyDropped', function () {
    describe('archive head', function () {
        it('judges a buried v6 head verified without the flag', function () {
            assert.strictEqual(judgeAnchors([anchor({ version: 6 })], expectation()), 'verified');
        });
        it('judges a buried v6 head rejected with the flag', function () {
            assert.strictEqual(judgeAnchors([anchor({ version: 6 })], expectation({ legacyDropped: true })), 'rejected');
        });
        it('still judges a v1 head verified with the flag', function () {
            assert.strictEqual(judgeAnchors([anchor()], expectation({ legacyDropped: true })), 'verified');
        });
        it('keeps a v6 head verified under a non-true flag', function () {
            for (let flag of [1, 'true', false, null]) {
                assert.strictEqual(judgeAnchors([anchor({ version: 6 })], expectation({ legacyDropped: flag })), 'verified');
            }
        });
    });

    describe('bundle section', function () {
        it('judges a v7 section verified without the flag', function () {
            assert.strictEqual(judgeAnchors([section({ version: 7 })], bundleReward()), 'verified');
        });
        it('judges a v7 section rejected with the flag', function () {
            assert.strictEqual(judgeAnchors([section({ version: 7 })], bundleReward({ legacyDropped: true })), 'rejected');
        });
        it('still judges a v0 section verified with the flag', function () {
            assert.strictEqual(judgeAnchors([section()], bundleReward({ legacyDropped: true })), 'verified');
        });
        it('keeps a v7 section verified under a non-true flag', function () {
            for (let flag of [1, 'true']) {
                assert.strictEqual(judgeAnchors([section({ version: 7 })], bundleReward({ legacyDropped: flag })), 'verified');
            }
        });
    });

    describe('old-peer bundle without action_index', function () {
        let rows = function () { return [section(), section({ version: 7, snapshot_block: SNAP + 50 })]; };
        it('lets a higher v7 sibling raise the header maximum without the flag', function () {
            assert.strictEqual(judgeAnchors(rows(), bundleReward()), 'rejected');
        });
        it('ignores the v7 sibling for the header maximum with the flag', function () {
            assert.strictEqual(judgeAnchors(rows(), bundleReward({ legacyDropped: true })), 'verified');
        });
    });
});
