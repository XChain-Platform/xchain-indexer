// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pin the bundled VM's emit-time call limits against the indexer's host re-check of the
// same emission (validateEmissionBounds). The host must never be stricter than the VM, and
// depth and the gas floor must agree exactly, or one side runs a call the other refuses.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const Execute = require('../../../src/actions/execute/index.js');
const PROTO   = require('../../../src/protocol/constants.js');
const OWN_PKG = require('../../../package.json');
const { GAS_CEILING } = require('../../../src/actions/deploy/constants.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

// The VM modules this test loads; a tree missing any of them is a stale copy, not a pass.
const VM_MODULES = ['src/gateway-emit.js', 'src/gas.js', 'src/collector.js', 'src/index/runtime/limits_defaults.js'];

// Same schedule the VM's own call-limit test builds its tracker from.
const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// Find the VM in the order the indexer would: installed package, the file: copy, then the sibling.
function resolveVmRoot() {
    try { return { usable: true, source: 'installed', path: path.dirname(require.resolve('xchain-vm/package.json')) }; }
    catch (e) { /* not installed: try the copy package.json names */ }
    const spec = String((OWN_PKG.dependencies || {})['xchain-vm'] || '');
    const vendored = /^file:/.test(spec) ? path.resolve(__dirname, '../../..', spec.slice(5)) : null;
    if (vendored && fs.existsSync(path.join(vendored, 'package.json')))
        return { usable: true, source: 'vendored', path: vendored };
    const verdict = siblingCheckout(__dirname, '../../../../xchain-vm/package.json');
    return Object.assign({}, verdict, { source: 'sibling', path: path.dirname(verdict.path) });
}

// Refuse a VM tree that lacks a module this test needs, naming it as drift rather than a load crash.
function assertVmLayout(root, source) {
    let version = 'unknown';
    try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch (e) { /* named below */ }
    const label = 'xchain-vm ' + source + ' v' + version + ' at ' + root;
    const missing = VM_MODULES.filter(rel => !fs.existsSync(path.join(root, rel)));
    if (missing.length === 0) return label;
    const remedy = source === 'sibling'
        ? 'the sibling checkout predates the layout this test pins; update it'
        : 'the bundled copy is stale; re-stage it with bin/vendor-vm.sh stage (npm run vendor:vm on Linux) and confirm with bin/vendor-vm.sh check';
    throw new Error(label + ' lacks ' + missing.join(', ') + ': ' + remedy);
}

// The pure modules behind emit.execute and the VM's limit defaults (no native addon).
function loadVm(root, source) {
    const label = assertVmLayout(root, source);
    return {
        label,
        buildEmitAPI:      require(path.join(root, VM_MODULES[0])).buildEmitAPI,
        GasTracker:        require(path.join(root, VM_MODULES[1])),
        EmissionCollector: require(path.join(root, VM_MODULES[2])),
        resolveLimits:     require(path.join(root, VM_MODULES[3])).resolveLimits
    };
}

// Did the VM accept this call? A fresh tracker per call at the host ceiling, the most a production run can grant.
function vmAccepts(vm, ctx, gasLimit) {
    const emit = vm.buildEmitAPI(new vm.GasTracker(SCHEDULE, GAS_CEILING), new vm.EmissionCollector(50), SCHEDULE, ctx);
    try { emit.execute({ contractIndex: 1, method: 'm', gasLimit }); return true; }
    catch (e) { return false; }
}

// Did the host bounds pass? Every `this` read throws, so getting past the bounds is visible.
async function hostAccepts(depth, gasLimit) {
    const pastBounds = new Proxy({}, { get(_, prop) { throw new Error('PAST_BOUNDS:' + String(prop)); } });
    try {
        await Execute.prototype.processEmission.call(pastBounds,
            { action: 'EXECUTE', params: { contractIndex: 1, method: 'm', gasLimit } }, { CALL_DEPTH: depth }, 0);
    } catch (e) {
        if (/PAST_BOUNDS/.test(e.message)) return true;
        if (/max call depth|gasLimit out of range/.test(e.message)) return false;
        throw e;
    }
    throw new Error('processEmission returned without reaching the routing step');
}

// Both VM context shapes: the production one (limits back-filled from a limits object that
// names no call limit, as the indexer's vmOptions does) and the emit-API fallback.
function contextShapes(vm) {
    const limits = vm.resolveLimits({ maxCpuTimeMs: 30000 });
    return {
        production: d => ({ callDepth: d, maxCallDepth: limits.maxCallDepth, minCallGas: limits.minCallGas }),
        fallback:   d => ({ callDepth: d })
    };
}

// The largest reservation the VM grants out of a full host-ceiling budget (it charges VM_EMISSION on top).
const VM_GAS_CAP = GAS_CEILING - SCHEDULE.VM_EMISSION;

// Upper-bound verdicts per gasLimit within depth: [vm, host]. The host is looser above the VM cap by design.
const UPPER_BOUND = new Map([
    [VM_GAS_CAP,      [true,  true]],
    [VM_GAS_CAP + 1,  [false, true]],
    [GAS_CEILING,     [false, true]],
    [GAS_CEILING + 1, [false, false]]
]);

// Every cell of the depth x gasLimit grid with both verdicts.
async function grid(vm, shape) {
    const cells = [];
    for (let d = 0; d <= PROTO.VM_MAX_CALL_DEPTH + 1; d++) {
        for (const gasLimit of [PROTO.VM_MIN_CALL_GAS - 1, PROTO.VM_MIN_CALL_GAS, ...UPPER_BOUND.keys()])
            cells.push({ d, gasLimit, vm: vmAccepts(vm, shape(d), gasLimit), host: await hostAccepts(d, gasLimit) });
    }
    return cells;
}

// Pin both upper bounds: the VM's remaining-gas cap and the host's GAS_CEILING, at every depth within the limit.
function assertUpperBound(cells, at) {
    for (const c of cells) {
        if (c.d >= PROTO.VM_MAX_CALL_DEPTH || !UPPER_BOUND.has(c.gasLimit)) continue;
        assert.deepStrictEqual([c.vm, c.host], UPPER_BOUND.get(c.gasLimit), at(c) + ': upper bound [vm, host] moved');
    }
}

describe('EXECUTE host bounds match the bundled VM call limits @regression @tier1', function () {
    let vm = null;
    before(function () {
        const verdict = resolveVmRoot();
        if (!skipOrFail(this, verdict, 'the host-vs-VM call-limit parity')) return;
        vm = loadVm(verdict.path, verdict.source);
    });

    it('the VM back-fills the same call limits the host re-checks', function () {
        const limits = vm.resolveLimits({ maxCpuTimeMs: 30000 });
        assert.strictEqual(limits.maxCallDepth, PROTO.VM_MAX_CALL_DEPTH, vm.label);
        assert.strictEqual(limits.minCallGas, PROTO.VM_MIN_CALL_GAS, vm.label);
    });

    it('the host is never stricter than the VM, and depth and floor agree exactly', async function () {
        for (const [name, shape] of Object.entries(contextShapes(vm))) {
            const cells = await grid(vm, shape);
            const at = c => vm.label + ' ' + name + ' d=' + c.d + ' gasLimit=' + c.gasLimit;
            for (const c of cells) {
                if (c.vm) assert.ok(c.host, at(c) + ': VM runs the call, host refuses it');
                if (c.gasLimit <= PROTO.VM_MIN_CALL_GAS) assert.strictEqual(c.host, c.vm, at(c) + ': verdicts differ');
            }
            assertUpperBound(cells, at);
            assert.ok(cells.some(c => c.vm), name + ': grid holds no accepted cell');
            assert.ok(cells.some(c => !c.vm && c.gasLimit === PROTO.VM_MIN_CALL_GAS), name + ': grid holds no depth refusal');
            assert.ok(cells.some(c => !c.vm && c.host && c.gasLimit > PROTO.VM_MIN_CALL_GAS), name + ': grid never reaches the VM gas cap');
        }
    });
});
