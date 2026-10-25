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
 **********************************************************************
 *
 * Unit coverage for checkpoint supersession canonical and reader rules.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    supersedeSuffix,
    supersededBySeq,
} = require('../../../../src/consensus/retroactive/checkpoint_supersede.js');

const DIGEST = 'AB'.repeat(32);
const row = (checkpointSeq, blockIndex, supersedesFrom, network = 'regtest') => ({
    chain: 'BTC',
    network,
    checkpoint_seq: checkpointSeq,
    block_index: blockIndex,
    supersedes_from: supersedesFrom,
});

describe('checkpoint supersede rules @regression @tier1', function () {
    describe('supersedeSuffix', function () {
        it('returns an empty suffix when supersedes_from and rules_digest are absent or null', function () {
            assert.strictEqual(supersedeSuffix({ block_index: 5 }), '');
            assert.strictEqual(supersedeSuffix({ supersedes_from: null, rules_digest: null }), '');
        });

        it('emits exact SUPERSEDE bytes and lowercases an uppercase rules_digest', function () {
            assert.strictEqual(
                supersedeSuffix({ supersedes_from: '40', rules_digest: DIGEST }),
                '|SUPERSEDE|40|' + DIGEST.toLowerCase()
            );
        });

        it('throws when exactly one supersession field is present', function () {
            assert.throws(() => supersedeSuffix({ supersedes_from: 40 }), /appear together/);
            assert.throws(() => supersedeSuffix({ rules_digest: DIGEST }), /appear together/);
        });

        it('throws when supersedes_from is not a non-negative safe integer', function () {
            assert.throws(() => supersedeSuffix({ supersedes_from: -1, rules_digest: DIGEST }), /safe integer/);
            assert.throws(() => supersedeSuffix({ supersedes_from: 1.5, rules_digest: DIGEST }), /safe integer/);
            assert.throws(() => supersedeSuffix({ supersedes_from: Number.MAX_SAFE_INTEGER + 1, rules_digest: DIGEST }), /safe integer/);
        });

        it('throws when rules_digest is not exactly 64 hexadecimal characters', function () {
            assert.throws(() => supersedeSuffix({ supersedes_from: 4, rules_digest: 'ab' }), /64 hexadecimal/);
            assert.throws(() => supersedeSuffix({ supersedes_from: 4, rules_digest: 'g'.repeat(64) }), /64 hexadecimal/);
        });
    });

    describe('supersededBySeq', function () {
        const rows = [
            row(10, 50, null),
            row(20, 60, null),
            row(30, 70, 55),
            row(25, 65, 50),
        ];

        it('supersedes rows at and above the declared block while leaving a lower block live', function () {
            assert.strictEqual(supersededBySeq(row(10, 50), rows), 25, 'at supersedes_from');
            assert.strictEqual(supersededBySeq(row(20, 60), rows), 25, 'above supersedes_from');
            assert.strictEqual(supersededBySeq(row(20, 49), rows), null, 'below supersedes_from');
        });

        it('reports the lowest checkpoint_seq of two superseders as a Number', function () {
            assert.strictEqual(supersededBySeq(row('10', 60), rows), 25);
            assert.strictEqual(typeof supersededBySeq(row('10', 60), rows), 'number');
        });

        it('ignores a superseder on another network', function () {
            assert.strictEqual(supersededBySeq(row(10, 50), [row(20, 60, 50, 'testnet')]), null);
        });

        it('ignores a superseder whose checkpoint_seq is not higher', function () {
            assert.strictEqual(supersededBySeq(row(30, 70), [row(20, 80, 70)]), null);
        });
    });
});
