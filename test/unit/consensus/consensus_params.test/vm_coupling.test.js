/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Consensus-parameter FREEZE guard, the VM coupling half.
 *
 * The vmFailureStatus mapping into the frozen status token set, the bundled VM's
 * consensus version, sandbox strip sets and deploy CONSENSUS_RULES (the cross-repo
 * coupling), and the 2.0.0 flag-day timestamps held in lockstep with protocol_changes.
 * These goldens move only with a VM CONSENSUS_VERSION bump in BOTH repos. Part of the
 * consensus-parameter freeze guard; see ../consensus_params.test.js.
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const Utility = require('../../../../src/utility.js');
const fs      = require('fs');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

// Epoch 4: REST_PATTERN_METER added the `banned-rest` deploy rule VM-side, and a
// CONSENSUS_RULES change moves the epoch. This pin and the digests below are ONE
// unit; bumping the integer alone makes every assertion under it vacuous.
const EXPECTED_VM_CONSENSUS_VERSION = '4';
// Frozen digest of the bundled VM's deploy/execution contract surface, asserted in
// lockstep with the version above. Any change to the sandbox strip set or the deploy
// validator's CONSENSUS_RULES must bump EXPECTED_VM_CONSENSUS_VERSION (and the VM's
// CONSENSUS_VERSION) and regenerate these goldens together, closing the structural
// blind spot where a sandbox/lint consensus change could ship while the guard checked
// only the version integer. The authoritative digest lives VM-side (the strip set sits
// behind isolated-vm); these mirror it for the cross-repo coupling and are only checked
// when the bundled VM exposes them (a standalone indexer CI checkout skips the coupling).
const EXPECTED_VM_STRIPPED_GLOBAL_NAMES = [
    'Atomics', 'BigInt', 'Date', 'FinalizationRegistry', 'Intl',
    'Promise', 'Proxy', 'Reflect', 'SharedArrayBuffer', 'Temporal',
    'WeakRef', 'WebAssembly', 'WebSocket', 'XMLHttpRequest', 'clearImmediate',
    'clearInterval', 'clearTimeout', 'fetch', 'performance', 'queueMicrotask',
    'setImmediate', 'setInterval', 'setTimeout', 'structuredClone'
];
// `banned-rest` is the epoch-4 addition: the deploy validator refuses the four rest
// positions with no source expression to wrap, which the allocator meter cannot
// reach and which therefore copy O(n) elements for a flat 1 gas.
const EXPECTED_VM_CONSENSUS_RULES = [
    'banned-async', 'banned-generator', 'banned-literal', 'banned-math',
    'banned-rest', 'banned-wasm', 'invalid-type', 'reserved-identifier',
    'unsupported-syntax'
];
// The sandbox neuters more than the global strip set: prototype-method strips
// (regex + locale/ICU), the prototype .constructor neuters, and the SafeMath
// member whitelist are each consensus-critical and frozen VM-side. Mirror them
// here so a drift in any of those lists reddens the cross-repo coupling too.
// Proto methods are compared as a sorted 'Proto.method' key set.
const EXPECTED_VM_STRIPPED_PROTO_METHODS = [
    'Array.toLocaleString', 'Number.toLocaleString', 'Object.toLocaleString',
    'String.localeCompare', 'String.match', 'String.matchAll', 'String.normalize',
    'String.search', 'String.toLocaleLowerCase', 'String.toLocaleUpperCase'
];
const EXPECTED_VM_NEUTERED_PROTO_CONSTRUCTORS = [
    'Array', 'Boolean', 'Number', 'Object', 'RegExp', 'String'
];
const EXPECTED_VM_SAFE_MATH_MEMBERS = [
    'E', 'PI', 'abs', 'ceil', 'floor', 'max', 'min', 'round', 'sign', 'trunc'
];
const FROZEN_STATUS_TOKENS = ['reverted', 'out_of_resource', 'failed'];

// Resolve the bundled VM's consensus exports, defensively: the file: dep
// (node_modules/xchain-vm -> ./xchain-vm) is populated in prod by xchain-node,
// and the sibling exists in the monorepo, but a standalone indexer CI checkout
// has neither; there we SKIP the cross-repo coupling rather than fail.
function resolveVmConsensus(){
    // Prefer the real package (exports the full frozen surface incl. the strip set
    // + deploy rules). Only fall back to the consensus-runtime-only module (which
    // omits those) when the package is genuinely absent. A load error from the
    // package's own frozen-export guard is surfaced as pkgErr, not silently
    // degraded to the fallback, so a dropped export reddens rather than skips.
    try { return { vm: require('xchain-vm'), full: true, pkgErr: null }; }
    catch(e){
        // Two spellings, post-rename first: the VM renamed src/consensus-runtime.js
        // to src/consensus_runtime.js with nothing left behind, and a sibling can
        // sit on either side of that rename. Pinning one would send this guard to
        // the vm:null branch, which SKIPS, against the other.
        // A spelling counts only when its sibling may be trusted. The refusal carried out
        // names why nothing loaded, preferring a present-but-refused spelling (a lane
        // symlink into a live main checkout) over one that is simply absent.
        let refused = null;
        for (const spelling of ['../../../../../xchain-vm/src/consensus_runtime.js',
                                '../../../../../xchain-vm/src/consensus-runtime.js']) {
            const verdict = siblingCheckout(__dirname, spelling);
            if (!verdict.usable){
                if (!refused || fs.existsSync(verdict.path)) refused = verdict;
                continue;
            }
            try { return { vm: require(spelling), full: false, pkgErr: e, refused: null }; } catch(e2){ /* next */ }
        }
        return { vm: null, full: false, pkgErr: e, refused };
    }
}

describe('consensus parameters are frozen (track 8 guard) @regression', function(){
    it('vmFailureStatus maps every VM error into the frozen closed token set', function(){
        const util = new Utility();
        const cases = [
            ['revert: user said no',                         'reverted'],
            ['out_of_gas: used 1048105 of 1000000',          'out_of_resource'],
            ['timeout: wall-clock safety net triggered',     'out_of_resource'],
            ['out_of_memory: isolate memory limit exceeded', 'out_of_resource'],
            ['out_of_stack: maximum call depth exceeded',    'out_of_resource'],
            ['out_of_resource: execution host terminated',   'out_of_resource'],
            ['error: TypeError: x is not a function',        'failed'],
            ['something unrecognised',                        'failed'],
            ['', 'failed'],
            [null, 'failed']
        ];
        for(const [input, expected] of cases){
            const got = util.vmFailureStatus(input);
            assert.strictEqual(got, expected, 'vmFailureStatus(' + JSON.stringify(input) + ')');
            assert.ok(FROZEN_STATUS_TOKENS.includes(got), 'token outside frozen set: ' + got);
        }
    });
});

describe('consensus parameters are frozen (track 8 guard) @regression', function(){
    it('the bundled VM agrees on the consensus version + status vocabulary (cross-repo coupling)', function(){
        const { vm, full, pkgErr, refused } = resolveVmConsensus();
        // A package load failure caused by the VM's own frozen-export guard
        // (a dropped/renamed STRIPPED_GLOBAL_NAMES or CONSENSUS_RULES) must redden,
        // not degrade to the fallback and skip.
        if(pkgErr && /STRIPPED_GLOBAL_NAMES|CONSENSUS_RULES/.test(String(pkgErr && pkgErr.message)))
            assert.fail('xchain-vm failed to load its frozen consensus surface: ' + pkgErr.message);
        if(!vm){ return skipOrFail(this, refused, 'the bundled VM consensus coupling guard'); } // standalone CI without the VM present
        assert.strictEqual(vm.CONSENSUS_VERSION, EXPECTED_VM_CONSENSUS_VERSION,
            'bundled VM CONSENSUS_VERSION != indexer expectation (bump both together)');
        assert.deepStrictEqual(vm.CONSENSUS_STATUS_TOKENS, FROZEN_STATUS_TOKENS,
            'VM status vocabulary drifted from the indexer mapping');

        // Surface coupling: the sandbox strip set and the deploy CONSENSUS_RULES are
        // consensus surface frozen with the same epoch. The integer-only check above
        // is structurally blind to a strip-list / rule-set change; these digests close
        // that gap so a sandbox/lint edit reddens unless CONSENSUS_VERSION is bumped +
        // these goldens regenerated in lockstep. When the real package is loaded the
        // exports are MANDATORY (assert presence so a rename cannot silently skip);
        // only the consensus-runtime-only fallback (standalone CI) legitimately omits them.
        if(full){
            assert.ok(vm.STRIPPED_GLOBAL_NAMES, 'xchain-vm did not export STRIPPED_GLOBAL_NAMES (rename? bump CONSENSUS_VERSION + regolden)');
            assert.ok(vm.CONSENSUS_RULES, 'xchain-vm did not export CONSENSUS_RULES (rename? bump CONSENSUS_VERSION + regolden)');
            assert.ok(vm.STRIPPED_PROTO_METHODS, 'xchain-vm did not export STRIPPED_PROTO_METHODS (rename? update goldens in lockstep)');
            assert.ok(vm.NEUTERED_PROTO_CONSTRUCTORS, 'xchain-vm did not export NEUTERED_PROTO_CONSTRUCTORS (rename? update goldens in lockstep)');
            assert.ok(vm.SAFE_MATH_MEMBERS, 'xchain-vm did not export SAFE_MATH_MEMBERS (rename? update goldens in lockstep)');
        }
        if(vm.STRIPPED_GLOBAL_NAMES){
            assert.deepStrictEqual([...vm.STRIPPED_GLOBAL_NAMES].sort(), EXPECTED_VM_STRIPPED_GLOBAL_NAMES,
                'VM sandbox strip set drifted from the indexer expectation (bump CONSENSUS_VERSION + regolden in both repos)');
        }
        if(vm.CONSENSUS_RULES){
            assert.deepStrictEqual([...vm.CONSENSUS_RULES].sort(), EXPECTED_VM_CONSENSUS_RULES,
                'VM deploy CONSENSUS_RULES drifted from the indexer expectation (bump CONSENSUS_VERSION + regolden in both repos)');
        }
        if(vm.STRIPPED_PROTO_METHODS){
            const keys = vm.STRIPPED_PROTO_METHODS.map(e => e.proto + '.' + e.method).sort();
            assert.deepStrictEqual(keys, EXPECTED_VM_STRIPPED_PROTO_METHODS,
                'VM sandbox prototype-method neuters drifted from the indexer expectation (update goldens in both repos in lockstep)');
        }
        if(vm.NEUTERED_PROTO_CONSTRUCTORS){
            assert.deepStrictEqual([...vm.NEUTERED_PROTO_CONSTRUCTORS].sort(), EXPECTED_VM_NEUTERED_PROTO_CONSTRUCTORS,
                'VM prototype .constructor neuter targets drifted from the indexer expectation (update goldens in both repos in lockstep)');
        }
        if(vm.SAFE_MATH_MEMBERS){
            assert.deepStrictEqual([...vm.SAFE_MATH_MEMBERS].sort(), EXPECTED_VM_SAFE_MATH_MEMBERS,
                'VM SafeMath member whitelist drifted from the indexer expectation (update goldens in both repos in lockstep)');
        }
    });
});

describe('consensus parameters are frozen (track 8 guard) @regression', function(){
    it('the VM async/binary flag-day timestamps match the indexer protocol_changes (cross-repo byte-gate)', function(){
        const { vm, full, pkgErr, refused } = resolveVmConsensus();
        // Under the required-siblings lane a stale/absent vendored VM (the exact
        // one-sided-edit threat this cross-repo byte-gate exists to catch) must
        // redden, not degrade to a silent pending. Only standalone CI legitimately skips.
        if(!vm || !full){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                assert.fail('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-vm did not resolve to its full package surface (stale/absent vendored VM): ' + (pkgErr ? String(pkgErr.message) : 'package not present') + (refused ? '; sibling fallback refused: ' + refused.reason : ''));
            this.skip(); return;
        } // standalone CI without the real VM present
        const pc = require('../../../../src/protocol_changes.js');
        // These VM gates and the indexer's VM_BANNED_ASYNC mainnet_time flip the SAME
        // coordinated 2.0.0 consensus boundary. They live in two repos with independent
        // deploy cycles, so a one-sided edit (or a stale bundled-VM dep mid-upgrade)
        // ships a fleet that forks at the flag-day with no other CI failure. Assert
        // byte-identity here. Gates: ASYNC_SURFACE (banned-async enforcement),
        // BINARY_ALLOC (binary allocation), STATE_KEY_NUL (rejects NUL-byte state
        // keys that would wedge the block merkle root), METERING_EVAL_ORDER (
        // JS-spec-correct compound string-append evaluation order), STATE_KEY_TYPE
        // (state-key type coercion boundary), CALL_SPREAD_METER (cross-call spread
        // metering). Every gate the VM exports at this coordinated flag-day must be listed
        // here; add each future gate in lockstep so a dropped one reddens, not skips.
        //
        // Presence is MANDATORY: this test only runs against the real bundled package
        // (skipped above when !full), so a missing gate export means a STALE VENDORED
        // COPY and must FAIL, not skip. The 2026-07 drift (vendored copies missing the
        // STATE_KEY_NUL + METERING_EVAL_ORDER gates at the same declared version)
        // passed vacuously through the if-undefined guards this replaces.
        const GATE_EXPORTS = [
            'ASYNC_SURFACE_GATE_BLOCK_TIME',
            'BINARY_ALLOC_GATE_BLOCK_TIME',
            'STATE_KEY_NUL_GATE_BLOCK_TIME',
            'METERING_EVAL_ORDER_GATE_BLOCK_TIME',
            'STATE_KEY_TYPE_GATE_BLOCK_TIME',
            'CALL_SPREAD_METER_GATE_BLOCK_TIME',
            'VM_LINT_HARDENING_GATE_BLOCK_TIME'
        ];
        for(const gate of GATE_EXPORTS){
            assert.notStrictEqual(vm[gate], undefined,
                'xchain-vm did not export ' + gate + ' (stale vendored copy? run npm run vendor:vm; renamed? update GATE_EXPORTS in lockstep)');
            assert.strictEqual(vm[gate], pc.VM_BANNED_ASYNC_MAINNET_TIME,
                'xchain-vm ' + gate + ' != indexer VM_BANNED_ASYNC mainnet_time; update both repos in lockstep (one-sided edit forks the fleet at the flag-day)');
        }
    });

    it('the indexer NATIVE_FEE_PRICE_TIME_GATE flag-day matches the coordinated 2.0.0 timestamp', function(){
        // Deterministic (time-gated) price_snapshots selection for native-coin fee
        // validation on non-reference chains flips at this flag-day. It is an indexer-internal
        // consensus gate whose sole consumer is utility.getFeeOraclePrices (the block loop's
        // time-keyed price barrier is unconditional and NOT a consumer), pinned to the same
        // canonical 2.0.0 timestamp as the VM async/binary gates: a divergent value forks the
        // fleet on the first fee-bearing LTC/DOGE action after the boundary. Same-repo, no VM dep.
        const pc = require('../../../../src/protocol_changes.js');
        assert.strictEqual(pc.NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME, pc.VM_BANNED_ASYNC_MAINNET_TIME,
            'NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME drifted from the coordinated 2.0.0 flag-day timestamp');
    });
});

describe('consensus parameters are frozen (track 8 guard) @regression', function(){
    it('the DISPENSE_CANCELLING_MATCH_ACTIVATION flag-day stays in lockstep with the 2.0.0 flag-day (VM_BANNED_ASYNC_MAINNET_TIME)', function(){
        // db.findMatchingDispensers flips its cancelling-dispenser correlation at this
        // mainnet time. The module documents it as part of the coordinated 2.0.0 cohort (same
        // canonical timestamp as VM_BANNED_ASYNC_MAINNET_TIME / NATIVE_FEE_PRICE_TIME_GATE), but
        // it re-declares the literal standalone. Every other cohort member has a lockstep
        // assertion (the VM gates via GATE_EXPORTS above, NATIVE_FEE_PRICE_TIME_GATE just above);
        // this one only had a self-referential read. Assert equality so a one-sided re-timing of
        // the cohort reddens CI instead of forking the fleet in the gap window.
        const pc  = require('../../../../src/protocol_changes.js');
        const dcm = require('../../../../src/dispense_cancelling_match_activation.js');
        assert.strictEqual(dcm.DISPENSE_CANCELLING_MATCH_ACTIVATION.mainnet, pc.VM_BANNED_ASYNC_MAINNET_TIME,
            'DISPENSE_CANCELLING_MATCH_ACTIVATION.mainnet drifted from the coordinated 2.0.0 flag-day timestamp');
    });
});
