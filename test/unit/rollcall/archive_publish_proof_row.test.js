/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

// Archive publish rows use the oracle publish leaf served by the proof route.

const assert = require('assert');

const {
    ARCHIVE_PUBLISH_CAPABILITY,
    proofCapabilityFor,
    proofRowFor,
} = require('../../../src/consensus/archive_publish_set.js');
const { verifyCapabilitySnapshotProof } = require(
    '../../../src/consensus/capability_snapshot_proof/verify.js');

describe('archive_publish proof row mapping @regression @tier1', function(){
    it('maps only archive_publish to the oracle_publish proof capability', function(){
        assert.strictEqual(ARCHIVE_PUBLISH_CAPABILITY, 'archive_publish');
        assert.strictEqual(proofCapabilityFor('archive_publish'), 'oracle_publish');
        for(const capability of ['oracle_publish', 'cross_chain', 'price', 'attestation'])
            assert.strictEqual(proofCapabilityFor(capability), capability);
    });

    it('copies an archive_publish row with only its capability mapped', function(){
        const row = {
            capability: 'archive_publish',
            snapshot_block: 105,
            signing_pubkey: 'aa',
            source: 'archive-a',
            weight: '7',
        };

        const proofRow = proofRowFor(row);

        assert.notStrictEqual(proofRow, row);
        assert.deepStrictEqual(proofRow, { ...row, capability: 'oracle_publish' });
        assert.strictEqual(row.capability, 'archive_publish');
    });

    it('returns the same object when the row already carries its proof capability', function(){
        const row = { capability: 'oracle_publish', snapshot_block: 105 };

        assert.strictEqual(proofRowFor(row), row);
    });

    it('addresses verification to the mapped oracle_publish snapshot', function(){
        const row = { capability: 'archive_publish', snapshot_block: 105 };
        const response = { capability: 'oracle_publish', snapshot_block: 105 };
        const mismatch = 'capability snapshot proof response is for another snapshot';

        const mapped = verifyCapabilitySnapshotProof(
            proofRowFor(row), response, null, { network: 'regtest' });
        const unmapped = verifyCapabilitySnapshotProof(
            row, response, null, { network: 'regtest' });

        assert.notStrictEqual(mapped.reason, mismatch);
        assert.strictEqual(unmapped.reason, mismatch);
    });
});
