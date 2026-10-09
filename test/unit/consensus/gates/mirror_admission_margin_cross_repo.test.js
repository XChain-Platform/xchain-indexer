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
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const INDEXER_GATE = '../../../../src/consensus/gates/mirror_admission_margin_gate.js';
const INDEXER_ROWS = '../../../../src/protocol_changes/shared_rows_5.js';
const HUB_FROM     = path.resolve(__dirname, '..');
const HUB_GATE     = '../../../../xchain-hub/src/consensus/gates/mirror_admission_margin_gate.js';
const HUB_ROWS     = '../../../../xchain-hub/src/consensus/gate_registry/shared_rows_5.js';
const HUB_ADMIT    = '../../../../xchain-hub/src/lib/admission_height.js';
const HUB_COMMIT   = '49906fe261ad96cf84447da2500f7fb6459904b2';
const ACTIVATION_KEY = 'mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION';
const SCRATCH_ROOT = path.resolve(__dirname, '../../../../tmp');

let loaded = null;
let temporaryHub = null;

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
    ];
    return [HUB_GATE, HUB_ROWS, HUB_ADMIT].map(rel => path.resolve(HUB_FROM, rel));
}

function usableHub(ctx) {
    let files = hubFiles(process.env.XCHAIN_HUB_DIR);
    const verdicts = files.map(file => siblingCheckout(__dirname, file));
    const refused = verdicts.find(verdict => !verdict.usable);
    if(!refused) return files;
    if(process.env.XCHAIN_REQUIRE_SIBLINGS !== '1' || !/symlink into the live main checkout/.test(refused.reason)) {
        skipOrFail(ctx, refused, 'mirror-admission margin cross-repo parity');
        return null;
    }
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    temporaryHub = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'margin-parity-hub-'));
    const checkout = path.join(temporaryHub, 'xchain-hub');
    const source = path.resolve(HUB_FROM, '../../../../xchain-hub');
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', source, checkout], { stdio: 'pipe' });
    execFileSync('git', ['-C', checkout, 'checkout', '-q', '--detach', HUB_COMMIT], { stdio: 'pipe' });
    files = hubFiles(checkout);
    for(const file of files) {
        const verdict = siblingCheckout(__dirname, file);
        if(!verdict.usable) { skipOrFail(ctx, verdict, 'mirror-admission margin cross-repo parity'); return null; }
    }
    return files;
}

function loadCopies(ctx) {
    const hub = usableHub(ctx);
    if(!hub) return null;
    const [hubGateFile, hubRowsFile, hubAdmitFile] = hub;
    const indexerPath = require.resolve(INDEXER_GATE);
    const hubGatePath = require.resolve(hubGateFile);
    const hubAdmitPath = require.resolve(hubAdmitFile);
    const normalIndexer = require(indexerPath);
    const normalHub = require(hubAdmitPath);
    const saved = [indexerPath, hubGatePath, hubAdmitPath].map(p => [p, require.cache[p]]);
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
    return { normalIndexer, normalHub, boundaryIndexer, boundaryHub, saved,
        hubGateFile, hubRowsFile };
}

function tables(gate) {
    return Object.keys(gate.ADMIT_CHAIN_MARGIN_BLOCKS.DOGE).concat('oracle_prices');
}

describe('mirror-admission margin cross-repo parity', function() {
    before(function() { loaded = loadCopies(this); });
    after(function() {
        if(loaded) restoreCache(loaded.saved);
        if(temporaryHub) fs.rmSync(temporaryHub, { recursive: true, force: true });
        loaded = null;
        temporaryHub = null;
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
