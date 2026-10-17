/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const derive = require('../../../../src/consensus/anchor_reward_derive.js');
const AnchorProofClient = require('../../../../src/consensus/doge_peer_clients/anchor_proof_client.js');
const registry = require('../../../../src/consensus/gate_registry.js');

const PUBLISHER = 'aa'.repeat(32);
const TERM_GATE = 'anchor_archive_fold_term_activation.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION';
const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';

// The height a chain's own row reads for one gate: its per-coin entry, else the network's.
function rowHeight(gate, coin, network) {
    const table = registry.get(gate);
    const perCoin = table[coin + ':' + network];
    return perCoin === undefined ? table[network] : perCoin;
}

// The first height at which one chain's domain terminates an archive reward (both gates on).
function terminationHeight(coin, network) {
    return Math.max(rowHeight(TERM_GATE, coin, network), rowHeight(FOLD_GATE, coin, network));
}

// Read a gate height as armed when it is a real height, not the UNARMED sentinel or UNPINNED.
function armed(height) {
    return height !== null && height !== undefined && height !== registry.UNARMED;
}

// Ask BTC derive whether a testnet archive row at this snapshot_block may still mint.
function deriveAllows(snapshotBlock) {
    return derive.rowGatesActive({ reward_type: 'anchor_archive', network: 'testnet', snapshot_block: snapshotBlock });
}

// Ask the DOGE proof client to judge one testnet archive anchor mined at this DOGE height.
function proofVerdict(snapshotBlock, dogeHeight) {
    const client = new AnchorProofClient({ COIN: 'BTC', NETWORK: 'testnet' }, { url: 'http://doge.invalid/' });
    const anchor = {
        status: 'valid', version: 1, checkpoint_network: 'testnet', publisher: PUBLISHER,
        snapshot_block: snapshotBlock, match_batch_seq: 7, block_index_doge: dogeHeight, confirmations: 60,
    };
    const reward = {
        rewardType: 'anchor_archive', network: 'testnet', publisher: PUBLISHER,
        snapshotBlock: snapshotBlock, roundReference: 7, minConfirmations: 60,
    };
    return client.judge([anchor], reward);
}

describe('anchor archive fold-term gate height domains', function () {
    it('terminates on BTC derive at the BTC snapshot_block termination height and not one below', function () {
        const btc = terminationHeight('BTC', 'testnet');
        assert.ok(armed(btc), 'the BTC testnet termination height is armed');
        assert.strictEqual(deriveAllows(btc - 1), true);
        assert.strictEqual(deriveAllows(btc), false);
    });

    it('terminates on the DOGE proof client at the DOGE block_index_doge termination height and not one below', function () {
        const doge = terminationHeight('DOGE', 'testnet');
        const below = terminationHeight('BTC', 'testnet') - 1;
        assert.ok(armed(doge), 'the DOGE testnet termination height is armed');
        assert.strictEqual(proofVerdict(below, doge - 1), 'verified');
        assert.strictEqual(proofVerdict(below, doge), 'rejected');
    });
});

describe('anchor archive fold-term gate height domains', function () {
    // A reward is lost when EITHER domain terminates it, so these two mixed windows pin the union.
    it('drops a reward whose BTC snapshot is below its height but whose DOGE anchor is at or above its own', function () {
        const snapshot = terminationHeight('BTC', 'testnet') - 1;
        const doge = terminationHeight('DOGE', 'testnet');
        assert.strictEqual(deriveAllows(snapshot), true, 'BTC derive alone would keep the reward');
        assert.strictEqual(proofVerdict(snapshot, doge), 'rejected', 'the DOGE proof client refuses it in its own domain');
    });

    it('drops a reward whose BTC snapshot is at its height even when the DOGE anchor is below its own', function () {
        const snapshot = terminationHeight('BTC', 'testnet');
        const doge = terminationHeight('DOGE', 'testnet') - 1;
        assert.strictEqual(proofVerdict(snapshot, doge), 'verified', 'the DOGE proof client alone would keep the reward');
        assert.strictEqual(deriveAllows(snapshot), false, 'BTC derive refuses it in its own domain');
    });
});

describe('anchor archive fold-term gate height domains', function () {
    // Arming one chain's row alone silently moves which archive rewards the union drops, so arm both together.
    it('arms the BTC and DOGE rows of both gates together on every live network', function () {
        for (const gate of [TERM_GATE, FOLD_GATE]) {
            for (const network of ['mainnet', 'testnet']) {
                assert.strictEqual(armed(rowHeight(gate, 'BTC', network)), armed(rowHeight(gate, 'DOGE', network)),
                    gate + ' on ' + network + ' arms one of BTC and DOGE without the other; the archive-reward ' +
                    'termination is the union of both domains, so re-derive which rewards it drops before arming');
            }
        }
    });
});
