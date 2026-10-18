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
 * Unit: train activation halt reason predicate
 */

'use strict';

const assert = require('assert');
const {
    TRAIN_ACTIVATION_HALT_PREFIX,
    isTrainActivationHalt
} = require('../../../../src/XChainIndexer/stall_health.js');

describe('isTrainActivationHalt()', function () {
    it('recognizes train activation halt reasons', function () {
        assert.strictEqual(TRAIN_ACTIVATION_HALT_PREFIX, 'train_activation_halt:');
        assert.strictEqual(isTrainActivationHalt('train_activation_halt: rule set 3 required at 900'), true);
        assert.strictEqual(isTrainActivationHalt(
            'train_activation_halt: train_activation: the activation gate itself failed to evaluate (x); refusing to advance'
        ), true);
    });

    it('rejects absent, non-string and unrelated stall reasons', function () {
        for (const reason of [
            null,
            undefined,
            '',
            42,
            'price_sync_barrier',
            'bridge_proof_barrier',
            'train_activation: pending'
        ]) {
            assert.strictEqual(isTrainActivationHalt(reason), false, String(reason));
        }
    });
});
