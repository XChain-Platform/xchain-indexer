// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// getstakeweightsbycapability and the rules-aware attestation set. The RPC serves the committed
// weight read as it is, with its truncation flag, and applies the rules filter to no capability.
// The attestation parity case with the chain responsible set is written and skipped: serving
// the filtered set changes what the hub mirrors for the off-BTC verifier, so it waits for an
// activation decision. The filter is armed with a busted require cache, the way
// rollcall_gates_filter.test.js arms it, and every module that holds a binding to it is reloaded.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const ENV_KEY = 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION';
const PATHS = [
    '../../../../src/consensus/gates/rollcall_gates_gate.js',
    '../../../../src/actions/attest/gates/rollcall_gates_filter.js',
    '../../../../src/actions/attest/responsible_set.js',
    '../../../../src/api/rpc/capabilities.js',
].map(p => require.resolve(p));

const { activeGatesAt } = require('../../../../src/consensus_rules_digest.js');
const srb = require('../../../../src/consensus/snapshot_reorg_buffer.js');
const observability = require('../../../../src/observability/index.js');

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);
const H = 1000;

function reload(envValue){
    if(envValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = envValue;
    for(const p of PATHS) delete require.cache[p];
    return {
        responsible: require(PATHS[2]),
        capabilities: require(PATHS[3]),
    };
}

// A is dropped (its rolled list names no active gate), B is kept (names every active gate),
// C is kept (never rolled).
function epochRow(needed){
    return {
        epoch_height: 960, close_block: 990,
        gates: new Map([[PK_A, []], [PK_B, needed.slice()]]),
    };
}

function makeView(rows, needed, truncated){
    const list = rows.slice();
    if(truncated) list.truncated = true;
    const view = {
        gateReads: 0,
        getLatestBlockIndex: async () => 5000,
        isCapabilityConfigured: () => true,
        getStakeWeightsByCapability: async () => list,
        getRollcallGatesForFilter: async () => { view.gateReads++; return epochRow(needed); },
    };
    return view;
}

const rows = [
    { pubkey: PK_A, source: 'sa', weight: '5' },
    { pubkey: PK_B, source: 'sb', weight: '5' },
    { pubkey: PK_C, source: 'sc', weight: '5' },
];
const BLOCK = srb.buriedSnapshotBlock(H, 'regtest');

function rpcOver(mods, view){
    const indexer = { config: { NETWORK: 'regtest' }, indexerDb: { apiView: () => view } };
    return mods.capabilities.buildCapabilitiesRpc({ indexer });
}

describe('getstakeweightsbycapability serves the committed weight read @regression @tier1', function () {
    let mods, ENV_BEFORE, needed;

    before(function () {
        ENV_BEFORE = process.env[ENV_KEY];
        mods = reload('armed');
        needed = activeGatesAt(H, 'regtest');
        assert.ok(needed.length > 0, 'a gate must be active at ' + H + ' or no row is ever dropped');
    });
    after(function () { reload(ENV_BEFORE); });
    afterEach(function () { sinon.restore(); });

    const rpcFor = (view) => rpcOver(mods, view);

    it('echoes the pre-read truncation flag and counts keys and sources from the committed read', async function () {
        sinon.stub(observability.getLogger(), 'info');
        const view = makeView(rows, needed, true);
        const res = await rpcFor(view).getstakeweightsbycapability({ capability: 'price', block_index: BLOCK });
        assert.strictEqual(res.truncated, true);
        assert.strictEqual(res.count, 3);
        assert.strictEqual(res.source_count, 3);
        assert.deepStrictEqual(res.validators.map(v => v.pubkey), [PK_A, PK_B, PK_C]);
    });

    it('applies the rules filter to no capability today, so no rolled gates are read', async function () {
        sinon.stub(observability.getLogger(), 'info');
        for(const capability of ['price', 'cross_chain', 'oracle_publish']){
            const view = makeView(rows, needed, false);
            const res = await rpcFor(view).getstakeweightsbycapability({ capability, block_index: BLOCK });
            assert.strictEqual(res.count, 3, capability);
            assert.strictEqual(view.gateReads, 0, capability);
        }
    });

    // Owed: enable once the weighted RPC serves the rules-aware attestation set. It drives the
    // real armed filter and the real resolveResponsibleSet, and fails while the RPC still
    // returns the validator the chain drops.
    it.skip('answers the same attestation keys the chain ranks for one request, dropping a validator whose gates are not a superset', async function () {
        sinon.stub(observability.getLogger(), 'info');
        const view = makeView(rows, needed, false);
        const res = await rpcFor(view).getstakeweightsbycapability({ capability: 'attestation', block_index: BLOCK });
        const chain = Object.assign({}, mods.responsible, {
            config: { NETWORK: 'regtest' },
            indexerDb: view,
            providerFloorFilter: (validators) => validators,
        });
        const resolved = await chain.resolveResponsibleSet('req-1', 50, H, 'provider');
        assert.ok(!resolved.includes(PK_A), 'the chain drops the validator the gates refuse');
        assert.deepStrictEqual(res.validators.map(v => v.pubkey).sort(), resolved.slice().sort());
    });
});
