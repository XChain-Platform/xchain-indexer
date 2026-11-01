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
 * Replay-witness threshold read overlay behavior.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');

const { ABSENT } = require('../../../../../src/consensus_rules_digest.js');
const {
    witnessThresholdTable,
    witnessReadOverlay,
} = require('../../../../../src/consensus/retroactive/witness_overlay.js');
const { resolvedThreshold } =
    require('../../../../../src/consensus/retroactive/gate_heights.js');

describe('retroactive witness read overlay @regression @tier1', function(){
    it('exports the unchanged threshold resolver used by gate projections', function(){
        const table = { 'BTC:regtest': 5, regtest: 7 };

        assert.strictEqual(resolvedThreshold(table, 'regtest', 'BTC'), 5);
        assert.strictEqual(resolvedThreshold(table, 'regtest', 'LTC'), 7);
    });

    it('replaces the resolved coin threshold without mutating the source table', function(){
        const table = { 'BTC:regtest': 5, regtest: 7, mainnet: 9 };

        const result = witnessThresholdTable(table, 'regtest', 'BTC', 11);

        assert.deepStrictEqual(result, { 'BTC:regtest': 11, regtest: 7, mainnet: 9 });
        assert.deepStrictEqual(table, { 'BTC:regtest': 5, regtest: 7, mainnet: 9 });
        assert.notStrictEqual(result, table);
    });

    it('replaces the network fallback when the table has no coin threshold', function(){
        const table = { regtest: 7, mainnet: 9 };

        assert.deepStrictEqual(witnessThresholdTable(table, 'regtest', 'BTC', 11), {
            regtest: 11,
            mainnet: 9,
        });
        assert.deepStrictEqual(table, { regtest: 7, mainnet: 9 });
    });

    it('removes both possible thresholds for an absent witness value', function(){
        const table = { 'BTC:regtest': 5, regtest: 7, mainnet: 9 };

        assert.deepStrictEqual(witnessThresholdTable(table, 'regtest', 'BTC', ABSENT), {
            mainnet: 9,
        });
        assert.deepStrictEqual(table, { 'BTC:regtest': 5, regtest: 7, mainnet: 9 });
    });

    it('applies the prior overlay before a recorded witness threshold', function(){
        const calls = [];
        const prior = (key, value) => {
            calls.push([key, value]);
            return Object.assign({}, value, { mainnet: 1, regtest: 2 });
        };
        const overlay = witnessReadOverlay(prior, { 'stem.GATE': 3 }, 'regtest', 'BTC');
        const source = { regtest: 7 };

        assert.deepStrictEqual(overlay('stem.GATE', source), { regtest: 3, mainnet: 1 });
        assert.deepStrictEqual(calls, [['stem.GATE', source]]);
        assert.deepStrictEqual(source, { regtest: 7 });
    });

    it('returns the prior result unchanged for a key absent from witness values', function(){
        const priorResult = { regtest: 7 };
        const overlay = witnessReadOverlay(() => priorResult, { 'stem.GATE': 3 },
            'regtest', 'BTC');

        assert.strictEqual(overlay('stem.OTHER', { regtest: 4 }), priorResult);
    });

    it('works without a prior overlay and ignores inherited witness keys', function(){
        const values = Object.create({ 'stem.GATE': 3 });
        const table = { regtest: 7 };
        const overlay = witnessReadOverlay(null, values, 'regtest', 'BTC');

        assert.strictEqual(overlay('stem.GATE', table), table);
    });
});
