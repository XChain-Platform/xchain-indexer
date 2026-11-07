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
 *
 * The VM half of the coupling (the vmFailureStatus token set, the bundled VM's consensus
 * version, strip sets and deploy rules, and the 2.0.0 flag-day lockstep) lives beside
 * this file in consensus_params.test/vm_coupling.test.js, under the same describe so every
 * full test title is unchanged.
 ********************************************************************/

const assert = require('assert');
const { toIndexerConfig } = require('../../../src/coins/to_indexer_config.js');
const { hubConfigMethods } = require('../../../src/XChainIndexer/hub_config.js');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

// ---- frozen golden (consensus epoch '2') ----
const GOLDEN_GAS_PRICE = '0.00001';
const GOLDEN_GAS_SCHEDULE = {
    ISSUE:              100000,
    ISSUE_SUBTOKEN:     50000,
    EXPIRATION_PER_DAY: 550,
    OWNERSHIP_ESCROW:   50000,
    AIRDROP_PER_RECIPIENT: 100,
    DIVIDEND_PER_RECIPIENT: 100,
    // BET: duration-metered feed creation (own key so the
    // betting and order-book families re-price independently) + per-credit place
    // pre-funding. Landed pre-freeze with the BET action itself; the coins-registry
    // consensus_pin regenerated in the same change.
    BET_FEED_PER_DAY:   550,
    BET_PER_CREDIT:     100,
    // SWEEP / CALLBACK: the unified prices those two move onto at the
    // UNIFIED_FEES_SWEEP_CALLBACK flag day, which is genesis-active on mainnet and
    // regtest and armed at a future instant on the public testnet, whose committed
    // SWEEP and CALLBACK fees a genesis arm would re-price. The BASE keys are the point:
    // the legacy per-DB-hit price
    // had no floor, so on LTC/DOGE (where the protocol fee must be a real native-coin
    // output) a small SWEEP priced UNDER the chain's dust threshold and could not be
    // submitted at all. GAS_SCHEDULE is hashed whole by the coins registry, so adding
    // these regenerated consensus_pin in the same change.
    SWEEP_BASE:         5000,
    SWEEP_PER_ITEM:     100,
    CALLBACK_BASE:      5000,
    CALLBACK_PER_RECIPIENT: 100,
    // XBRIDGE: one flat price for every USER format (v0/v3 lock, v1/v4 burn); the
    // mirror-injected settle formats pay nothing, the CROSS_SETTLE precedent. Sized
    // at SWEEP_BASE for the SWEEP_BASE reason: on LTC and DOGE the protocol fee must
    // be a real native-coin output, so the smallest bridge action has to buy an
    // above-dust one on its own. GAS_SCHEDULE is hashed whole by the coins registry,
    // so adding this key regenerated consensus_pin in the same change.
    XBRIDGE_BASE:       5000,
    // Shared lists: the share fee, and a shared edit priced as a base plus a per-item
    // charge for each member added or removed. The base is sized at SWEEP_BASE for the
    // SWEEP_BASE reason, so the smallest shared edit buys an above-dust native fee
    // output on LTC and DOGE; local lists stay free and nothing charges these keys below
    // LIST_SHARE_ACTIVATION. GAS_SCHEDULE is hashed whole by the coins registry, so
    // adding them regenerated consensus_pin in the same change.
    LIST_SHARE:         100000,
    LIST_SHARED_EDIT_BASE: 5000,
    LIST_SHARED_EDIT_PER_ITEM: 100,
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
// Every golden consensus key stays off the hub config overlay's live-poll list.
// Polling one live is a soft-fork hazard: federation nodes
// observe a committed hub change at different block heights, so a live push would stamp
// divergent activation_block / expiration-fee rows for the SAME on-chain tx. They are
// treated like GAS_*: node-local, changeable only via a coordinated upgrade gated on an
// activation height. The overlay does not poll them (see XChainIndexer
// mergeHubParams). The behavioural guard at the bottom of this file pins that.
const GOLDEN_FEE_PARAMS_SHARED = {
    EXPIRATION_FEE_DEFAULT_DAYS:      90,
    EXPIRATION_FEE_FREE_DAYS:         182,
    UNIFIED_EXPIRATION_FEE_FREE_DAYS: 90,
    FEE_TOLERANCE_MIN:                '0.95',
    FEE_TOLERANCE_MAX:                '1.10',
    ORACLE_MAX_PRICE_AGE_SECONDS:     1800,
    // Hourly oracle price-age gate.
    ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS: 4500
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
function frozenConsensusConfig(coin){
    const config = toIndexerConfig(coin, 'regtest');
    return {
        GAS_PRICE: config.GAS_PRICE,
        GAS_SCHEDULE: config.GAS_SCHEDULE,
        VALIDATOR_QUERY_LIMIT: config.VALIDATOR_QUERY_LIMIT,
        ...Object.fromEntries(Object.keys(GOLDEN_FEE_PARAMS_SHARED).map(key => [key, config[key]])),
        ...Object.fromEntries(Object.keys(GOLDEN_FEE_PARAMS_PER_CHAIN[coin]).map(key => [key, config[key]])),
        STAKING: config.STAKING
    };
}

function divergentHubValue(value){
    if(typeof value === 'number') return value + 1;
    if(typeof value === 'string') return value + '-hub';
    if(Array.isArray(value)) return value.map(divergentHubValue);
    if(value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, divergentHubValue(entry)]));
    throw new TypeError('consensus golden has an unsupported value type');
}

describe('consensus parameters are frozen (track 8 guard) @regression', function(){
    it('GAS_SCHEDULE + GAS_PRICE equal the golden on every chain (identical across BTC/LTC/DOGE)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../../src/coins/to_indexer_config.js').toIndexerConfig(coin, 'regtest');
            assert.strictEqual(cfg.GAS_PRICE, GOLDEN_GAS_PRICE, coin + ' GAS_PRICE drifted');
            assert.deepStrictEqual(cfg.GAS_SCHEDULE, GOLDEN_GAS_SCHEDULE, coin + ' GAS_SCHEDULE drifted');
        }
    });

    it('VALIDATOR_QUERY_LIMIT equals the golden on every chain (frozen node-local, not env-tunable)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../../src/coins/to_indexer_config.js').toIndexerConfig(coin, 'regtest');
            assert.strictEqual(cfg.VALIDATOR_QUERY_LIMIT, GOLDEN_VALIDATOR_QUERY_LIMIT, coin + ' VALIDATOR_QUERY_LIMIT drifted');
        }
    });

    it('node-local fee/oracle params equal the golden on every chain (per-chain + shared)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../../src/coins/to_indexer_config.js').toIndexerConfig(coin, 'regtest');
            for(const [k, v] of Object.entries(GOLDEN_FEE_PARAMS_SHARED))
                assert.strictEqual(cfg[k], v, coin + ' ' + k + ' drifted (shared consensus param)');
            for(const [k, v] of Object.entries(GOLDEN_FEE_PARAMS_PER_CHAIN[coin]))
                assert.strictEqual(cfg[k], v, coin + ' ' + k + ' drifted (per-chain consensus param)');
        }
    });

    it('per-chain STAKING activation/cooldown equal the golden (node-local consensus)', function(){
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            const cfg = require('../../../src/coins/to_indexer_config.js').toIndexerConfig(coin, 'regtest');
            const g   = GOLDEN_STAKING_PER_CHAIN[coin];
            assert.ok(cfg.STAKING, coin + ' STAKING missing');
            assert.strictEqual(cfg.STAKING.ACTIVATION_DELAY_BLOCKS, g.ACTIVATION_DELAY_BLOCKS, coin + ' STAKING.ACTIVATION_DELAY_BLOCKS drifted');
            assert.strictEqual(cfg.STAKING.COOLDOWN_BLOCKS, g.COOLDOWN_BLOCKS, coin + ' STAKING.COOLDOWN_BLOCKS drifted');
        }
    });
});

describe('consensus parameters are frozen (track 8 guard) @regression', function(){
    it('hub config overlay does NOT live-poll consensus params (soft-fork guard)', function(){
        // Drive every golden through the lightweight overlay so standalone lanes cannot skip the guard.
        const localConsensus = frozenConsensusConfig('BTC');
        const stub = { config: { COIN: 'BTC', NETWORK: 'regtest', ...localConsensus } };
        const snapshot = JSON.parse(JSON.stringify(stub.config));
        const hubParams = Object.fromEntries(Object.entries(localConsensus)
            .map(([key, value]) => [key, divergentHubValue(value)]));
        hubParams.ACTIVATION_DELAY_BLOCKS = 999;
        hubParams.COOLDOWN_BLOCKS = 1;
        const hubAttempt = { bitcoin: { regtest: { 'xchain-indexer': hubParams } } };

        hubConfigMethods.mergeHubParams.call(stub, hubAttempt);
        for(const key of Object.keys(localConsensus))
            assert.deepStrictEqual(stub.config[key], snapshot[key], key + ' was live-polled');
        assert.strictEqual(stub.config.ACTIVATION_DELAY_BLOCKS, undefined, 'top-level ACTIVATION_DELAY_BLOCKS was live-polled');
        assert.strictEqual(stub.config.COOLDOWN_BLOCKS, undefined, 'top-level COOLDOWN_BLOCKS was live-polled');
        assert.deepStrictEqual(stub.config, snapshot, 'a consensus param was live-polled');
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
});
