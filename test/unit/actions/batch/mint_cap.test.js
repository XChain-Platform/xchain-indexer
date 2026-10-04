// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const {
    probeTickerId,
    maxMintsPerDistinctTick
} = require('../../../../src/actions/batch/mint_cap.js');

const U = Symbol('unresolved');

function makeContext(getTickerId){
    return {
        indexerDb: { suppressIndexIdCreation: false, getTickerId },
        unresolvedTickKey: U,
        probeTickerId,
        maxMintsPerDistinctTick
    };
}

describe('BATCH MINT cap', function () {
    describe('probeTickerId()', function () {
        it('suppresses id creation during the lookup and restores it afterward', async function () {
            const flags = [];
            const ctx = makeContext(async function () {
                flags.push(ctx.indexerDb.suppressIndexIdCreation);
                return 7;
            });

            assert.strictEqual(await ctx.probeTickerId('A'), 7);
            assert.deepStrictEqual(flags, [true]);
            assert.strictEqual(ctx.indexerDb.suppressIndexIdCreation, false);
        });

        it('restores suppression and propagates a lookup error', async function () {
            const error = new Error('lookup failed');
            const flags = [];
            const ctx = makeContext(async function () {
                flags.push(ctx.indexerDb.suppressIndexIdCreation);
                throw error;
            });

            await assert.rejects(ctx.probeTickerId('A'), value => value === error);
            assert.deepStrictEqual(flags, [true]);
            assert.strictEqual(ctx.indexerDb.suppressIndexIdCreation, false);
        });
    });

    describe('maxMintsPerDistinctTick()', function () {
        it('counts resolved ids and one shared unresolved bucket', async function () {
            const ids = new Map([['A', 1], ['B', 2], ['C', null]]);
            const calls = [];
            const ctx = makeContext(async tick => {
                calls.push(tick);
                return ids.get(tick);
            });

            const max = await ctx.maxMintsPerDistinctTick(['A', 'B', 'A', 'A', 'C', '', 'C']);

            assert.strictEqual(max, 3);
            assert.deepStrictEqual(calls, ['A', 'B', 'C']);
        });

        it('returns zero without reading the database for an empty list', async function () {
            const calls = [];
            const ctx = makeContext(async tick => {
                calls.push(tick);
                return 1;
            });

            assert.strictEqual(await ctx.maxMintsPerDistinctTick([]), 0);
            assert.deepStrictEqual(calls, []);
        });
    });
});
