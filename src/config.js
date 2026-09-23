/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Indexer - Configuration
 * 
 * This config file contains indexer specific configuration data
 * 
 * COIN specific configuration data is loaded from coins/<COIN>.js
 *
 ********************************************************************/

// Load required libraries
const fs   = require('fs');
const path = require('path');

// The coin bundle is pure data; this adapter maps a coin/network pair into the key
// set getCoinConfig() merges over its own defaults.
const coinAdapter = require('./coins/to_indexer_config.js');

// getConfig()'s parts (src/config/). Only keys no reader parses out of this
// file's text live there: the config['NAME'] literals that the docs claims
// tests, the SDK preflight drift gate, the decoder close-delay conformance
// suite and bin/check-controller-class-parity.js read by regex stay below, as
// does every process.env read (CODE-STYLE "Module shape").
const { parseIntMin0 }         = require('./config/env_parse.js');
const { applyCurrencies }      = require('./config/currencies.js');
const { applyChainIdentity }   = require('./config/chain_identity.js');
const { applyWireFields }      = require('./config/wire_fields.js');
const { applyTokenSupplyLimits } = require('./config/token_limits.js');
const { assertFeeDestination } = require('./config/fee_destination.js');
const { applyFileAndBroadcastLimits, applyMessageMethods, applyMessageAndPollLimits } = require('./config/message_limits.js');

// TICK of the protocol gas token (config['GAS']). This value is consensus: it
// names the token debited for capability STAKE, VOTE deposits/escrows, and
// contract gas billing. Vendored single source of truth: ./protocol/constants.js
// (byte-identical to xchain-documentation/protocol/constants.js, GAS_TICK); the
// cross-service drift guard asserts this and the SDK co-signer's mirror equal it.
const GAS_TICK = require('./protocol/constants.js').GAS_TICK;

// Every environment variable this service reads outside this file, captured
// ONCE at module load and frozen. CODE-STYLE "Module shape" says environment
// is read in config.js only, and the shape is fixed: a plain frozen object,
// no getters, because a getter re-reads lazily and a process that changed its
// own env mid-run would then see two different configurations.
//
// Raw values only. A default or a coercion stays at the READ site, where it
// already lives, so this fold cannot move the point at which a default is
// decided.
const CONFIG_ENV = Object.freeze({
    ANCHOR_PROOF_TIMEOUT_MS: process.env.ANCHOR_PROOF_TIMEOUT_MS,
    BRIDGE_PROOF_TIMEOUT_MS: process.env.BRIDGE_PROOF_TIMEOUT_MS,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    DB_ACQUIRE_TIMEOUT: process.env.DB_ACQUIRE_TIMEOUT,
    DB_CONNECT_TIMEOUT: process.env.DB_CONNECT_TIMEOUT,
    DB_QUERY_TIMEOUT: process.env.DB_QUERY_TIMEOUT,
    DECODER_DB_HOST: process.env.DECODER_DB_HOST,
    DECODER_DB_NAME: process.env.DECODER_DB_NAME,
    DECODER_DB_PASS: process.env.DECODER_DB_PASS,
    DECODER_DB_PORT: process.env.DECODER_DB_PORT,
    DECODER_DB_USER: process.env.DECODER_DB_USER,
    DOGE_INDEXER_API_KEY: process.env.DOGE_INDEXER_API_KEY,
    DOGE_INDEXER_API_URL: process.env.DOGE_INDEXER_API_URL,
    DOGE_INDEXER_URL: process.env.DOGE_INDEXER_URL,
    HUB_API_KEY: process.env.HUB_API_KEY,
    HUB_API_URL: process.env.HUB_API_URL,
    HUB_CALL_DEADLINE_MS: process.env.HUB_CALL_DEADLINE_MS,
    HUB_CONFIG_API_KEY: process.env.HUB_CONFIG_API_KEY,
    HUB_CONFIG_URL: process.env.HUB_CONFIG_URL,
    HUB_DB_HOST: process.env.HUB_DB_HOST,
    HUB_DB_NAME: process.env.HUB_DB_NAME,
    HUB_DB_PASS: process.env.HUB_DB_PASS,
    HUB_DB_PORT: process.env.HUB_DB_PORT,
    HUB_DB_SYNC_ENABLED: process.env.HUB_DB_SYNC_ENABLED,
    HUB_DB_USER: process.env.HUB_DB_USER,
    HUB_PRICE_SYNC_TIMEOUT_MS: process.env.HUB_PRICE_SYNC_TIMEOUT_MS,
    HUB_PUSH_FAILED_RETENTION_SECONDS: process.env.HUB_PUSH_FAILED_RETENTION_SECONDS,
    HUB_PUSH_MAX_ATTEMPTS: process.env.HUB_PUSH_MAX_ATTEMPTS,
    HUB_PUSH_PRUNE_INTERVAL_MS: process.env.HUB_PUSH_PRUNE_INTERVAL_MS,
    HUB_PUSH_RETRY_BASE_MS: process.env.HUB_PUSH_RETRY_BASE_MS,
    HUB_PUSH_RETRY_INTERVAL_MS: process.env.HUB_PUSH_RETRY_INTERVAL_MS,
    HUB_PUSH_RETRY_MAX_MS: process.env.HUB_PUSH_RETRY_MAX_MS,
    HUB_REORG_API_KEY: process.env.HUB_REORG_API_KEY,
    INDEXER_ALLOW_LOCAL_PRICE_SOURCE: process.env.INDEXER_ALLOW_LOCAL_PRICE_SOURCE,
    INDEXER_ALLOW_UNAUTHENTICATED: process.env.INDEXER_ALLOW_UNAUTHENTICATED,
    INDEXER_API_KEY: process.env.INDEXER_API_KEY,
    INDEXER_API_PORT: process.env.INDEXER_API_PORT,
    INDEXER_COIN: process.env.INDEXER_COIN,
    INDEXER_DB_HOST: process.env.INDEXER_DB_HOST,
    INDEXER_DB_NAME: process.env.INDEXER_DB_NAME,
    INDEXER_DB_PASS: process.env.INDEXER_DB_PASS,
    INDEXER_DB_PORT: process.env.INDEXER_DB_PORT,
    INDEXER_DB_USER: process.env.INDEXER_DB_USER,
    INDEXER_ENABLE_DRYRUN: process.env.INDEXER_ENABLE_DRYRUN,
    INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS: process.env.INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS,
    INDEXER_FEEQUOTE_MAX_PENDING: process.env.INDEXER_FEEQUOTE_MAX_PENDING,
    INDEXER_FEEQUOTE_TIMEOUT_MS: process.env.INDEXER_FEEQUOTE_TIMEOUT_MS,
    INDEXER_HEALTH_STALL_GRACE_MS: process.env.INDEXER_HEALTH_STALL_GRACE_MS,
    INDEXER_NETWORK: process.env.INDEXER_NETWORK,
    INDEXER_POLL_SILENT_MS: process.env.INDEXER_POLL_SILENT_MS,
    INDEXER_PREFLIGHT_MEMO_MAX: process.env.INDEXER_PREFLIGHT_MEMO_MAX,
    INDEXER_RATE_LIMIT_RPM: process.env.INDEXER_RATE_LIMIT_RPM,
    MIGRATION_STRICT_CHECKSUM: process.env.MIGRATION_STRICT_CHECKSUM,
    SHUTDOWN_TIMEOUT_MS: process.env.SHUTDOWN_TIMEOUT_MS,
    STATE_NODE_RECLAIM: process.env.STATE_NODE_RECLAIM,
    STATE_RETENTION_INTERVAL_MS: process.env.STATE_RETENTION_INTERVAL_MS,
    STATE_ROOT_RETENTION_BLOCKS: process.env.STATE_ROOT_RETENTION_BLOCKS,
    STATE_TREE_METRIC_INTERVAL_MS: process.env.STATE_TREE_METRIC_INTERVAL_MS,
    STATE_TREE_METRIC_MAX_NODES: process.env.STATE_TREE_METRIC_MAX_NODES,
    UTXO_TRACKER_API_PORT: process.env.UTXO_TRACKER_API_PORT,
    UTXO_TRACKER_URL: process.env.UTXO_TRACKER_URL,
    XCALL_DIRECT_PRESENCE_TIMEOUT_MS: process.env.XCALL_DIRECT_PRESENCE_TIMEOUT_MS,
    npm_package_name: process.env.npm_package_name,
    npm_package_version: process.env.npm_package_version,
});

// Return process.env[key] as it is NOW, never a copy taken at load. CONFIG_ENV
// above is frozen at load on purpose; this accessor serves the few reads a
// running process must re-take on every call (the regtest-only COINPay override
// getConfig() resolves per call, a poll interval changed after start). It is the
// one computed process.env read in this file, so its parts under src/config/
// and its callers never touch process.env themselves.
function readEnvNow(key){
    return process.env[key];
}

// Tick, token, memo and BET limits. TICK_CHARACTERS, MIN/MAX_BET_REFUND_WINDOW
// and MAX_BETS_PER_FEED stay literal in this file: xchain-documentation's fee
// and limit claims read them out of its text.
function applyTokenLimits(config, gas){
    // TICK Length
    config['MIN_TICK_LENGTH'] = 1;
    config["MAX_TICK_LENGTH"] = 250;

    // TICK characters allowed
    config['TICK_CHARACTERS'] = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~!@#$%^&*()_+-={}[]:<>.?';

    // Reserved TICK names (COIN names and GAS token)
    config['RESERVED_TICKS'] = config['COINS'].concat([gas]);

    applyTokenSupplyLimits(config);

    // BET parimutuel betting limits. CONSENSUS-CRITICAL: these bound
    // validation, settlement work, and the per-block latch/expiry passes, so
    // every node must agree. MAX_BET_DETAILS_LENGTH is DECODED bytes and is
    // 4096, NOT 8192: DETAILS rides the wire base64-encoded (+33%) and shares
    // the single 8192-byte compiled ACTION ceiling with LABEL/OUTCOMES/TICK/
    // MEMO, so a decoded cap of 8192 composes un-broadcastable feeds. Decoder
    // and encoder suites pin the relationship, so re-raising this fails CI
    // rather than shipping dead feeds.
    config['MAX_BET_LABEL_LENGTH']     = 250;
    config['MAX_BET_OUTCOMES']         = 16;
    config['MAX_BET_OUTCOME_LENGTH']   = 64;
    config['MAX_FEED_FEE']             = '10.00';     // percent of the pot, 2dp
    config['DEFAULT_BET_REFUND_WINDOW']= 1209600;     // 14d (Counterparty parity)
    config['MIN_BET_REFUND_WINDOW']    = 3600;        // 1h
    config['MAX_BET_REFUND_WINDOW']    = 31536000;    // 1y
    config['MAX_BET_DETAILS_LENGTH']   = 4096;        // decoded bytes (see above)
    config['MAX_BET_DETAILS_DEPTH']    = 8;           // JSON nesting cap (bounds renderer/schema recursion)
    config['MAX_BETS_PER_FEED']        = 10000;       // bounds single-block settlement work
    config['MAX_BET_DEADLINE_HORIZON'] = 31536000;    // 1y past BLOCK_TIME (bounds expire_at arithmetic)
    config['MAX_BET_PASS_ROWS']        = 5000;        // latch/expiry feeds per block (both steps)
    config['MAX_BET_PASS_CREDITS']     = 20000;       // expiry refund credits per block; MUST be >= MAX_BETS_PER_FEED
}

// The file, broadcast, dispenser, message and poll limits in their historical
// key order. MAX_REFILLS (the SDK preflight drift gate) and DISPENSER_CLOSE_DELAY
// (the docs settlement claims and the decoder cancel-grace suite) are read out
// of this file's text, so the dispenser keys stay literal here.
function applyDispenserAndMessageLimits(config){
    applyFileAndBroadcastLimits(config);

    // MAX number of dispenses per dispenser fill (enforced at/after the
    // dispenser-caps flag-day, see dispenser_caps_activation.js).
    config['MAX_DISPENSES'] = 1000;

    // MAX number of refills (GIVE_ESCROW top-ups) per dispenser; each refill
    // resets the dispense count to 0. The 6th refill is rejected. Lifetime
    // ceiling: 6 fills x MAX_DISPENSES. Enforced with MAX_DISPENSES.
    config['MAX_REFILLS'] = 5;

    applyMessageMethods(config);

    // Delay dispenser list updates by X seconds (1 hour)
    config['DISPENSER_LIST_DELAY'] = 3600;

    // Delay dispenser closing by X seconds (1 hour)
    config['DISPENSER_CLOSE_DELAY'] = 3600;

    // FIAT dispenser price matching window in seconds (24 hours)
    config['FIAT_DISPENSER_PRICE_WINDOW'] = 86400;

    applyMessageAndPollLimits(config);
}

// The programmable policy layer's class sets and take ceiling. Both class lists
// stay literal in this file: bin/check-controller-class-parity.js (platform
// root) reads them out of its text as the authority every copy is judged by.
function applyControllerPolicy(config){
    // Programmable policy layer: the action-classes a token/account may route to a guard
    // contract. Derived by a STATIC map from the action name (never from data['ACTION']) so a
    // future action can't accidentally fall into a controlled class. See
    // xchain-documentation/protocol/controller-bound-tokens.md.
    // ROUTABLE set: an incoming action is mapped to exactly one of these (utility.controllerActionClass).
    // `ownership` gates the deed-over of a token's ownership record (SWEEP OWNERSHIPS=1 routes here
    // via the synthetic SWEEP_OWNERSHIP action, so an issuer can make ownership non-sweepable to a
    // sanctioned/unapproved DESTINATION); it is distinct from `transfer`, which gates balance moves.
    config['CONTROLLER_ACTION_CLASSES'] = [
        'transfer',
        'trade',
        'burn',
        'mint',
        'stake',
        'ownership'
    ];

    // BINDABLE set: the action-classes a bind (ISSUE v6 / ADDRESS v1) may target. Superset of the
    // routable set with the catch-all 'all' class: 'all' is BINDABLE but never ROUTABLE; routing
    // still maps an action to one of the concrete classes, and resolution falls back to an 'all'
    // binding only when no class-specific controller gates that class (most-specific-wins, single
    // guard, no stacking). 'all' means all classes present AND future, so it already gates mint
    // and stake (both wired) and will gate any class a later release routes. See
    // xchain-documentation/protocol/controller-bound-tokens.md.
    config['CONTROLLER_BINDABLE_CLASSES'] = [
        'transfer',
        'trade',
        'burn',
        'mint',
        'stake',
        'ownership',
        'all'
    ];

    // Programmable policy layer: hard protocol ceiling (basis points, 10000 = 100%) on the total
    // royalty/fee a controlled-token sale guard may take from the seller's proceeds. The guard's
    // returned payoutLegs sum to <= this at create (else the listing is denied); applyProceedsSplit
    // re-checks conservation at match. A contract's manifest may declare a TIGHTER maxTakeBps
    // (Phase E); this is the absolute cap. 10000 = conservation is the only binding constraint.
    config['CONTROLLER_MAX_TAKE_BPS'] = 10000;
}

// Block-loop timing, each an operator env override read at call time.
function applyBlockTiming(config){
    // Define block parsing interval (default 5 seconds; override via BLOCK_CHECK_INTERVAL)
    config['BLOCK_CHECK_INTERVAL'] = parseIntMin0(process.env.BLOCK_CHECK_INTERVAL, 5000);

    // Block processing watchdog timeout (default 5 minutes; override via BLOCK_PROCESS_TIMEOUT)
    config['BLOCK_PROCESS_TIMEOUT'] = parseIntMin0(process.env.BLOCK_PROCESS_TIMEOUT, 300000);

    // Chain-tip push gate. Skip pushChainTip to the hub while the indexer is further
    // than this many blocks behind the decoder tip. During a bulk re-index, pushing a
    // tip for every historical block floods the hub's proxy / rate-limiter (HTTP 429)
    // for no value; the hub only cares about the live tip. Default 100; override via
    // CHAIN_TIP_PUSH_MAX_LAG.
    config['CHAIN_TIP_PUSH_MAX_LAG'] = parseIntMin0(process.env.CHAIN_TIP_PUSH_MAX_LAG, 100);
}

function applyGenesisLedger(config, coin){
    // Genesis ledger bootstrap (Counterparty/Dogeparty name-ownership injection). The
    // consensus-critical GENESIS_BLOCK + GENESIS_LEDGER_HASH are pinned per-network in
    // coins/<COIN>.js; these are the indexer-wide defaults plus the bundled-manifest
    // path. A genesis block carries ~240k synthetic ISSUE/TRANSFER actions (BTC: 121,716
    // names x2 passes), far more than a normal block, so it gets its own watchdog.
    // Even after the genesis-path optimizations (intern cache + read-skip in genesis.js /
    // issue.js), the full BTC CSV derivation measured ~124 min on commodity hardware. That
    // path is now the FALLBACK/generator only - normal full-parse nodes import the precomputed
    // state dump (minutes, see genesis_dump.js) - but the watchdog must still cover the CSV
    // fallback on a slower DB, so it is set to 4h. See genesis.js.
    config['GENESIS_BLOCK']            = 0;     // 0 = disabled; pinned per chain in coins/<COIN>.js
    config['GENESIS_LEDGER_HASH']      = null;  // sha256 hex of the bundled CSV; null = skip verify
    config['GENESIS_LEDGER_PATH']      = process.env.GENESIS_LEDGER_PATH || path.join(__dirname, '..', 'data', 'genesis', coin + '-ledger.csv');
    config['GENESIS_BLOCK_TIMEOUT_MS'] = parseIntMin0(process.env.GENESIS_BLOCK_TIMEOUT_MS, 14400000); // 4 hours
}

function applyGenesisAirdrop(config, network){
    // XCP/XDP native-token airdrop leg. Per-bucket snapshot CSVs (address,quantity as of
    // the snapshot block), sha256 pins, and XCHAIN bucket amounts, aligned by index: entry
    // N of HASHES/AMOUNTS pins/funds entry N of PATHS. Empty PATHS = airdrop disabled (the
    // default; the leg is armed by the launch cut, e.g. PATHS=xcp.csv,xdp.csv AMOUNTS
    // splitting the 30,000,000 CP/DP allocation). An empty HASHES entry skips the
    // pin for that file (pre-pin dev/regtest only); AMOUNTS entries are mandatory and
    // genesis.js fails closed on a missing/invalid one. SNAPSHOT_BLOCK is informational
    // (announce + log); the CSVs are already cut at that height.
    //
    // The env surface is REGTEST-ONLY, matching GENESIS_DUMP_HASH
    // below and the hub coin bundle's genesis.$envOverrides gating. These values are
    // consensus: they decide how much XCHAIN each snapshot holder mints and which
    // synthetic tx hash carries the credit, so on mainnet/testnet they come from the
    // pinned coin bundle (src/coins/<COIN>.js, mapped by coins/to_indexer_config.js, which
    // overrides everything set here) and never from a per-node export. Read at all off
    // regtest, two replay nodes holding byte-identical snapshot CSVs could still derive
    // different allocations and fork at the genesis block.
    let splitCsv = (raw) => String(raw || '').split(',').map(s => s.trim());
    let airdropEnv = (network === 'regtest');
    config['GENESIS_AIRDROP_PATHS']          = airdropEnv ? splitCsv(process.env.GENESIS_AIRDROP_PATHS).filter(s => s !== '') : [];
    config['GENESIS_AIRDROP_HASHES']         = (airdropEnv && process.env.GENESIS_AIRDROP_HASHES)  ? splitCsv(process.env.GENESIS_AIRDROP_HASHES)  : [];
    config['GENESIS_AIRDROP_AMOUNTS']        = (airdropEnv && process.env.GENESIS_AIRDROP_AMOUNTS) ? splitCsv(process.env.GENESIS_AIRDROP_AMOUNTS) : [];
    config['GENESIS_AIRDROP_SNAPSHOT_BLOCK'] = airdropEnv ? (process.env.GENESIS_AIRDROP_SNAPSHOT_BLOCK || null) : null;
    // Combined set-hash pin over the canonical `name:hash:amount` bucket lines. The
    // per-bucket GENESIS_AIRDROP_HASHES pin each FILE's content; this one pins the SET:
    // which buckets exist, what each is funded with, and (through the canonical order)
    // the sequence their synthetic actions are derived in. genesis.js verifies it before
    // crediting anything and requires it on mainnet.
    config['GENESIS_AIRDROP_SET_HASH']       = airdropEnv ? (process.env.GENESIS_AIRDROP_SET_HASH || null) : null;
}

function applyGenesisDump(config, coin, network){
    // Precomputed genesis state dump (genesis_dump.js). When this artifact is present at
    // GENESIS_DUMP_PATH, inject() bulk-imports it (minutes) instead of re-deriving the
    // ~240k-action genesis ledger through the pipeline (~1h); the importer verifies the
    // file against GENESIS_DUMP_HASH (sha256 of the UNCOMPRESSED content) and re-checks the
    // recomputed genesis block hashes, so trust matches the CSV path's GENESIS_LEDGER_HASH.
    // Absent or unpinned -> the canonical CSV derivation runs (and is the generator + fallback).
    // The path is network-specific (<coin>-<network>-genesis-dump...) so a mainnet dump is never
    // mis-applied on testnet/regtest (the importer would reject the block mismatch); only networks
    // with a bundled dump take the fast path, the rest fall back to CSV.
    config['GENESIS_DUMP_PATH']        = process.env.GENESIS_DUMP_PATH || path.join(__dirname, '..', 'data', 'genesis', coin + '-' + network + '-genesis-dump.ndjson.gz');
    // The env override is regtest-only (matching the hub's coins/index.js
    // $envOverrides gating): on mainnet/testnet the dump hash comes from the
    // pinned per-coin config, never from a per-node env var.
    config['GENESIS_DUMP_HASH']        = (network === 'regtest') ? (process.env.XCHAIN_GENESIS_DUMP_HASH || null) : null;
    // Watchdog for the genesis block when it takes the DUMP IMPORT path (measured ~15s for
    // BTC); kept tight (10 min default) so a wedged import is caught fast. The CSV-derivation
    // fallback uses the generous GENESIS_BLOCK_TIMEOUT_MS instead. XChainIndexer picks between
    // them by whether GENESIS_DUMP_PATH exists at the genesis block.
    config['GENESIS_DUMP_TIMEOUT_MS']  = parseIntMin0(process.env.GENESIS_DUMP_TIMEOUT_MS, 600000); // 10 min
}

module.exports = {
    CONFIG_ENV,

    GAS_TICK,

    readEnvNow,

    // Handle returning the current indexer configuration
    getConfig: function(coinOverride, networkOverride){

        // coinOverride / networkOverride let a caller resolve a config for a coin OTHER
        // than this process's own INDEXER_COIN without mutating the environment. The
        // recovery CLI uses this to build a BTC-scoped config for the cross-check DB so
        // getStakeWeightsByCapability resolves capability stakes from the BTC stakes
        // tables (not the mirrored capability_snapshots short-circuit). Default (no
        // args) reads the environment exactly as before.

        // Set coin and network from environmental variables
        let gas     = GAS_TICK;                     // TICK to be used as gas token
        let coin    = coinOverride    || process.env.INDEXER_COIN;     // BTC / LTC / DOGE
        let network = networkOverride || process.env.INDEXER_NETWORK;  // mainnet / testnet / regtest

        // Define indexer and COIN config objects
        let config     = {};
        let coinConfig = {};

        // Define COIN specific configuration file
        let coinFile   = path.join(__dirname, 'coins', coin + '.js');

        // Load COIN specific configuration file, or throw error.
        if(fs.existsSync(coinFile)){
            coinConfig = coinAdapter.toIndexerConfig(coin, network);
        } else {
            let error = 'Missing COIN config file : ' + coinFile;
            throw new Error(error);
        }

        // Each builder adds its keys in the order this function has always
        // produced them, so the merged config is identical key for key.
        applyCurrencies(config);
        applyChainIdentity(config, gas, coin, network, readEnvNow);
        applyTokenLimits(config, gas);
        applyDispenserAndMessageLimits(config);
        applyWireFields(config);
        applyControllerPolicy(config);
        applyBlockTiming(config);
        applyGenesisLedger(config, coin);
        applyGenesisAirdrop(config, network);
        applyGenesisDump(config, coin, network);

        // Merge indexer config and COIN config into a single config object
        let fullConfig = Object.assign({}, config, coinConfig);

        // Native-fee chains (LTC/DOGE) must carry a FEE_DESTINATION; the reason
        // and the fail-closed check live in src/config/fee_destination.js.
        assertFeeDestination(fullConfig, coin, network);

        return fullConfig;
    },

}