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
 * Registry coverage and boundary rules for retroactive gate moves.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');

const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const consensusRules = require('../../../../src/consensus_rules_digest.js');
const {
    RECORDED_UNITS,
    gateHeightMap,
    classifyGateMoves,
} = require('../../../../src/consensus/retroactive/gate_heights.js');
const { MOVABLE_GATES } = require('../../../../src/consensus/retroactive/movable_gates.js');

const INDEXER_ONLY = 'bridge_policy_detach_activation.BRIDGE_POLICY_DETACH';
const TIME_GATE = 'price_zero_validity_activation.PRICE_ZERO_VALIDITY_ACTIVATION';
const EPOCH_GATE = 'rollcall_activation.ROLLCALL_ACTIVATION';
const RULESET_GATE = 'train_activation.TRAIN_ACTIVATION';

function moves(recorded, current, overrides = {}){
    return classifyGateMoves({ recorded, current, tip: 100, ...overrides });
}

describe('retroactive gate height map @regression @tier1', function(){
    it('records every height and time row, including an indexer-only gate', function(){
        const map = gateHeightMap(gateRegistry, 'testnet', 'DOGE');
        const indexerTable = gateRegistry.get(INDEXER_ONLY);
        const timeTable = gateRegistry.get(TIME_GATE);

        assert.deepStrictEqual(RECORDED_UNITS, ['height', 'time']);
        assert.strictEqual(map[INDEXER_ONLY], indexerTable['DOGE:testnet'] ?? indexerTable.testnet);
        assert.strictEqual(map[TIME_GATE], timeTable['DOGE:testnet'] ?? timeTable.testnet);

        const expected = gateRegistry.registry.keys()
            .filter(key => RECORDED_UNITS.includes(gateRegistry.registry.unitOf(key))).sort();
        assert.deepStrictEqual(Object.keys(map).sort(), expected);
    });

    it('never records epoch or ruleset rows as movable gate heights', function(){
        const map = gateHeightMap(gateRegistry, 'regtest', 'BTC');

        assert.strictEqual(gateRegistry.registry.unitOf(EPOCH_GATE), 'epoch');
        assert.strictEqual(gateRegistry.registry.unitOf(RULESET_GATE), 'ruleset');
        assert.strictEqual(Object.prototype.hasOwnProperty.call(map, EPOCH_GATE), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(map, RULESET_GATE), false);
    });

    it('flags an earlier move at the new boundary', function(){
        assert.deepStrictEqual(moves({ a: 150 }, { a: 80 }), {
            target: 80,
            movable: [],
            refused: [{ key: 'a', from: 150, to: 80, target: 80 }]
        });
    });

    it('flags a later move of an applied height at the old boundary', function(){
        assert.deepStrictEqual(moves({ a: 40 }, { a: 150 }), {
            target: 40,
            movable: [],
            refused: [{ key: 'a', from: 40, to: 150, target: 40 }]
        });
    });

    it('flags de-arming at the old boundary for null, absent and the sentinel', function(){
        const current = {
            nullGate: null,
            sentinelGate: consensusRules.FAR_FUTURE_HEIGHT_SENTINEL,
        };
        assert.deepStrictEqual(moves({ absentGate: 30, nullGate: 40, sentinelGate: 50 }, current), {
            target: 30,
            movable: [],
            refused: [
                { key: 'absentGate', from: 30, to: consensusRules.ABSENT, target: 30 },
                { key: 'nullGate', from: 40, to: null, target: 40 },
                { key: 'sentinelGate', from: 50,
                    to: consensusRules.FAR_FUTURE_HEIGHT_SENTINEL, target: 50 },
            ]
        });
    });

    it('ignores a move wholly above the tip', function(){
        assert.deepStrictEqual(moves({ a: 150 }, { a: 120 }), {
            target: null,
            movable: [],
            refused: []
        });
    });

    it('refuses a non-listed key and ships no movable gates', function(){
        assert.ok(Object.isFrozen(MOVABLE_GATES));
        assert.deepStrictEqual(MOVABLE_GATES, []);
        assert.deepStrictEqual(moves({ [INDEXER_ONLY]: 20 }, { [INDEXER_ONLY]: 30 }).refused, [{
            key: INDEXER_ONLY,
            from: 20,
            to: 30,
            target: 20,
        }]);
    });

    it('splits allowlisted and refused moves without changing their shared target', function(){
        assert.deepStrictEqual(moves({ a: 20, b: 30 }, { a: 50, b: 10 }, {
            movableGates: ['a'],
        }), {
            target: 10,
            movable: [{ key: 'a', from: 20, to: 50, target: 20 }],
            refused: [{ key: 'b', from: 30, to: 10, target: 10 }],
        });
    });
});
