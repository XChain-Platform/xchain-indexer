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
const HUB_FROM     = path.resolve(__dirname, '..');
const HUB_GATE     = '../../../../xchain-hub/src/consensus/gates/mirror_admission_margin_gate.js';
const HUB_ROWS     = '../../../../xchain-hub/src/consensus/gate_registry/shared_rows_5.js';
const HUB_ADMIT    = '../../../../xchain-hub/src/lib/admission_height.js';
const HUB_WATERMARK = '../../../../xchain-hub/src/peers/hub_db/admission_height_watermark.js';
const ACTIVATION_KEY = 'mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION';
const HUB_WINDOW_ENV = [
    'HUB_NETWORK', 'XDEX_ROUND_TIMEOUT_MS', 'XDEX_ROUND_MAX_LIFETIME_MS',
    'ATTESTATION_ROUND_TIMEOUT_MS', 'ANCHOR_ROUND_TIMEOUT_MS',
    'ORACLE_ROUND_INTERVAL', 'ADMISSION_ORACLE_INGEST_WINDOW_MS',
];

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

function hubFiles(root) {
    if(root) return [
        path.join(root, 'src/consensus/gates/mirror_admission_margin_gate.js'),
        path.join(root, 'src/consensus/gate_registry/shared_rows_5.js'),
        path.join(root, 'src/lib/admission_height.js'),
        path.join(root, 'src/peers/hub_db/admission_height_watermark.js'),
    ];
    return [HUB_GATE, HUB_ROWS, HUB_ADMIT, HUB_WATERMARK].map(rel => path.resolve(HUB_FROM, rel));
}

function withoutHubWindowEnv(fn) {
    const saved = HUB_WINDOW_ENV.map(key => [key, process.env[key]]);
    for(const [key] of saved) delete process.env[key];
    try { return fn(); }
    finally {
        for(const [key, value] of saved) {
            if(value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function usableHub(ctx) {
    const files = hubFiles(process.env.XCHAIN_HUB_DIR);
    const verdicts = files.map(file => siblingCheckout(__dirname, file));
    const refused = verdicts.find(verdict => !verdict.usable);
    if(!refused) return files;
    skipOrFail(ctx, refused, 'mirror-admission margin cross-repo parity');
    return null;
}

function loadCopies(ctx) {
    const hub = usableHub(ctx);
    if(!hub) return null;
    const [hubGateFile, hubRowsFile, hubAdmitFile, hubWatermarkFile] = hub;
    const indexerPath = require.resolve(INDEXER_GATE);
    const hubGatePath = require.resolve(hubGateFile);
    const hubAdmitPath = require.resolve(hubAdmitFile);
    const hubWatermarkPath = require.resolve(hubWatermarkFile);
    const normalIndexer = require(indexerPath);
    const normalHub = require(hubAdmitPath);
    const normalWatermark = require(hubWatermarkPath).AdmissionHeightWatermark;
    const saved = [indexerPath, hubGatePath, hubAdmitPath, hubWatermarkPath]
        .map(p => [p, require.cache[p]]);
    const indexerRegistry = require('../../../../src/consensus/gate_registry.js');
    const hubRegistry = require(path.resolve(path.dirname(hubGateFile), '..', 'gate_registry'));
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
    return { normalIndexer, normalHub, normalWatermark, boundaryIndexer, boundaryHub, saved,
        hubGateFile, hubRowsFile };
}

function tables(gate) {
    return Object.keys(gate.ADMIT_CHAIN_MARGIN_BLOCKS.DOGE).concat('oracle_prices');
}

describe('mirror-admission margin cross-repo parity', function() {
    before(function() { loaded = loadCopies(this); });
    after(function() {
        if(loaded) restoreCache(loaded.saved);
        loaded = null;
    });

    it('hub and indexer copies of the margin gate and shared_rows_5 are byte-identical', function() {
        assert.deepStrictEqual(fs.readFileSync(path.resolve(__dirname, INDEXER_GATE)),
            fs.readFileSync(loaded.hubGateFile));
        assert.deepStrictEqual(fs.readFileSync(path.resolve(__dirname, INDEXER_ROWS)),
            fs.readFileSync(loaded.hubRowsFile));
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

    it('the activated DOGE margin clears the 8-minute xdex watermark trail that the legacy margin cannot', function() {
        const table = 'cross_chain_matches';
        const start = 1_700_000_000_000;
        const trailsByCadence = [];
        const legacyDeficitsByCadence = [];
        for(const cadenceMs of [60000, 50000, 40000]) {
            const watermark = withoutHubWindowEnv(() => new loaded.normalWatermark({
                HUB_NETWORK: 'regtest',
            }));
            assert.strictEqual(watermark.roundTerminalMs(table), 8 * 60 * 1000);
            const steadyStart = Math.ceil(watermark.roundTerminalMs(table) / cadenceMs) + 2;
            const last = steadyStart + 4;
            const trails = [];
            const legacyDeficits = [];
            for(let i = 0; i <= last; i++) {
                const tip = 1000 + i;
                watermark.observeTip('DOGE', tip, start + i * cadenceMs);
                if(i < steadyStart) continue;
                const claimed = watermark.heights(start + i * cadenceMs)[table].DOGE;
                const trail = tip - claimed;
                const legacyMargin = loaded.normalIndexer.baseMarginBlocks(table);
                const activatedMargin = loaded.normalIndexer.rowMarginBlocks(
                    table, 'DOGE', 'regtest', tip);
                trails.push(trail);
                legacyDeficits.push(trail - legacyMargin);
                assert.strictEqual(legacyMargin, 4);
                assert.ok(claimed < tip - legacyMargin);
                assert.ok(trail - legacyMargin >= 5);
                assert.ok(claimed >= loaded.normalIndexer.consumerTargetHeight(
                    table, 'DOGE', 'regtest', tip));
                assert.strictEqual(activatedMargin, 14);
                assert.ok(activatedMargin > trail);
            }
            trailsByCadence.push(trails);
            legacyDeficitsByCadence.push(legacyDeficits);
        }
        assert.deepStrictEqual(trailsByCadence, [
            [9, 9, 9, 9, 9],
            [11, 11, 11, 11, 11],
            [13, 13, 13, 13, 13],
        ]);
        assert.deepStrictEqual(legacyDeficitsByCadence, [
            [5, 5, 5, 5, 5],
            [7, 7, 7, 7, 7],
            [9, 9, 9, 9, 9],
        ]);
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
