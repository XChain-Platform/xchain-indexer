// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// EMISSION_DEPTH_EXECUTE_ONLY: with the gate on, only an EXECUTE emission stamps the
// incremented CALL_DEPTH; every other emission keeps the emitter's depth. With the gate
// off, every emission is stamped depth + 1.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Execute = require('../../../src/actions/execute/index.js');
const CHANGES = require('../../../src/protocol_changes/changes_5.js');

const GATE = 'EMISSION_DEPTH_EXECUTE_ONLY';
const STOP = 'STOP_AT_DISPATCH';

// Run processEmission up to the handler dispatch and return the emission data it built.
async function stampedData(gateOn, emission, depth) {
    let seen = null;
    const router = require('../../../src/actions/execute/emission.js');
    const ctx = Object.create(Execute.prototype);
    ctx.actions = { protocolChanges: { isEnabled: async (name) => name === GATE && gateOn } };
    ctx.config = { CHAIN: 'BTC' };
    ctx.indexerDb = { createActionIndex: async () => 77 };
    ctx.roundEmissionAmounts = async () => {};
    ctx.buildActionParams = () => [];
    ctx.getActionHandler = () => ({ parse: async (_p, data) => { seen = data; throw new Error(STOP); } });
    try {
        await router.processEmission.call(ctx, emission, { CALL_DEPTH: depth, BLOCK_INDEX: 1, ROOT_ACTION_INDEX: 0 }, 0,
            { MAX_CALL_DEPTH: 8, MIN_CALL_GAS: 1, GAS_CEILING: 1e9, XCALL_MAX_HOPS: 4, XCALL_MIN_GAS: 1, XCALL_MAX_GAS: 1e9 });
    } catch (e) { if (e.message !== STOP) throw e; }
    assert.ok(seen, 'emission never reached the handler');
    return seen;
}

describe('EMISSION_DEPTH_EXECUTE_ONLY: emission CALL_DEPTH ruling @regression @tier1', function () {
    it('is declared unarmed on every network', function () {
        const row = CHANGES.find(r => r[0] === GATE);
        assert.ok(row, 'gate row missing');
        assert.strictEqual(typeof row[2], 'number');
        assert.ok(row[2] > 1e9 && row[3] > 1e9 && row[4] > 1e9, 'must be unarmed on mainnet, testnet and regtest');
    });

    it('stamps depth + 1 on EXECUTE with the gate on or off', async function () {
        const e = () => ({ action: 'EXECUTE', params: { contractIndex: 1, method: 'm', gasLimit: 100000 } });
        for (const on of [false, true])
            assert.strictEqual((await stampedData(on, e(), 3)).CALL_DEPTH, 4);
    });

    it('gate off: a non-EXECUTE emission is still stamped depth + 1', async function () {
        const d = await stampedData(false, { action: 'TRANSFER', params: {} }, 3);
        assert.strictEqual(d.CALL_DEPTH, 4);
    });

    it('gate on: a non-EXECUTE emission keeps the emitter depth', async function () {
        const d = await stampedData(true, { action: 'TRANSFER', params: {} }, 3);
        assert.strictEqual(d.CALL_DEPTH, 3);
    });
});
