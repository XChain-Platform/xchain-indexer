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
 * Unit: train activation halts remain degraded until the node is updated
 */

'use strict';

const assert = require('assert');
const { buildHealthResponse } = require('../../../../src/api/health.js');
const {
    stallWedged,
    stallClassOf,
    publishedStallClass
} = require('../../../../src/XChainIndexer/stall_health.js');

const NOW = 10_000_000;
const GRACE_MS = 120_000;
const OLD_COMMIT = NOW - 600_000;
const TRAIN_HALT = 'train_activation_halt: rule set 3 required at 900';

describe('train activation halt stall health @regression', function () {
    it('does not grade a train activation halt past the grace as wedged', function () {
        assert.strictEqual(stallWedged(TRAIN_HALT, OLD_COMMIT, GRACE_MS, NOW), false);
    });

    it('publishes the train activation halt class without rewriting it', function () {
        const stallClass = stallClassOf(TRAIN_HALT, OLD_COMMIT, GRACE_MS, NOW);
        assert.strictEqual(stallClass, 'train_activation_halt');
        assert.strictEqual(publishedStallClass(stallClass, TRAIN_HALT, {}), 'train_activation_halt');
    });

    it('reports a train activation halt as degraded in the health payload', async function () {
        const response = await buildHealthResponse({
            indexer: {
                decoderDb: null,
                indexerDb: null,
                isSynced: () => false,
                lastDecoderBlock: 901,
                lastBlockCommittedAt: OLD_COMMIT,
                healthStallGraceMs: GRACE_MS,
                stallReason: TRAIN_HALT,
                trainActivation: {
                    status: 'halt',
                    activeRuleSet: '2',
                    requiredRuleSet: '3',
                    requiredAtHeight: 900,
                    classification: 'major',
                    reason: 'rule set 3 required at 900'
                }
            },
            indexerRunning: true,
            indexerError: null,
            lastIndexedBlock: 899,
            inFlightBlock: null,
            now: NOW,
            reorgStats: null
        });

        assert.strictEqual(response.degraded, true);
        assert.strictEqual(response.stallClass, 'train_activation_halt');
        assert.strictEqual(response.stallReason, TRAIN_HALT);
    });

    it('still grades a non-train reason past the grace as wedged', function () {
        assert.strictEqual(stallWedged('price_sync_barrier', OLD_COMMIT, GRACE_MS, NOW), true);
        assert.strictEqual(stallClassOf('price_sync_barrier', OLD_COMMIT, GRACE_MS, NOW), 'wedged');
    });
});
