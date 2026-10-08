/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/

'use strict';

const assert = require('assert');
const derive = require('../../../../src/consensus/anchor_reward_derive.js');
const binding = require('../../../../src/consensus/doge_peer_clients/anchor_proof_client/binding.js');

const PUBLISHER = 'aa'.repeat(32);

function rewardRow(overrides = {}) {
    return Object.assign({
        reward_type: 'anchor_archive',
        network: 'regtest',
        snapshot_block: 0,
    }, overrides);
}

function archiveAnchor(overrides = {}) {
    return Object.assign({
        status: 'valid',
        version: 1,
        checkpoint_network: 'regtest',
        publisher: PUBLISHER,
        snapshot_block: 12,
        match_batch_seq: 7,
        block_index_doge: 0,
        confirmations: 60,
    }, overrides);
}

function archiveReward(overrides = {}) {
    return Object.assign({
        rewardType: 'anchor_archive',
        network: 'regtest',
        publisher: PUBLISHER,
        snapshotBlock: 12,
        roundReference: 7,
        minConfirmations: 60,
    }, overrides);
}

describe('anchor archive fold-term gate', function () {
    describe('BTC reward derivation', function () {
        it('refuses an archive reward at the regtest term height', function () {
            assert.strictEqual(derive.rowGatesActive(rewardRow()), false);
        });

        it('keeps an archive reward eligible where the term is unarmed', function () {
            assert.strictEqual(derive.rowGatesActive(rewardRow({
                network: 'mainnet', snapshot_block: 1000000,
            })), true);
        });

        it('does not terminate the bundle family', function () {
            assert.strictEqual(derive.rowGatesActive(rewardRow({
                reward_type: 'anchor_bundle',
            })), true);
        });
    });

    describe('DOGE proof binding', function () {
        it('refuses an archive anchor at the regtest term height', function () {
            assert.strictEqual(binding.judgeAnchors([archiveAnchor()], archiveReward()), 'rejected');
        });

        it('keeps archive proof valid where the term is unarmed', function () {
            assert.strictEqual(binding.judgeAnchors([
                archiveAnchor({ checkpoint_network: 'mainnet' }),
            ], archiveReward({ network: 'mainnet' })), 'verified');
        });

        it('does not terminate the bundle family', function () {
            const anchor = archiveAnchor({
                version: 0,
                action_index: 4,
                checkpoint_chain: 'BTC',
                snapshot_block: 12,
                match_batch_seq: null,
            });
            const reward = archiveReward({
                rewardType: 'anchor_bundle',
                roundReference: 12,
            });
            assert.strictEqual(binding.judgeAnchors([anchor], reward), 'verified');
        });
    });
});
