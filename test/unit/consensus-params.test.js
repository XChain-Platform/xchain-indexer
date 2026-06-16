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
// Safety cap on validator-set queries (db.js). Read on the deterministic block-processing
// path (responsible-set / quorum gates), so it is a FROZEN node-local consensus constant —
// identical across chains, never an env var. A per-node value forks the federation once the
// qualifying set exceeds the smaller cap.
const GOLDEN_VALIDATOR_QUERY_LIMIT = 1000;

// Other NODE-LOCAL consensus params (frozen with the wire format, track 8). These
// feed fee math / activation-block math / tx-acceptance and land in hashed state, and
// — unlike the GAS_* pair — they are NOT identical across chains, so the golden is
// PER-CHAIN.
//
// ACTIVATION_DELAY_BLOCKS, EXPIRATION_FEE_PER_DAY and STAKING were previously left on the
// hub config overlay's live-poll list. That was a soft-fork hazard: federation nodes
// observe a committed hub change at different block heights, so a live push would stamp
// divergent activation_block / expiration-fee rows for the SAME on-chain tx. They are now
// treated like GAS_* — node-local, changeable only via a coordinated upgrade gated on an
// activation height — and the overlay no longer polls them (see XChainIndexer
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
// COOLDOWN_BLOCKS is shared; ACTIVATION_DELAY_BLOCKS is calibrated per-chain for ~60-min
// reorg protection at each chain's block time.
const GOLDEN_STAKING_PER_CHAIN = {
    BTC:  { ACTIVATION_DELAY_BLOCKS: 6,  COOLDOWN_BLOCKS: 1000 },
    LTC:  { ACTIVATION_DELAY_BLOCKS: 24, COOLDOWN_BLOCKS: 1000 },
    DOGE: { ACTIVATION_DELAY_BLOCKS: 60, COOLDOWN_BLOCKS: 1000 }
};
// Consensus params that must NOT be live-polled by the hub config overlay — doing so races
// the federation into a soft fork. The behavioural test below asserts the overlay ignores
// hub attempts to change them.
const NON_POLLED_CONSENSUS_PARAMS = ['ACTIVATION_DELAY_BLOCKS', 'EXPIRATION_FEE_PER_DAY', 'STAKING'];

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
