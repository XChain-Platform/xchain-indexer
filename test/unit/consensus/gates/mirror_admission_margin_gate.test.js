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

    it('selects LTC table margins on active regtest', function(){
        assert.strictEqual(gate.stampMarginBlocks('bridge_transfers', 'LTC', 'regtest', 100), 14);
        assert.strictEqual(gate.stampMarginBlocks('price_snapshots', 'LTC', 'regtest', 100), 17);
        assert.strictEqual(gate.consumerTargetHeight('price_snapshots', 'LTC', 'regtest', 1000), 983);
        assert.strictEqual(gate.stampMarginBlocks('oracle_prices', 'LTC', 'regtest', 100), 1);
    });

    it('keeps every LTC margin inert below its testnet activation and unpinned on mainnet', function(){
        // Shipped on the UNARMED sentinel; a cut replaces it with a sized height.
        const H = gate.activationHeight('LTC', 'testnet');
        assert.ok(Number.isInteger(H) && H > 4900000 && H <= 9999999999, 'LTC:testnet ' + H);
        assert.strictEqual(gate.activationHeight('LTC', 'mainnet'), null);
        for(const table of Object.keys(gate.ADMIT_CHAIN_MARGIN_BLOCKS.LTC).concat('oracle_prices')){
            const legacy = gate.baseMarginBlocks(table);
            for(const network of ['testnet', 'mainnet']){
                const B = network === 'testnet' ? H - 100 : 3000000;
                assert.strictEqual(gate.stampMarginBlocks(table, 'LTC', network, B), legacy, table + ' ' + network);
                assert.strictEqual(gate.rowMarginBlocks(table, 'LTC', network, B), legacy, table + ' ' + network);
                assert.strictEqual(gate.consumerTargetHeight(table, 'LTC', network, B), B - legacy,
                    table + ' ' + network);
            }
        }
        assert.strictEqual(gate.isChainMarginActive('LTC', 'testnet', H - 1), false);
        assert.strictEqual(gate.isChainMarginActive('LTC', 'mainnet', 9999999998), false);
    });

    it('preserves table and chain legacy margins without an override', function(){
        assert.strictEqual(gate.stampMarginBlocks('bridge_transfers', 'BTC', 'regtest', 100), 4);
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

describe('mirror-admission chain margin gate at a stubbed LTC testnet boundary @regression @tier1', function(){
    const REGISTRY = require.resolve('../../../../src/consensus/gate_registry.js');
    const GATE = require.resolve('../../../../src/consensus/gates/mirror_admission_margin_gate.js');
    const KEY = 'mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION';
    const H = 4950000;
    let boundary = null;

    before(function(){
        const registry = require(REGISTRY);
        const original = registry.get;
        const saved = require.cache[GATE];
        registry.get = function(key){
            const value = original(key);
            return key === KEY ? Object.freeze(Object.assign({}, value, { 'LTC:testnet': H })) : value;
        };
        try {
            delete require.cache[GATE];
            boundary = require(GATE);
        } finally {
            registry.get = original;
            delete require.cache[GATE];
            if(saved) require.cache[GATE] = saved;
        }
    });

    it('keeps the legacy rule for every table below the boundary', function(){
        for(const table of Object.keys(boundary.ADMIT_CHAIN_MARGIN_BLOCKS.LTC).concat('oracle_prices')){
            const legacy = boundary.baseMarginBlocks(table);
            const chain = boundary.chainMarginBlocks(table, 'LTC') || legacy;
            assert.strictEqual(boundary.stampMarginBlocks(table, 'LTC', 'testnet', H - chain - 1), legacy, table);
            assert.strictEqual(boundary.rowMarginBlocks(table, 'LTC', 'testnet', H - 1), legacy, table);
            for(let B = H - 40; B < H; B++)
                assert.strictEqual(boundary.consumerTargetHeight(table, 'LTC', 'testnet', B), B - legacy,
                    table + ' at ' + B);
        }
    });

    it('selects the LTC margins at and above the boundary', function(){
        assert.strictEqual(boundary.stampMarginBlocks('bridge_transfers', 'LTC', 'testnet', H - 14), 14);
        assert.strictEqual(boundary.stampMarginBlocks('price_snapshots', 'LTC', 'testnet', H - 17), 17);
        assert.strictEqual(boundary.rowMarginBlocks('policy_snapshots', 'LTC', 'testnet', H), 14);
        assert.strictEqual(boundary.consumerTargetHeight('bridge_transfers', 'LTC', 'testnet', H), H - 14);
        assert.strictEqual(boundary.consumerTargetHeight('price_snapshots', 'LTC', 'testnet', H + 5), H - 12);
    });

    it('leaves DOGE, BTC and LTC mainnet where they were', function(){
        assert.strictEqual(boundary.activationHeight('DOGE', 'testnet'), 67989993);
        assert.strictEqual(boundary.stampMarginBlocks('bridge_transfers', 'BTC', 'testnet', H), 4);
        assert.strictEqual(boundary.stampMarginBlocks('bridge_transfers', 'LTC', 'mainnet', H), 4);
    });
});
