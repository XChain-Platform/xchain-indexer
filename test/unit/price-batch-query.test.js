/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Unit coverage for the getpricebatches RPC's pure logic (api.js delegates
 * to it). The hub's batch publisher uses this answer to decide which buffered
 * windows are ALREADY on chain, so the two properties that matter are: only
 * valid batch rows are asked for, and a truncated answer says so rather than
 * reading as "nothing past here".
 ********************************************************************/

'use strict';

const assert = require('assert');
const { PRICE_BATCHES_SQL, PRICE_BATCHES_DEFAULT_LIMIT, PRICE_BATCHES_MAX_LIMIT,
        validatePriceBatchParams, buildPriceBatchesResponse } = require('../../src/price-batch-query');

describe('price-batch-query (getpricebatches)', function () {

    describe('validatePriceBatchParams', function () {
        it('accepts a closed round range and defaults the limit', function () {
            let v = validatePriceBatchParams({ first_round: 21, last_round: 1568 });
            assert.deepStrictEqual(v, { ok: true, first_round: 21, last_round: 1568, limit: PRICE_BATCHES_DEFAULT_LIMIT });
        });

        it('accepts a single-round range and numeric strings', function () {
            let v = validatePriceBatchParams({ first_round: '49', last_round: '49', limit: '10' });
            assert.deepStrictEqual(v, { ok: true, first_round: 49, last_round: 49, limit: 10 });
        });

        it('refuses a negative, fractional, missing or inverted range', function () {
            assert.strictEqual(validatePriceBatchParams({ first_round: -1, last_round: 5 }).ok, false);
            assert.strictEqual(validatePriceBatchParams({ first_round: 1.5, last_round: 5 }).ok, false);
            assert.strictEqual(validatePriceBatchParams({ last_round: 5 }).ok, false);
            assert.strictEqual(validatePriceBatchParams({ first_round: 5 }).ok, false);
            assert.strictEqual(validatePriceBatchParams({ first_round: 6, last_round: 5 }).ok, false);
            assert.strictEqual(validatePriceBatchParams(null).ok, false);
        });

        it('clamps an oversized limit to the ceiling and refuses a non-positive one', function () {
            assert.strictEqual(validatePriceBatchParams({ first_round: 0, last_round: 1, limit: 10000 }).limit,
                PRICE_BATCHES_MAX_LIMIT);
            assert.strictEqual(validatePriceBatchParams({ first_round: 0, last_round: 1, limit: 0 }).ok, false);
            assert.strictEqual(validatePriceBatchParams({ first_round: 0, last_round: 1, limit: 'x' }).ok, false);
        });
    });

    describe('PRICE_BATCHES_SQL', function () {
        it('asks only for valid version-0 batch rows overlapping the range', function () {
            assert.ok(/version = 0/.test(PRICE_BATCHES_SQL));
            assert.ok(/validation_status = \?/.test(PRICE_BATCHES_SQL));
            assert.ok(/batch_first_round <= \?/.test(PRICE_BATCHES_SQL));
            assert.ok(/batch_last_round >= \?/.test(PRICE_BATCHES_SQL));
            assert.ok(/LIMIT \?/.test(PRICE_BATCHES_SQL));
            // Four placeholders, in the order api.js binds them: status, last, first, limit.
            assert.strictEqual((PRICE_BATCHES_SQL.match(/\?/g) || []).length, 4);
        });
    });

    describe('buildPriceBatchesResponse', function () {
        const V = { first_round: 40, last_round: 60, limit: 3 };

        it('maps rows to plain numbers and echoes the asked range', function () {
            let rows = [
                { action_index: 10n, batch_first_round: '49', batch_last_round: '53', round_count: 5 },
                { action_index: 250, batch_first_round: 40, batch_last_round: 41, round_count: null }
            ];
            let out = buildPriceBatchesResponse('67875698', rows, V);
            assert.deepStrictEqual(out, {
                block_index: 67875698, first_round: 40, last_round: 60,
                batches: [
                    { action_index: 10,  first_round: 49, last_round: 53, round_count: 5 },
                    { action_index: 250, first_round: 40, last_round: 41, round_count: null }
                ],
                truncated: false
            });
        });

        it('flags a full page as truncated so the caller pages instead of reading it as complete', function () {
            let rows = [1, 2, 3].map(i => ({ action_index: i, batch_first_round: i * 2, batch_last_round: i * 2 + 1, round_count: 2 }));
            assert.strictEqual(buildPriceBatchesResponse(1, rows, V).truncated, true);
            assert.strictEqual(buildPriceBatchesResponse(1, rows.slice(0, 2), V).truncated, false);
        });

        it('answers an empty range with an empty list, never null', function () {
            let out = buildPriceBatchesResponse(null, null, V);
            assert.deepStrictEqual(out.batches, []);
            assert.strictEqual(out.block_index, null);
            assert.strictEqual(out.truncated, false);
        });
    });
});
