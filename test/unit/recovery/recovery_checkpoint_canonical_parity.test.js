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

// bin/recovery.js checkpointCanonical re-verifies archived state_checkpoints rows against
// the archived oracle_publish set, so it must rebuild the hub's gated XCHECKPOINT bytes.
// The cross-repo parity suite pins the bridge-proof mirrored-row rebuild
// (checkpoint_source.js) to the hub on a root-bearing post-flag-day row, so matching that
// copy there, plus frozen strings for the rootless quadrants, carries any hub suffix
// change through to this copy instead of leaving recovery to fail quorum silently.

const assert = require('assert');

const AnchorRecovery   = require('../../../bin/recovery.js');
const checkpointSource = require('../../../src/consensus/bridge_proof_client/checkpoint_source.js');
const gateRegistry     = require('../../../src/consensus/gate_registry');
const eq               = require('../../../src/consensus/equivocation_header.js');

const CKPT_KEY     = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
const STATE_ROOT   = 'D4'.repeat(32);
const BLOCK_MERKLE = 'E5'.repeat(32);

// One checkpoint row; roots are upper-case so the lower-casing is pinned too.
function row(network, snapshotBlock, withRoots) {
    return {
        chain: 'BTC', network, block_index: 500, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 7, snapshot_block: snapshotBlock,
        state_root:           withRoots ? STATE_ROOT : null,
        state_root_version:   withRoots ? 1 : null,
        block_merkle_root:    withRoots ? BLOCK_MERKLE : null,
        block_merkle_version: withRoots ? 2 : null
    };
}

// The ten-field base written out by hand, independent of every builder.
function frozenBase(network, snapshotBlock) {
    return 'XCHECKPOINT|BTC|' + network + '|500|' + 'c0'.repeat(32) + '|' + 'a1'.repeat(32) + '|' +
        'b2'.repeat(32) + '|' + 'c3'.repeat(32) + '|7|' + snapshotBlock;
}

const SUFFIX = '|' + STATE_ROOT.toLowerCase() + '|1|' + BLOCK_MERKLE.toLowerCase() + '|2';

describe('recovery checkpointCanonical: parity with the gated checkpoint family @regression @tier1', function () {
    it('post-flag-day, roots present: byte-identical to the mirrored-row rebuild the parity suite pins to the hub', function () {
        const cp = row('regtest', 100, true);
        assert.strictEqual(gateRegistry.activeAt(CKPT_KEY, 'regtest', null, 100, null), true,
            'premise: regtest@100 must sit at or above CHECKPOINT_COMMITMENT');
        const actual = AnchorRecovery.checkpointCanonicalForTest(cp);
        assert.strictEqual(actual, checkpointSource.checkpointCanonical(cp));
        const roundId = 'BTC|regtest|500|7';
        assert.strictEqual(actual,
            eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, frozenBase('regtest', 100) + SUFFIX));
    });

    it('below the flag day, roots present: the rootless hub form, which the mirrored-row rebuild extends', function () {
        const cp = row('mainnet', 1000, true);
        assert.strictEqual(gateRegistry.activeAt(CKPT_KEY, 'mainnet', null, 1000, null), false,
            'premise: mainnet@1000 must sit below CHECKPOINT_COMMITMENT');
        assert.strictEqual(eq.isEquivHeaderActive(1000, 'mainnet'), false, 'premise: no EQUIV wrap at mainnet@1000');
        const actual = AnchorRecovery.checkpointCanonicalForTest(cp);
        assert.strictEqual(actual, frozenBase('mainnet', 1000));
        assert.strictEqual(checkpointSource.checkpointCanonical(cp), actual + SUFFIX);
    });

    it('post-flag-day, null roots (a legacy archived row): stays on the rootless canonical', function () {
        const actual = AnchorRecovery.checkpointCanonicalForTest(row('regtest', 100, false));
        assert.strictEqual(actual,
            eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|7', 0, frozenBase('regtest', 100)));
        assert.ok(!actual.includes('null'), 'a null root must never be stringified into the canonical');
    });
});
