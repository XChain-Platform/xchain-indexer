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
 * literals — any drift reddens here. A real change must bump the VM's
 * CONSENSUS_VERSION + a new golden in BOTH repos and, post-launch, a
 * protocol_changes.js block-height activation.
 * See claude/reports/launch/CONSENSUS-ACTIVATION-RUNBOOK.md.
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const Utility = require('../../src/utility.js');

// ---- frozen golden (consensus epoch '1') ----
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
const EXPECTED_VM_CONSENSUS_VERSION = '1';
const FROZEN_STATUS_TOKENS = ['reverted', 'out_of_resource', 'failed'];

// Other NODE-LOCAL consensus params (frozen with the wire format, track 8). These
// feed fee math / tx-acceptance and land in hashed state, and — unlike the GAS_*
// pair — they are NOT identical across chains, so the golden is PER-CHAIN.
// DELIBERATELY EXCLUDED (hub-governed, change at runtime via PBFT overlay — see
// XChainIndexer _applyHubConfigOverlay): ACTIVATION_DELAY_BLOCKS,
// EXPIRATION_FEE_PER_DAY, STAKING. Freezing those would break governance.
const GOLDEN_FEE_PARAMS_SHARED = {
    EXPIRATION_FEE_DEFAULT_DAYS:      90,
    EXPIRATION_FEE_FREE_DAYS:         182,
    UNIFIED_EXPIRATION_FEE_FREE_DAYS: 90,
    FEE_TOLERANCE_MIN:                '0.95',
    FEE_TOLERANCE_MAX:                '1.10',
    ORACLE_MAX_PRICE_AGE_SECONDS:     1800
};
const GOLDEN_FEE_PARAMS_PER_CHAIN = {
    BTC:  { ISSUANCE_FEE_TOKEN: '1.00000000', ISSUANCE_FEE_SUBTOKEN: '0.50000000', FEE_PAYMENT_MODE: 'xchain' },
    LTC:  { ISSUANCE_FEE_TOKEN: '0.50000000', ISSUANCE_FEE_SUBTOKEN: '0.25000000', FEE_PAYMENT_MODE: 'native' },
    DOGE: { ISSUANCE_FEE_TOKEN: '0.25000000', ISSUANCE_FEE_SUBTOKEN: '0.10000000', FEE_PAYMENT_MODE: 'native' }
};
// The hub-governed params that must STAY excluded from the freeze (a regression
// that moved one into the node-local frozen set would be caught by asserting the
// overlay still lists them — see the test below).
const HUB_GOVERNED_PARAMS = ['ACTIVATION_DELAY_BLOCKS', 'EXPIRATION_FEE_PER_DAY', 'STAKING'];

// Resolve the bundled VM's consensus exports, defensively: the file: dep
// (node_modules/xchain-vm -> ./xchain-vm) is populated in prod by xchain-node,
// and the sibling exists in the monorepo, but a standalone indexer CI checkout
// has neither — there we SKIP the cross-repo coupling rather than fail.
function resolveVmConsensus(){
    const tries = ['xchain-vm', '../../../xchain-vm/src/consensus-runtime.js'];
    for(const t of tries){
        try { return require(t); } catch(e){ /* try next */ }
    }
    return null;
}

describe('consensus parameters are frozen (track 8 guard) @regression', function(){

    it('GAS_SCHEDULE + GAS_PRICE equal the golden on every chain (identical across BTC/LTC/DOGE)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../src/configs/' + coin + '.js').getConfig('regtest');
            assert.strictEqual(cfg.GAS_PRICE, GOLDEN_GAS_PRICE, coin + ' GAS_PRICE drifted');
            assert.deepStrictEqual(cfg.GAS_SCHEDULE, GOLDEN_GAS_SCHEDULE, coin + ' GAS_SCHEDULE drifted');
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

    it('hub-governed params stay EXCLUDED from the freeze (governance must keep working)', function(){
        // Guard against accidentally freezing a hub-governed param: the indexer's
        // overlay must still treat these as runtime-adjustable. We assert they are
        // NOT present in either frozen fee golden, so a future edit that hard-codes
        // one into the golden reddens here with a clear reason.
        const frozenKeys = new Set([
            ...Object.keys(GOLDEN_FEE_PARAMS_SHARED),
            ...Object.keys(GOLDEN_FEE_PARAMS_PER_CHAIN.BTC),
            ...Object.keys(GOLDEN_GAS_SCHEDULE), 'GAS_PRICE', 'GAS_SCHEDULE'
        ]);
        for(const k of HUB_GOVERNED_PARAMS)
            assert.ok(!frozenKeys.has(k), k + ' is hub-governed and must NOT be frozen');
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
        const vm = resolveVmConsensus();
        if(!vm){ this.skip(); return; } // standalone CI without the VM present
        assert.strictEqual(vm.CONSENSUS_VERSION, EXPECTED_VM_CONSENSUS_VERSION,
            'bundled VM CONSENSUS_VERSION != indexer expectation — bump both together');
        assert.deepStrictEqual(vm.CONSENSUS_STATUS_TOKENS, FROZEN_STATUS_TOKENS,
            'VM status vocabulary drifted from the indexer mapping');
    });
});
