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
 * XChain Platform - Canonical Coin Registry
 *
 * Loads the per-coin data files (BTC.js, LTC.js, DOGE.js) and resolves them for
 * a given network. This is the ONE place that reads coin-related env vars, so
 * the pure-data coin files carry no env surface and mainnet/testnet stay frozen.
 *
 * getCoinConfig(tick, network) returns a fully-resolved, deep-cloned config (env
 * overrides applied, internal $-descriptors stripped) for consumers to adapt.
 *
 * consensusHash(tick, network) returns the sha256 of the consensus-critical
 * subset (network byte-prefixes, addresses, fee math, gas schedule, staking),
 * the value the per-service content-pin verifies against. Genesis pins are
 * deliberately excluded here because genesis.js already fail-closes on them.
 *
 * To add a chain: drop a <COIN>.js data file in this directory and add it to
 * COIN_FILES below. Nothing else in this file changes.
 *
 ********************************************************************/

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Registry of canonical coin data files. Order defines ALLOWED_COINS order.
const COIN_FILES = {
    BTC:  require('./BTC.js'),
    LTC:  require('./LTC.js'),
    DOGE: require('./DOGE.js'),
};

const ALLOWED_COINS = Object.keys(COIN_FILES);
const NETWORKS      = ['mainnet', 'testnet', 'regtest'];

// tick -> full lowercase chain name (the hub configs-table coin key) and back.
const COIN_FULL_NAME = {};
const FULL_NAME_TO_TICK = {};
for(const tick of ALLOWED_COINS){
    const full = COIN_FILES[tick].fullName;
    COIN_FULL_NAME[tick] = full;
    FULL_NAME_TO_TICK[full] = tick;
}

// Default cross-chain attestation confirmations per coin (hub DEFAULT_CONFIRMATIONS).
const DEFAULT_CONFIRMATIONS = {};
for(const tick of ALLOWED_COINS)
    DEFAULT_CONFIRMATIONS[tick] = COIN_FILES[tick].confirmations;

// Deep clone of plain data (coin files are pure JSON-compatible objects). Keeps
// the require-cached source modules immutable across getCoinConfig calls.
function clone(obj){
    return JSON.parse(JSON.stringify(obj));
}

// Strip keys whose name starts with '$' (internal env-override descriptors) from
// an object, returning a new object. Non-recursive: descriptors are top-level
// within the block that declares them.
function stripDescriptors(obj){
    const out = {};
    for(const k of Object.keys(obj))
        if(k.charAt(0) !== '$') out[k] = obj[k];
    return out;
}

// Coerce an env string per the descriptor type. Returns undefined when the env
// var is absent/empty so the caller can fall back to a default.
function coerceEnv(raw, type){
    if(raw === undefined || raw === null || raw === '') return undefined;
    if(type === 'int'){
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : undefined;
    }
    if(type === 'csv_lower')
        return String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return String(raw); // 'str'
}

// Resolve a genesis block. mainnet/testnet are literal; a regtest block declared
// via $envOverrides is read from env (regtest only), defaulting per descriptor.
function resolveGenesis(genesisBlock, network){
    if(!genesisBlock) return undefined;
    if(genesisBlock.$envOverrides){
        const out = {};
        for(const [key, desc] of Object.entries(genesisBlock.$envOverrides)){
            const v = (network === 'regtest') ? coerceEnv(process.env[desc.env], desc.type) : undefined;
            out[key] = (v !== undefined) ? v : desc.default;
        }
        return out;
    }
    return stripDescriptors(genesisBlock);
}

// Resolve FULLNODE. mainnet/testnet return the frozen defaults untouched. regtest
// applies, in increasing precedence: a fullnode.regtest.json sidecar in cwd, then
// per-key env vars. Mirrors the prior configs/BTC.js regtest behavior exactly.
function resolveFullnode(fullnode, network){
    if(!fullnode) return undefined;
    const out = stripDescriptors(fullnode);
    // Genesis verifier pubkeys are case-insensitive on the wire; normalize on EVERY
    // network. Previously this ran only AFTER the non-regtest early return below, so
    // mainnet/testnet served the bundled GENESIS_VERIFIERS verbatim, contradicting
    // this comment (#1283). Today every coin bundle ships GENESIS_VERIFIERS: [], so
    // this is a behavioral no-op and hash-neutral (the consensus pin hashes the raw
    // bundle, not this resolved output); moving it restores the documented contract
    // before any mixed-case verifier key can be pinned in a form the runtime (which
    // compares against lowercased on-wire keys) would silently fail to match.
    if(Array.isArray(out.GENESIS_VERIFIERS))
        out.GENESIS_VERIFIERS = out.GENESIS_VERIFIERS.map(s => String(s).toLowerCase());
    if(network !== 'regtest') return out;

    if(fullnode.$regtestSidecar){
        try {
            const p = path.resolve(process.cwd(), fullnode.$regtestSidecar);
            if(fs.existsSync(p)){
                const j = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
                for(const k of Object.keys(j)) out[k] = j[k];
            }
        } catch(e){ console.log('FULLNODE regtest sidecar ignored: ' + e.message); }
    }
    if(fullnode.$regtestEnvOverrides){
        for(const [key, desc] of Object.entries(fullnode.$regtestEnvOverrides)){
            const v = coerceEnv(process.env[desc.env], desc.type);
            if(v !== undefined) out[key] = v;
        }
    }
    return out;
}

// Apply the FEE_DESTINATION env override. Honored on regtest ONLY (single-operator,
// ephemeral; the same gating as the genesis $envOverrides and FULLNODE regtest
// resolution above). On mainnet AND testnet the env var is ignored and the bundled
// default - the consensus-pinned address - is always used: FEE_DESTINATION gates
// native-fee acceptance (detectFeePaymentMode / validateNativeCoinFee), but the
// consensus pin hashes only the static bundle, so an env-resolved override escapes the
// freeze and would let two operators accept/reject the same native-fee action
// differently, forking the block-hashed ledger. Testnet is a multi-operator federation
// with an armed pin (consensus_pin.js), so the identical fork risk applies there; the
// pin must never give false assurance for this field. A set-but-ignored override is
// warned rather than silently dropped so a misconfiguration is visible.
function resolveFeeDestination(tick, network, defaultAddr){
    const key = 'XCHAIN_FEE_DESTINATION_' + tick + '_' + String(network).toUpperCase();
    const override = process.env[key];
    if(!override) return defaultAddr;
    if(network !== 'regtest'){
        if(override !== defaultAddr)
            console.log('WARNING: ' + key + ' is set but IGNORED on ' + network + '; using the bundled ' +
                'consensus-pinned FEE_DESTINATION. To redirect fees, change the pinned coin bundle.');
        return defaultAddr;
    }
    return override;
}

// Resolve a coin for a network: merge coin-level params with the selected network
// block, apply env overrides, strip internal descriptors. Returns a deep clone.
function getCoinConfig(tick, network){
    const coin = COIN_FILES[tick];
    if(!coin) throw new Error('Unknown coin: ' + tick);
    if(!NETWORKS.includes(network)) throw new Error('Unknown network: ' + network);
    const net = coin.networks[network];
    if(!net) throw new Error('Coin ' + tick + ' has no ' + network + ' network');

    const src = clone(coin);
    const netBlock = src.networks[network];

    const addresses = clone(netBlock.addresses);
    addresses.FEE_DESTINATION = resolveFeeDestination(tick, network, addresses.FEE_DESTINATION);

    const resolved = {
        tick:          src.tick,
        fullName:      src.fullName,
        displayName:   src.displayName,
        site:          src.site,
        decimals:      src.decimals,
        confirmations: src.confirmations,
        network:       network,
        net:           clone(netBlock.net),
        firstBlock:    netBlock.firstBlock,
        addresses:     addresses,
        genesis:       resolveGenesis(netBlock.genesis, network),
        legacyFees:                     clone(src.legacyFees),
        GAS_PRICE:                      src.GAS_PRICE,
        UNIFIED_EXPIRATION_FEE_FREE_DAYS: src.UNIFIED_EXPIRATION_FEE_FREE_DAYS,
        FEE_PAYMENT_MODE:               src.FEE_PAYMENT_MODE,
        FEE_TOLERANCE_MIN:              src.FEE_TOLERANCE_MIN,
        FEE_TOLERANCE_MAX:              src.FEE_TOLERANCE_MAX,
        ORACLE_MAX_PRICE_AGE_SECONDS:   src.ORACLE_MAX_PRICE_AGE_SECONDS,
        VALIDATOR_QUERY_LIMIT:          src.VALIDATOR_QUERY_LIMIT,
        GAS_SCHEDULE:                   clone(src.GAS_SCHEDULE),
        STAKING:                        clone(src.STAKING),
    };
    if(src.CONFIG_SLASH) resolved.CONFIG_SLASH = clone(src.CONFIG_SLASH);
    const fn = resolveFullnode(src.FULLNODE, network);
    if(fn) resolved.FULLNODE = fn;

    return resolved;
}

// Convenience: resolve by full chain name ('bitcoin') instead of ticker.
function getCoinConfigByFullName(fullName, network){
    const tick = FULL_NAME_TO_TICK[fullName];
    if(!tick) throw new Error('Unknown coin full name: ' + fullName);
    return getCoinConfig(tick, network);
}

// Deterministic canonical JSON: object keys sorted recursively, no insignificant
// whitespace. Same idea the consensus primitives use so the hash is reproducible.
function canonicalJson(value){
    if(value === null || typeof value !== 'object') return JSON.stringify(value);
    if(Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

// The consensus-critical subset of a coin/network, computed from the STATIC
// bundled data (no env overrides, so every node with the same bundle hashes
// identically regardless of operator env). Genesis is excluded on purpose:
// genesis.js already fail-closes on GENESIS_LEDGER_HASH / GENESIS_DUMP_HASH, so
// folding it in here would double-cover it and break on env-driven regtest.
function consensusSubset(tick, network){
    const coin = COIN_FILES[tick];
    if(!coin) throw new Error('Unknown coin: ' + tick);
    const netBlock = coin.networks[network];
    if(!netBlock) throw new Error('Coin ' + tick + ' has no ' + network + ' network');

    // Addresses minus the display-only roles the coin file declares beside the
    // data (DISPLAY_ONLY_ADDRESS_ROLES; today exactly EXPLORER). Deriving the
    // exclusion from the data means a new display-only role must be classified
    // where it is added instead of silently arming into the hash, and renaming
    // a display role moves the classification with it. The EXPLORER fallback
    // preserves behavior for a coin file that omits the declaration.
    const displayRoles = new Set(coin.DISPLAY_ONLY_ADDRESS_ROLES || ['EXPLORER']);
    const addresses = {};
    for(const k of Object.keys(netBlock.addresses))
        if(!displayRoles.has(k)) addresses[k] = netBlock.addresses[k];

    const subset = {
        net:        netBlock.net,
        addresses:  addresses,
        legacyFees: coin.legacyFees,
        GAS_PRICE:  coin.GAS_PRICE,
        UNIFIED_EXPIRATION_FEE_FREE_DAYS: coin.UNIFIED_EXPIRATION_FEE_FREE_DAYS,
        FEE_TOLERANCE_MIN:            coin.FEE_TOLERANCE_MIN,
        FEE_TOLERANCE_MAX:            coin.FEE_TOLERANCE_MAX,
        ORACLE_MAX_PRICE_AGE_SECONDS: coin.ORACLE_MAX_PRICE_AGE_SECONDS,
        VALIDATOR_QUERY_LIMIT:        coin.VALIDATOR_QUERY_LIMIT,
        GAS_SCHEDULE: coin.GAS_SCHEDULE,
        STAKING:      coin.STAKING,
    };
    if(coin.CONFIG_SLASH) subset.CONFIG_SLASH = coin.CONFIG_SLASH;
    // FULLNODE: frozen defaults only (drop the regtest $-descriptors).
    if(coin.FULLNODE) subset.FULLNODE = stripDescriptors(coin.FULLNODE);
    return subset;
}

// sha256 hex of the canonical JSON of the consensus subset. This is what each
// service's bundled CONSENSUS_CONFIG_PIN is checked against (fail-closed).
function consensusHash(tick, network){
    return crypto.createHash('sha256').update(canonicalJson(consensusSubset(tick, network))).digest('hex');
}

// Map of { coin -> consensusHash } for a network. Served by the hub so consumers
// can compare against their own bundled hashes (transport-integrity check).
function consensusHashes(network){
    const out = {};
    for(const tick of ALLOWED_COINS) out[tick] = consensusHash(tick, network);
    return out;
}

// Fail-closed verification of the bundled coin files against CONSENSUS_CONFIG_PIN
// (consensus_pin.js), generalizing genesis.js _verifyManifest: a null pin for the
// network skips (pre-arm), a mismatch throws (halt; applying divergent consensus
// config would fork the federation). Returns { ok, skipped } on success. Throws
// on the first mismatch with both hashes so the operator sees the drift.
function verifyConsensusPin(network){
    const { CONSENSUS_CONFIG_PIN } = require('./consensus_pin.js');
    const pin = CONSENSUS_CONFIG_PIN ? CONSENSUS_CONFIG_PIN[network] : undefined;
    if(pin === null || pin === undefined) return { ok: true, skipped: true };
    for(const tick of ALLOWED_COINS){
        const expected = pin[tick];
        if(!expected) continue; // a coin with no pin yet (e.g. a freshly added chain) is skipped
        const actual = consensusHash(tick, network);
        if(actual !== String(expected).toLowerCase())
            throw new Error('CONSENSUS CONFIG PIN MISMATCH for ' + tick + '/' + network +
                ' (expected ' + expected + ', got ' + actual + '). Bundled coin file diverges from the pinned consensus config; halting.');
    }
    return { ok: true, skipped: false };
}

module.exports = {
    ALLOWED_COINS,
    NETWORKS,
    COIN_FULL_NAME,
    FULL_NAME_TO_TICK,
    DEFAULT_CONFIRMATIONS,
    getCoinConfig,
    getCoinConfigByFullName,
    consensusSubset,
    consensusHash,
    consensusHashes,
    verifyConsensusPin,
    canonicalJson,
    resolveFullnode,   // #1283: exported for network-normalization conformance testing
};
