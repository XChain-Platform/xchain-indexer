/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const gate = require('../../../../src/consensus/gates/mirror_admission_margin_gate.js');

describe('mirror-admission chain margin gate @regression @tier1', function(){
    it('selects DOGE table margins on active regtest', function(){
        assert.strictEqual(gate.stampMarginBlocks('bridge_transfers', 'DOGE', 'regtest', 100), 14);
        assert.strictEqual(gate.stampMarginBlocks('price_snapshots', 'DOGE', 'regtest', 100), 16);
    });

    it('preserves table and chain legacy margins without an override', function(){
        assert.strictEqual(gate.stampMarginBlocks('bridge_transfers', 'LTC', 'regtest', 100), 4);
        assert.strictEqual(gate.stampMarginBlocks('oracle_prices', 'DOGE', 'regtest', 100), 1);
        assert.strictEqual(gate.stampMarginBlocks('unknown_table', 'DOGE', 'regtest', 100), 4);
    });

    it('keeps the DOGE testnet margin inert below its sentinel', function(){
        assert.strictEqual(gate.stampMarginBlocks('bridge_transfers', 'DOGE', 'testnet', 67980000), 4);
        assert.strictEqual(gate.consumerTargetHeight('bridge_transfers', 'DOGE', 'testnet', 67980000), 67979996);
    });

    it('resolves chain and network names canonically', function(){
        assert.strictEqual(gate.stampMarginBlocks('bridge_transfers', ' doge ', ' REGTEST ', 100), 14);
        assert.strictEqual(gate.isChainMarginActive('doge', 'REGTEST', 0), true);
        assert.strictEqual(gate.isChainMarginActive(null, 'regtest', 0), true);
        assert.strictEqual(gate.isChainMarginActive('DOGE', 'unknown', 9999999999), false);
    });

    it('uses the chain margin early enough to stamp across the activation boundary', function(){
        assert.strictEqual(gate.stampMarginAt(4, 14, 1000, 985), 4);
        assert.strictEqual(gate.stampMarginAt(4, 14, 1000, 986), 14);
    });

    it('uses the row margin only for rows admitted in the new era', function(){
        assert.strictEqual(gate.rowMarginAt(4, 14, 1000, 999), 4);
        assert.strictEqual(gate.rowMarginAt(4, 14, 1000, 1000), 14);
        assert.strictEqual(gate.rowMarginBlocks('bridge_transfers', 'DOGE', 'regtest', 100), 14);
    });

    it('moves the consumer target at the activation boundary', function(){
        assert.strictEqual(gate.consumerTargetAt(4, 14, 1000, 999), 995);
        assert.strictEqual(gate.consumerTargetAt(4, 14, 1000, 1000), 986);
        assert.strictEqual(gate.consumerTargetAt(4, 14, 1000, 1010), 996);
        assert.strictEqual(gate.consumerTargetHeight('bridge_transfers', 'DOGE', 'regtest', 1000), 986);
    });

    it('falls back to the legacy margin when the override or height is unusable', function(){
        for(const invalid of [null, undefined, NaN, Infinity, -Infinity]){
            assert.strictEqual(gate.stampMarginAt(4, invalid, 1000, 1000), 4);
            assert.strictEqual(gate.rowMarginAt(4, 14, invalid, 1000), 4);
            assert.strictEqual(gate.consumerTargetAt(4, invalid, null, 1000), 996);
        }
    });

    it('never returns a target above the legacy-margin target', function(){
        for(let block = 990; block <= 1030; block++)
            assert.ok(gate.consumerTargetAt(4, 14, 1000, block) <= block - 4, 'block ' + block);
    });
});
