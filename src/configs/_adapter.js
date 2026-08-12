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
 * XChain Indexer - COIN Config Adapter
 *
 * Maps the canonical coin definition (src/coins/<COIN>.js, the platform-wide
 * source of truth) into the exact shape the indexer's configs/<COIN>.js has
 * always returned, so config.js and every downstream consumer are unchanged.
 * Adding/auditing a coin happens in src/coins, never here.
 *
 ********************************************************************/

const coins = require('../coins');

// Build the indexer COIN config object for a coin/network from canonical data.
// Shape is byte-identical to the legacy configs/<COIN>.js getConfig() output.
function toIndexerConfig(tick, network){
    const c      = coins.getCoinConfig(tick, network);
    const config = {};

    // Legacy fee constants (pre-UNIFIED_FEES).
    config['ISSUANCE_FEE_TOKEN']        = c.legacyFees.ISSUANCE_FEE_TOKEN;
    config['ISSUANCE_FEE_SUBTOKEN']     = c.legacyFees.ISSUANCE_FEE_SUBTOKEN;
    config['EXPIRATION_FEE_DEFAULT_DAYS'] = c.legacyFees.EXPIRATION_FEE_DEFAULT_DAYS;
    config['EXPIRATION_FEE_FREE_DAYS']  = c.legacyFees.EXPIRATION_FEE_FREE_DAYS;
    config['EXPIRATION_FEE_PER_DAY']    = c.legacyFees.EXPIRATION_FEE_PER_DAY;

    // Unified gas fee schedule + tolerances.
    config['GAS_PRICE']                        = c.GAS_PRICE;
    config['UNIFIED_EXPIRATION_FEE_FREE_DAYS'] = c.UNIFIED_EXPIRATION_FEE_FREE_DAYS;
    config['FEE_PAYMENT_MODE']                 = c.FEE_PAYMENT_MODE;
    config['FEE_TOLERANCE_MIN']                = c.FEE_TOLERANCE_MIN;
    config['FEE_TOLERANCE_MAX']                = c.FEE_TOLERANCE_MAX;
    config['ORACLE_MAX_PRICE_AGE_SECONDS']     = c.ORACLE_MAX_PRICE_AGE_SECONDS;
    config['VALIDATOR_QUERY_LIMIT']            = c.VALIDATOR_QUERY_LIMIT;

    config['STAKING']      = c.STAKING;
    config['GAS_SCHEDULE'] = c.GAS_SCHEDULE;

    // ADDRESS roles, sans the explorer-only EXPLORER role (indexer never reads it).
    config['ADDRESS'] = {
        BURN:            c.addresses.BURN,
        GAS:             c.addresses.GAS,
        DONATE1:         c.addresses.DONATE1,
        DONATE2:         c.addresses.DONATE2,
        FEE_DESTINATION: c.addresses.FEE_DESTINATION,
        REWARD:          c.addresses.REWARD,
    };

    // BTC-only consensus blocks (absent on LTC/DOGE, matching the legacy files).
    if(c.CONFIG_SLASH) config['CONFIG_SLASH'] = c.CONFIG_SLASH;
    if(c.FULLNODE)     config['FULLNODE']     = c.FULLNODE;

    // Genesis pins. LTC carries no dump hash, so leave GENESIS_DUMP_HASH unset for
    // it and let config.js supply its indexer-wide default (preserves prior behavior).
    config['GENESIS_BLOCK']       = c.genesis.block;
    config['GENESIS_LEDGER_HASH'] = c.genesis.ledgerHash;
    if('dumpHash' in c.genesis) config['GENESIS_DUMP_HASH'] = c.genesis.dumpHash;

    // XCP/XDP airdrop leg. The armed bucket set is bundle data resolved by
    // coins/index.js, which reads the GENESIS_AIRDROP_* env vars on regtest ONLY, so
    // these values override config.js's env-derived ones for every network. That is the
    // whole point of the registration: before it, a mainnet replay node took its bucket
    // paths, content pins and XCHAIN amounts from whatever the operator exported, so two
    // nodes with byte-identical snapshot CSVs could mint different allocations under
    // different synthetic tx hashes. A coin bundle predating the fields leaves them
    // untouched and config.js's own (now regtest-gated) defaults stand.
    if('airdropPaths' in c.genesis){
        config['GENESIS_AIRDROP_PATHS']          = c.genesis.airdropPaths          || [];
        config['GENESIS_AIRDROP_HASHES']         = c.genesis.airdropHashes         || [];
        config['GENESIS_AIRDROP_AMOUNTS']        = c.genesis.airdropAmounts        || [];
        config['GENESIS_AIRDROP_SNAPSHOT_BLOCK'] = c.genesis.airdropSnapshotBlock  || null;
        config['GENESIS_AIRDROP_SET_HASH']       = c.genesis.airdropSetHash        || null;
    }

    return config;
}

module.exports = { toIndexerConfig };
