/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { deriveListSnapshotId } = require('../../../src/consensus/list_share_settle/canonical.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const VECTOR_PATH = path.resolve(
    __dirname,
    '../../../../xchain-documentation/protocol/test-vectors/list_share.json',
);

describe('list share snapshot id', function () {
    it('derives the testnet DOGE list 880001 sequence 1 snapshot id', function () {
        assert.strictEqual(
            deriveListSnapshotId('testnet', 'DOGE', 880001, 1, 160000),
            'c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21',
        );
    });

    it('matches every canonical snapshotIds vector', function () {
        const verdict = siblingCheckout(__dirname, VECTOR_PATH);
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the canonical list share snapshot id vectors');

        const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'));
        for (const vector of vectors.snapshotIds) {
            assert.strictEqual(
                deriveListSnapshotId(
                    vector.network,
                    vector.homeChain,
                    vector.homeListIndex,
                    vector.seq,
                    vector.snapshotBlock,
                ),
                vector.expected,
                vector.name,
            );
        }
    });
});
