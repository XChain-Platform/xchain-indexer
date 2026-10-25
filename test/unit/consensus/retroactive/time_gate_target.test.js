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
 * Replay targets for time and height gate moves.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');

const {
    classifyGateMoves,
} = require('../../../../src/consensus/retroactive/gate_heights.js');

const TIME_GATE = 'price_zero_validity_activation.PRICE_ZERO_VALIDITY_ACTIVATION';
const HEIGHT_GATE = 'bridge_policy_detach_activation.BRIDGE_POLICY_DETACH';
const BLOCK_TIMES = [
    { height: 42, time: 1_800 },
    { height: 40, time: 1_000 },
    { height: 43, time: 2_100 },
    { height: 41, time: 1_500 },
];

describe('retroactive time gate target @regression @tier1', function(){
    it('resolves a moved time threshold to the first block at or past it', function(){
        assert.deepStrictEqual(classifyGateMoves({
            recorded: { [TIME_GATE]: 2_000 },
            current: { [TIME_GATE]: 1_400 },
            tip: 43,
            blockTimes: BLOCK_TIMES,
            movableGates: [TIME_GATE],
        }), {
            target: 41,
            movable: [{ key: TIME_GATE, from: 2_000, to: 1_400, target: 41 }],
            refused: [],
        });
    });

    it('leaves a height gate target in height units', function(){
        assert.deepStrictEqual(classifyGateMoves({
            recorded: { [HEIGHT_GATE]: 42 },
            current: { [HEIGHT_GATE]: 41 },
            tip: 43,
            blockTimes: BLOCK_TIMES,
            movableGates: [HEIGHT_GATE],
        }), {
            target: 41,
            movable: [{ key: HEIGHT_GATE, from: 42, to: 41, target: 41 }],
            refused: [],
        });
    });

    it('reports no move when the time threshold is beyond the tip', function(){
        assert.deepStrictEqual(classifyGateMoves({
            recorded: { [TIME_GATE]: 2_300 },
            current: { [TIME_GATE]: 2_200 },
            tip: 43,
            blockTimes: BLOCK_TIMES,
            movableGates: [TIME_GATE],
        }), {
            target: null,
            movable: [],
            refused: [],
        });
    });
});
