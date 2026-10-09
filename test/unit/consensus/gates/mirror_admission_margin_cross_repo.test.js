/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Prove the hub stamp and indexer consumer use identical margin data and
 * agree across both sides of a chain-specific activation boundary.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const INDEXER_GATE = '../../../../src/consensus/gates/mirror_admission_margin_gate.js';
const INDEXER_ROWS = '../../../../src/protocol_changes/shared_rows_5.js';
const HUB_GATE     = '../../../../../xchain-hub/src/consensus/gates/mirror_admission_margin_gate.js';
const HUB_ROWS     = '../../../../../xchain-hub/src/consensus/gate_registry/shared_rows_5.js';
const HUB_ADMIT    = '../../../../../xchain-hub/src/lib/admission_height.js';
const ACTIVATION_KEY = 'mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION';

let loaded = null;

function replaceActivationGet(registry) {
    const original = registry.get;
    registry.get = function(key) {
        const value = original(key);
        if(key !== ACTIVATION_KEY) return value;
        return Object.freeze(Object.assign({}, value, { 'DOGE:testnet': 1000 }));
    };
    return original;
}

function restoreCache(saved) {
    for(const [modulePath, entry] of saved) {
        delete require.cache[modulePath];
        if(entry !== undefined) require.cache[modulePath] = entry;
    }
}

function loadCopies(ctx) {
    for(const rel of [HUB_GATE, HUB_ROWS, HUB_ADMIT]) {
        const verdict = siblingCheckout(__dirname, rel);
        if(!verdict.usable) { skipOrFail(ctx, verdict, 'mirror-admission margin cross-repo parity'); return null; }
    }
    const indexerPath = require.resolve(INDEXER_GATE);
    const hubGatePath = require.resolve(HUB_GATE);
    const hubAdmitPath = require.resolve(HUB_ADMIT);
    const normalIndexer = require(indexerPath);
    const normalHub = require(hubAdmitPath);
    const saved = [indexerPath, hubGatePath, hubAdmitPath].map(p => [p, require.cache[p]]);
    const indexerRegistry = require('../../../../src/consensus/gate_registry.js');
    const hubRegistry = require('../../../../../xchain-hub/src/consensus/gate_registry');
    const indexerGet = replaceActivationGet(indexerRegistry);
    const hubGet = replaceActivationGet(hubRegistry);
    let boundaryIndexer;
    let boundaryHub;
    try {
        for(const [modulePath] of saved) delete require.cache[modulePath];
        boundaryIndexer = require(indexerPath);
        boundaryHub = require(hubAdmitPath);
    } catch(error) {
        restoreCache(saved);
        throw error;
    } finally {
        indexerRegistry.get = indexerGet;
        hubRegistry.get = hubGet;
    }
    return { normalIndexer, normalHub, boundaryIndexer, boundaryHub, saved };
}

function tables(gate) {
    return Object.keys(gate.ADMIT_CHAIN_MARGIN_BLOCKS.DOGE).concat('oracle_prices');
}

describe('mirror-admission margin cross-repo parity', function() {
    before(function() { loaded = loadCopies(this); });
    after(function() { if(loaded) restoreCache(loaded.saved); loaded = null; });

    it('hub and indexer copies of the margin gate and shared_rows_5 are byte-identical', function() {
        assert.deepStrictEqual(fs.readFileSync(path.resolve(__dirname, INDEXER_GATE)),
            fs.readFileSync(path.resolve(__dirname, HUB_GATE)));
        assert.deepStrictEqual(fs.readFileSync(path.resolve(__dirname, INDEXER_ROWS)),
            fs.readFileSync(path.resolve(__dirname, HUB_ROWS)));
    });

    it('hub admitBlocks stamps the indexer row margin and the consumer target certifies the opening tip on regtest', function() {
        for(const table of tables(loaded.normalIndexer)) {
            for(const chain of ['DOGE', 'LTC', 'BTC']) {
                for(const tip of [1, 100, 5000]) {
                    const stamped = loaded.normalHub.admitBlocks([chain], { [chain]: tip }, table, 'regtest')[chain];
                    assert.strictEqual(stamped - tip,
                        loaded.normalIndexer.rowMarginBlocks(table, chain, 'regtest', stamped));
                    assert.strictEqual(loaded.normalIndexer.consumerTargetHeight(
                        table, chain, 'regtest', stamped), tip);
                }
            }
        }
    });

    it('hub and indexer agree on both sides of a stubbed DOGE testnet boundary', function() {
        for(const table of tables(loaded.boundaryIndexer)) {
            for(let tip = 980; tip <= 1003; tip++) {
                const stamped = loaded.boundaryHub.admitBlocks(
                    ['DOGE'], { DOGE: tip }, table, 'testnet').DOGE;
                assert.strictEqual(stamped - tip, loaded.boundaryIndexer.rowMarginBlocks(
                    table, 'DOGE', 'testnet', stamped), table + ' at tip ' + tip);
                assert.strictEqual(loaded.boundaryIndexer.consumerTargetHeight(
                    table, 'DOGE', 'testnet', stamped), tip, table + ' at tip ' + tip);
            }
        }
    });
});
