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
 *********************************************************************/

'use strict';

const assert = require('assert');

const { stallFields } = require('../../../../src/api/health/stall_fields');

const REORG_HALT_REASON = 'decoder_reorg_halt: decoder wrote a REORG_HALT marker; ' +
    'resync the decoder, or clear the reviewed halt in place with `xchain-node clear-reorg-halt`';

describe('stallFields() train activation report', function(){

    it('reports an unevaluated train activation before any block is evaluated', function(){
        assert.deepStrictEqual(stallFields({}).train_activation, {
            status: 'unevaluated',
            active_rule_set: null,
            required_rule_set: null,
            required_at_height: null,
            classification: null,
            reason: 'no block has been evaluated against the train activation gate yet'
        });
    });

    it('copies every train activation field into the health shape', function(){
        const trainActivation = {
            status: 'pending',
            activeRuleSet: '1.0.0',
            requiredRuleSet: '2.0.0',
            requiredAtHeight: 970000,
            classification: 'major',
            reason: 'upgrade required'
        };

        assert.deepStrictEqual(stallFields({ trainActivation }).train_activation, {
            status: 'pending',
            active_rule_set: '1.0.0',
            required_rule_set: '2.0.0',
            required_at_height: 970000,
            classification: 'major',
            reason: 'upgrade required'
        });
    });

    it('defaults absent optional fields to null without erasing height zero', function(){
        assert.deepStrictEqual(stallFields({
            trainActivation: { status: 'halt', requiredAtHeight: 0 }
        }).train_activation, {
            status: 'halt',
            active_rule_set: null,
            required_rule_set: null,
            required_at_height: 0,
            classification: null,
            reason: null
        });
    });
});

describe('stallFields() stall attribution', function(){
    it('reports the indexer stall reason or null', function(){
        assert.strictEqual(stallFields({ stallReason: 'hub sync timeout' }).stallReason,
            'hub sync timeout');
        assert.strictEqual(stallFields({}).stallReason, null);
    });

    it('uses the decoder reorg halt fallback only when no stall reason is set', function(){
        assert.strictEqual(stallFields({ decoderReorgHalted: true }).stallReason,
            REORG_HALT_REASON);
        assert.strictEqual(stallFields({
            decoderReorgHalted: true,
            stallReason: 'specific indexer reason'
        }).stallReason, 'specific indexer reason');
    });

    it('coerces the decoder reorg halt marker to a boolean', function(){
        assert.strictEqual(stallFields({ decoderReorgHalted: 'halted' }).decoderReorgHalted,
            true);
        assert.strictEqual(stallFields({ decoderReorgHalted: 0 }).decoderReorgHalted, false);
    });
});
