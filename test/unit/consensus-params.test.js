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
 * Consensus-parameter FREEZE guard (LAUNCH-PLAN track 8).
 *
 * The indexer half of the frozen consensus surface: GAS_SCHEDULE + GAS_PRICE
 * (which feed fee = gasUsed × GAS_PRICE AND contract_hash via executions), and
 * the status vocabulary mapped by utility.vmFailureStatus. These are golden
 * literals; any drift reddens here. A real change must bump the VM's
 * CONSENSUS_VERSION + a new golden in BOTH repos and, post-launch, a
 * protocol_changes.js block-height activation.
 * See claude/reports/launch/CONSENSUS-ACTIVATION-RUNBOOK.md.
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const Utility = require('../../src/utility.js');

// ---- frozen golden (consensus epoch '2') ----
const GOLDEN_GAS_PRICE = '0.00001';
const GOLDEN_GAS_SCHEDULE = {
    ISSUE:              100000,
    ISSUE_SUBTOKEN:     50000,
    EXPIRATION_PER_DAY: 550,
    OWNERSHIP_ESCROW:   50000,
    AIRDROP_PER_RECIPIENT: 100,
    DIVIDEND_PER_RECIPIENT: 100,
    VM_EXECUTE_BASE:    1000,
    VM_GUARD_GAS_CEILING: 200000,
    VM_DEPLOY_BASE:     100000,
    VM_DEPLOY_PER_BYTE: 10,
    VM_STATE_READ:      100,
    VM_STATE_WRITE:     200,
    VM_STATE_DELETE:    100,
    VM_ORACLE_READ:     100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST:  5000,
    VM_XCALL_REQUEST:   2000,
    VM_XCALL_CALLBACK:  20000,
    VM_EMISSION:        500,
    VM_COMPUTATION:     1
};
const EXPECTED_VM_CONSENSUS_VERSION = '2';
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
    'WeakRef', 'WebSocket', 'XMLHttpRequest', 'clearImmediate', 'clearInterval',
    'clearTimeout', 'fetch', 'performance', 'queueMicrotask', 'setImmediate',
    'setInterval', 'setTimeout', 'structuredClone'
];
const EXPECTED_VM_CONSENSUS_RULES = [
    'banned-async', 'banned-literal', 'banned-math',
    'invalid-type', 'reserved-identifier', 'unsupported-syntax'
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
// Frozen math-library versions. decimal.js is the BigNumber backend that performs the
// consensus-critical precision-64 arithmetic behind every contract math root; mathjs is the
// fee/amount math engine. Both are pinned EXACTLY in this package's `overrides` block so a
// lockfile re-resolve or `npm update` cannot float them (mathjs declares decimal.js as a caret,
// ^10.4.3, which would otherwise drift the backend within 10.x and silently change math roots →
// divergent Merkle root → chain fork). This asserts the pin where consensus actually runs (the
// deployed indexer process); the analogous MATH_PINNED guard lives VM-side only and npm honors
// `overrides` only from the top-level package, so the vendored VM's own pin is inert here.
const GOLDEN_DECIMAL_JS_VERSION = '10.4.3';
const GOLDEN_MATHJS_VERSION     = '15.2.0';
// Safety cap on validator-set queries (db.js). Read on the deterministic block-processing
// path (responsible-set / quorum gates), so it is a FROZEN node-local consensus constant
// (identical across chains, never an env var). A per-node value forks the federation once the
// qualifying set exceeds the smaller cap.
const GOLDEN_VALIDATOR_QUERY_LIMIT = 1000;

// Other NODE-LOCAL consensus params (frozen with the wire format, track 8). These
// feed fee math / activation-block math / tx-acceptance and land in hashed state, and
// unlike the GAS_* pair, they are NOT identical across chains, so the golden is
// PER-CHAIN.
//
// ACTIVATION_DELAY_BLOCKS, EXPIRATION_FEE_PER_DAY and STAKING were previously left on the
// hub config overlay's live-poll list. That was a soft-fork hazard: federation nodes
// observe a committed hub change at different block heights, so a live push would stamp
// divergent activation_block / expiration-fee rows for the SAME on-chain tx. They are now
// treated like GAS_*: node-local, changeable only via a coordinated upgrade gated on an
// activation height. The overlay no longer polls them (see XChainIndexer
// _mergeHubParams). The behavioural guard at the bottom of this file pins that.
const GOLDEN_FEE_PARAMS_SHARED = {
    EXPIRATION_FEE_DEFAULT_DAYS:      90,
    EXPIRATION_FEE_FREE_DAYS:         182,
    UNIFIED_EXPIRATION_FEE_FREE_DAYS: 90,
    FEE_TOLERANCE_MIN:                '0.95',
    FEE_TOLERANCE_MAX:                '1.10',
    ORACLE_MAX_PRICE_AGE_SECONDS:     1800
};
const GOLDEN_FEE_PARAMS_PER_CHAIN = {
    BTC:  { ISSUANCE_FEE_TOKEN: '1.00000000', ISSUANCE_FEE_SUBTOKEN: '0.50000000', FEE_PAYMENT_MODE: 'xchain', EXPIRATION_FEE_PER_DAY: '0.00547945' },
    LTC:  { ISSUANCE_FEE_TOKEN: '0.50000000', ISSUANCE_FEE_SUBTOKEN: '0.25000000', FEE_PAYMENT_MODE: 'native', EXPIRATION_FEE_PER_DAY: '0.00273973' },
    DOGE: { ISSUANCE_FEE_TOKEN: '0.25000000', ISSUANCE_FEE_SUBTOKEN: '0.10000000', FEE_PAYMENT_MODE: 'native', EXPIRATION_FEE_PER_DAY: '0.00136986' }
};
// Per-chain staking consensus golden. ACTIVATION_DELAY_BLOCKS and COOLDOWN_BLOCKS drive
// activation_block / deactivation_block hashed state across stake/delegate/unstake.
// Both are calibrated per-chain for a consistent wall-clock at each chain's block time:
// ACTIVATION_DELAY_BLOCKS ~= 60-min reorg protection, COOLDOWN_BLOCKS ~= 7-day unstake hold.
const GOLDEN_STAKING_PER_CHAIN = {
    BTC:  { ACTIVATION_DELAY_BLOCKS: 6,  COOLDOWN_BLOCKS: 1000 },
    LTC:  { ACTIVATION_DELAY_BLOCKS: 24, COOLDOWN_BLOCKS: 4032 },
    DOGE: { ACTIVATION_DELAY_BLOCKS: 60, COOLDOWN_BLOCKS: 10080 }
};
// Consensus params that must NOT be live-polled by the hub config overlay; doing so races
// the federation into a soft fork. The behavioural test below asserts the overlay ignores
// hub attempts to change them.
const NON_POLLED_CONSENSUS_PARAMS = ['ACTIVATION_DELAY_BLOCKS', 'EXPIRATION_FEE_PER_DAY', 'STAKING'];

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
        try { return { vm: require('../../../xchain-vm/src/consensus-runtime.js'), full: false, pkgErr: e }; }
        catch(e2){ return { vm: null, full: false, pkgErr: e }; }
    }
}

describe('consensus parameters are frozen (track 8 guard) @regression', function(){

    it('GAS_SCHEDULE + GAS_PRICE equal the golden on every chain (identical across BTC/LTC/DOGE)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../src/configs/' + coin + '.js').getConfig('regtest');
            assert.strictEqual(cfg.GAS_PRICE, GOLDEN_GAS_PRICE, coin + ' GAS_PRICE drifted');
            assert.deepStrictEqual(cfg.GAS_SCHEDULE, GOLDEN_GAS_SCHEDULE, coin + ' GAS_SCHEDULE drifted');
        }
    });

    it('VALIDATOR_QUERY_LIMIT equals the golden on every chain (frozen node-local, not env-tunable)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../src/configs/' + coin + '.js').getConfig('regtest');
            assert.strictEqual(cfg.VALIDATOR_QUERY_LIMIT, GOLDEN_VALIDATOR_QUERY_LIMIT, coin + ' VALIDATOR_QUERY_LIMIT drifted');
        }
    });

    it('node-local fee/oracle params equal the golden on every chain (per-chain + shared)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../src/configs/' + coin + '.js').getConfig('regtest');
            for(const [k, v] of Object.entries(GOLDEN_FEE_PARAMS_SHARED))
                assert.strictEqual(cfg[k], v, coin + ' ' + k + ' drifted (shared consensus param)');
            for(const [k, v] of Object.entries(GOLDEN_FEE_PARAMS_PER_CHAIN[coin]))
                assert.strictEqual(cfg[k], v, coin + ' ' + k + ' drifted (per-chain consensus param)');
        }
    });

    it('per-chain STAKING activation/cooldown equal the golden (node-local consensus)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../src/configs/' + coin + '.js').getConfig('regtest');
            const g   = GOLDEN_STAKING_PER_CHAIN[coin];
            assert.ok(cfg.STAKING, coin + ' STAKING missing');
            assert.strictEqual(cfg.STAKING.ACTIVATION_DELAY_BLOCKS, g.ACTIVATION_DELAY_BLOCKS, coin + ' STAKING.ACTIVATION_DELAY_BLOCKS drifted');
            assert.strictEqual(cfg.STAKING.COOLDOWN_BLOCKS, g.COOLDOWN_BLOCKS, coin + ' STAKING.COOLDOWN_BLOCKS drifted');
        }
    });

    it('hub config overlay does NOT live-poll consensus params (soft-fork guard)', function(){
        // The overlay (_mergeHubParams) must ignore hub-pushed values for any param that
        // feeds block-hashed state. If a future edit re-adds one of NON_POLLED_CONSENSUS_PARAMS
        // to the SCALAR_PARAMS/BLOB_PARAMS poll lists, the local consensus value below would be
        // overwritten by the divergent hub value and this reddens.
        let XChainIndexer;
        try { XChainIndexer = require('../../src/XChainIndexer.js'); }
        catch(e){ this.skip(); return; } // heavy deps (db/vm) absent in standalone CI
        const stub = { config: {
            COIN: 'BTC', NETWORK: 'regtest',
            EXPIRATION_FEE_PER_DAY: '0.00547945',
            STAKING: { ACTIVATION_DELAY_BLOCKS: 6, COOLDOWN_BLOCKS: 1000 }
        }};
        // Hub commits divergent values for every consensus param this finding covers.
        const hubAttempt = { BTC: { regtest: { 'xchain-indexer': {
            EXPIRATION_FEE_PER_DAY: '9.99999999',
            ACTIVATION_DELAY_BLOCKS: 999,
            STAKING: { ACTIVATION_DELAY_BLOCKS: 999, COOLDOWN_BLOCKS: 1 }
        }}}};
        XChainIndexer.prototype._mergeHubParams.call(stub, hubAttempt);
        assert.strictEqual(stub.config.EXPIRATION_FEE_PER_DAY, '0.00547945', 'EXPIRATION_FEE_PER_DAY was live-polled');
        assert.strictEqual(stub.config.STAKING.ACTIVATION_DELAY_BLOCKS, 6, 'STAKING.ACTIVATION_DELAY_BLOCKS was live-polled');
        assert.strictEqual(stub.config.STAKING.COOLDOWN_BLOCKS, 1000, 'STAKING.COOLDOWN_BLOCKS was live-polled');
        assert.strictEqual(stub.config.ACTIVATION_DELAY_BLOCKS, undefined, 'top-level ACTIVATION_DELAY_BLOCKS was live-polled');
    });

    it('the consensus-critical math libraries are pinned to the frozen versions (decimal.js + mathjs)', function(){
        // Read the ACTUALLY-INSTALLED versions (not the package.json range) so the assertion
        // fails if a lockfile re-resolve floats decimal.js within the caret mathjs declares.
        const installedDecimal = require('decimal.js/package.json').version;
        const installedMathjs  = require('mathjs/package.json').version;
        assert.strictEqual(installedDecimal, GOLDEN_DECIMAL_JS_VERSION,
            'installed decimal.js drifted from the frozen pin (overrides["decimal.js"] must equal ' + GOLDEN_DECIMAL_JS_VERSION + '); a caret float here changes precision-64 contract math roots and forks the chain');
        assert.strictEqual(installedMathjs, GOLDEN_MATHJS_VERSION,
            'installed mathjs drifted from the frozen pin (overrides["mathjs"] must equal ' + GOLDEN_MATHJS_VERSION + ')');
    });

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

    it('the bundled VM agrees on the consensus version + status vocabulary (cross-repo coupling)', function(){
        const { vm, full, pkgErr } = resolveVmConsensus();
        // A package load failure caused by the VM's own frozen-export guard
        // (a dropped/renamed STRIPPED_GLOBAL_NAMES or CONSENSUS_RULES) must redden,
        // not degrade to the fallback and skip.
        if(pkgErr && /STRIPPED_GLOBAL_NAMES|CONSENSUS_RULES/.test(String(pkgErr && pkgErr.message)))
            assert.fail('xchain-vm failed to load its frozen consensus surface: ' + pkgErr.message);
        if(!vm){ this.skip(); return; } // standalone CI without the VM present
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

    it('the VM async/binary flag-day timestamps match the indexer protocol_changes (cross-repo byte-gate)', function(){
        const { vm, full } = resolveVmConsensus();
        if(!vm || !full){ this.skip(); return; } // standalone CI without the real VM present
        const pc = require('../../src/protocol_changes.js');
        // These VM gates and the indexer's VM_BANNED_ASYNC mainnet_time flip the SAME
        // coordinated 2.0.0 consensus boundary. They live in two repos with independent
        // deploy cycles, so a one-sided edit (or a stale bundled-VM dep mid-upgrade)
        // ships a fleet that forks at the flag-day with no other CI failure. Assert
        // byte-identity here. Gates: ASYNC_SURFACE (banned-async enforcement),
        // BINARY_ALLOC (binary allocation), STATE_KEY_NUL (H-5, rejects NUL-byte state
        // keys that would wedge the block merkle root), METERING_EVAL_ORDER (L-3,
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
            'CALL_SPREAD_METER_GATE_BLOCK_TIME'
        ];
        for(const gate of GATE_EXPORTS){
            assert.notStrictEqual(vm[gate], undefined,
                'xchain-vm did not export ' + gate + ' (stale vendored copy? run npm run vendor:vm; renamed? update GATE_EXPORTS in lockstep)');
            assert.strictEqual(vm[gate], pc.VM_BANNED_ASYNC_MAINNET_TIME,
                'xchain-vm ' + gate + ' != indexer VM_BANNED_ASYNC mainnet_time; update both repos in lockstep (one-sided edit forks the fleet at the flag-day)');
        }
    });

    it('the indexer NATIVE_FEE_PRICE_TIME_GATE flag-day matches the coordinated 2.0.0 timestamp', function(){
        // H-3: deterministic (time-gated) price_snapshots selection for native-coin fee
        // validation on non-reference chains flips at this flag-day. It is an indexer-internal
        // consensus gate (utility.getFeeOraclePrices + the sync barrier), pinned to the same
        // canonical 2.0.0 timestamp as the VM async/binary gates: a divergent value forks the
        // fleet on the first fee-bearing LTC/DOGE action after the boundary. Same-repo, no VM dep.
        const pc = require('../../src/protocol_changes.js');
        assert.strictEqual(pc.NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME, pc.VM_BANNED_ASYNC_MAINNET_TIME,
            'NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME drifted from the coordinated 2.0.0 flag-day timestamp');
    });
});
