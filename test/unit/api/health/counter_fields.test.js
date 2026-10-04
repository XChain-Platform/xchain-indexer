/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

const assert = require('assert');

const { actionCounters, reorgFields } = require('../../../../src/api/health/counter_fields');

describe('health counter fields', function () {
    describe('actionCounters()', function () {
        it('returns the action counters from the indexer', function () {
            const counters = { accepted: 4, rejected: 2 };
            const indexer = { actions: { getActionCounters: () => counters } };

            assert.strictEqual(actionCounters(indexer), counters);
        });

        it('returns null when actions are missing', function () {
            assert.strictEqual(actionCounters({}), null);
        });

        it('returns null when the counter method is missing', function () {
            assert.strictEqual(actionCounters({ actions: {} }), null);
        });
    });

    describe('reorgFields()', function () {
        it('maps the reorg statistics', function () {
            const stats = {
                reorgsProcessed: 7,
                lastReorgBlock:  123456,
                lastReorgAt:     1770000000000
            };

            assert.deepStrictEqual(reorgFields(stats), stats);
        });

        it('returns null fields when statistics are null or undefined', function () {
            const empty = {
                reorgsProcessed: null,
                lastReorgBlock:  null,
                lastReorgAt:     null
            };

            assert.deepStrictEqual(reorgFields(null), empty);
            assert.deepStrictEqual(reorgFields(undefined), empty);
        });
    });
});
