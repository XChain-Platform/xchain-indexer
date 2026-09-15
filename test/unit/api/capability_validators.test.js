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
 **********************************************************************
 * test/unit/api/capability_validators.test.js
 *
 * Unit tests for the named request-validation and logging steps used by the
 * getcapabilityvalidators RPC handler.
 */

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const observability = require('../../../src/observability/index.js');
const {
    parseCapabilityRequest,
    unconfiguredCapabilityError,
    notYetIndexedError,
    logGatesFilterStats,
    logSnapshotThreshold
} = require('../../../src/api/capability_validators.js');

describe('capability validator request steps', function () {
    afterEach(function () { sinon.restore(); });

    describe('parseCapabilityRequest()', function () {
        it('reports capability errors before block errors', function () {
            assert.deepStrictEqual(parseCapabilityRequest({}),
                { error: 'capability is required' });
            assert.deepStrictEqual(parseCapabilityRequest({ capability: 7 }),
                { error: 'capability is required' });
        });

        it('reports a missing block before validating its integer form', function () {
            assert.deepStrictEqual(parseCapabilityRequest({ capability: 'attestation' }),
                { error: 'block_index is required' });
            assert.deepStrictEqual(parseCapabilityRequest({
                capability: 'attestation', block_index: null
            }), { error: 'block_index is required' });
        });

        it('rejects non-integer and negative block values with the exact error', function () {
            for(const block_index of ['soon', 1.5, -1]){
                assert.deepStrictEqual(parseCapabilityRequest({
                    capability: 'attestation', block_index
                }), { error: 'block_index must be a non-negative integer' });
            }
        });

        it('normalizes a valid block and accepts genesis', function () {
            assert.deepStrictEqual(parseCapabilityRequest({
                capability: 'attestation', block_index: '12'
            }), { blk: 12 });
            assert.deepStrictEqual(parseCapabilityRequest({
                capability: 'attestation', block_index: 0
            }), { blk: 0 });
        });
    });

    describe('unconfiguredCapabilityError()', function () {
        it('returns the exact capability error when configuration is absent', function () {
            const db = { isCapabilityConfigured: sinon.stub().returns(false) };
            assert.deepStrictEqual(unconfiguredCapabilityError(db, 'price'),
                { error: 'capability not configured: price' });
            assert.ok(db.isCapabilityConfigured.calledOnceWithExactly('price'));
        });

        it('returns null when the capability is configured', function () {
            const db = { isCapabilityConfigured: sinon.stub().returns(true) };
            assert.strictEqual(unconfiguredCapabilityError(db, 'attestation'), null);
        });
    });

});

// Same suite title, second block: one describe callback per four step groups is
// over the 60-line limit, and a sibling block keeps every full title identical
// while a part file would not.
describe('capability validator request steps', function () {
    afterEach(function () { sinon.restore(); });

    describe('notYetIndexedError()', function () {
        it('returns null when the requested block equals the latest block', async function () {
            const db = { getLatestBlockIndex: sinon.stub().resolves(42) };
            assert.strictEqual(await notYetIndexedError(db, 42), null);
        });

        it('returns the exact error when the requested block is one ahead', async function () {
            const db = { getLatestBlockIndex: sinon.stub().resolves(42) };
            assert.deepStrictEqual(await notYetIndexedError(db, 43),
                { error: 'block_index 43 not yet indexed (latest: 42)' });
        });
    });

    describe('operator logging', function () {
        it('logs caller-supplied and local-config threshold sources exactly', function () {
            const info = sinon.stub(observability.getLogger(), 'info');
            logSnapshotThreshold('attestation', 12, 500, 3);
            logSnapshotThreshold('price', 13, undefined, 4);
            assert.deepStrictEqual(info.args, [
                ['getcapabilityvalidators: capability=attestation block=12 ' +
                    'min_stake=500 (caller-supplied) validators=3'],
                ['getcapabilityvalidators: capability=price block=13 ' +
                    'min_stake=local-config validators=4']
            ]);
        });

        it('logs no rules-filter line for empty stats', function () {
            const info = sinon.stub(observability.getLogger(), 'info');
            logGatesFilterStats({});
            assert.ok(info.notCalled);
        });

        it('logs a formatted rules-filter summary when validators were dropped', function () {
            const info = sinon.stub(observability.getLogger(), 'info');
            logGatesFilterStats({ dropped: 2, epochHeight: 20, closeBlock: 25, needed: 3 });
            assert.ok(info.calledOnceWithExactly(
                'getcapabilityvalidators: rules-aware attestation set: dropped 2 ' +
                'validator(s) whose rolled gate list at epoch 20 (closed at block 25) ' +
                'is not a superset of the 3 gate(s) active at the request block'));
        });
    });
});
