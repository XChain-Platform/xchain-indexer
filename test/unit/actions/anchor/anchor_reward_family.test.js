'use strict';

const assert = require('assert');

const { ARCHIVE_REWARD_TYPE } = require('../../../../src/actions/anchor/anchor_reward_key.js');
const { rewardTypeFor } = require('../../../../src/actions/anchor/reward_family.js');

describe('ANCHOR reward family', function () {
    it('uses the canonical archive reward type for an unfolded v1 action', function () {
        assert.strictEqual(rewardTypeFor(1, false), ARCHIVE_REWARD_TYPE);
        assert.strictEqual(rewardTypeFor('1', false), ARCHIVE_REWARD_TYPE);
    });

    it('retires the archive reward type for a folded v1 action', function () {
        assert.strictEqual(rewardTypeFor(1, true), null);
        assert.strictEqual(rewardTypeFor('1', true), null);
    });

    for(const format of [0, '0', 3, '3']){
        it('maps format ' + JSON.stringify(format) + ' to the bundle family on both fold states', function () {
            assert.strictEqual(rewardTypeFor(format, false), 'anchor_bundle');
            assert.strictEqual(rewardTypeFor(format, true), 'anchor_bundle');
        });
    }

    it('returns no reward type for unsupported formats', function () {
        for(const format of [2, '2', '', 'archive', null, undefined]){
            assert.strictEqual(rewardTypeFor(format, false), null);
            assert.strictEqual(rewardTypeFor(format, true), null);
        }
    });
});
