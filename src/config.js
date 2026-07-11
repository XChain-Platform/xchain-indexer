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
 * COIN specific configuration data is loaded from configs/<COIN>.js
 *
 ********************************************************************/

const fs   = require('fs');
const path = require('path');

// Parse a non-negative integer from an env var, falling back to defaultVal when
// the value is absent, empty, or non-numeric. Unlike `parseInt(x) || default`,
// this preserves 0 as a valid configured value.
const parseIntMin0 = (val, defaultVal) => {
    if(val === undefined || val === null || val === '') return defaultVal;
    let parsed = parseInt(val, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultVal;
};

// TICK of the protocol gas token (config['GAS']). This value is consensus: it
// names the token debited for capability STAKE, VOTE deposits/escrows, and
// contract gas billing. Exported so the cross-service drift guard can assert it
// equals the canonical copy (xchain-documentation/protocol/constants.js GAS_TICK)
// and the SDK co-signer's mirror.
const GAS_TICK = 'XCHAIN';

module.exports = {

    GAS_TICK,

    getConfig: function(coinOverride, networkOverride){

        // coinOverride / networkOverride let a caller resolve a config for a coin OTHER
        // than this process's own INDEXER_COIN without mutating the environment. The
        // recovery CLI uses this to build a BTC-scoped config for the cross-check DB so
        // getStakeWeightsByCapability resolves capability stakes from the BTC stakes
        // tables (not the mirrored capability_snapshots short-circuit). Default (no
        // args) reads the environment exactly as before.
        let gas     = GAS_TICK;                     // TICK to be used as gas token
        let coin    = coinOverride    || process.env.INDEXER_COIN;     // BTC / LTC / DOGE
        let network = networkOverride || process.env.INDEXER_NETWORK;  // mainnet / testnet / regtest

        // Define indexer and COIN config objects
        let config     = {};
        let coinConfig = {};

        // Define COIN specific configuration file
        let coinFile   = path.join(__dirname, 'configs', coin + '.js');

        // Load COIN specific configuration file, or throw error
        if(fs.existsSync(coinFile)){
            let cfg    = require(coinFile);
            coinConfig = cfg.getConfig(network);
        } else {
            let error = 'Missing COIN config file : ' + coinFile;
            throw new Error(error);
        }

        // Define list of acceptable COIN networks
        config['COINS'] = ['BTC', 'LTC', 'DOGE'];

        // Define list of acceptable FIAT currencies
        config['FIATS']        = {};
        config['FIATS']['USD'] = 'US Dollar';
        config['FIATS']['CAD'] = 'Canadian Dollar';
        config['FIATS']['AUD'] = 'Australian Dollar';
        config['FIATS']['MXN'] = 'Mexican Peso';
        config['FIATS']['GBP'] = 'Great Britain Pound';
        config['FIATS']['JPY'] = 'Japanese Yen';
        config['FIATS']['CNY'] = 'Chinese Yuan';
        config['FIATS']['CHF'] = 'Swiss Franc';
        config['FIATS']['BRL'] = 'Brazilian Real';
        config['FIATS']['INR'] = 'Indian Rupee';
        config['FIATS']['EUR'] = 'Euro';
        config['FIATS']['KRW'] = 'South Korean Won';

        // Parse in the gas / coin / network information
        config['GAS']     = gas;
        config['COIN']    = coin;
        config['NETWORK'] = network;

        // Chain identifier used to derive smart-contract addresses (C:<CHAIN>:<action_index>,
        // e.g. C:BTC:500) and to tag attestation actions. Equal to the coin symbol; kept as a
        // distinct key because the VM/contract layer references config['CHAIN'] by that name.
        // Without this, contract addresses derive as "C:undefined:<index>", breaking the
        // documented cross-chain uniqueness guarantee (C:BTC:500 vs C:DOGE:500).
        config['CHAIN']   = coin;

        // Native TICK 
        config['NATIVE_TICK']          = coin;
        config['NATIVE_TICK_DECIMALS'] = 8;
        config['COIN_DECIMALS']        = 8;     // Native coin decimal places (BTC/LTC/DOGE all use 8)
        config['COINPAY_EXPIRATION']   = 7200;  // COINPay obligation expiration in seconds (2 hours)

        // TICK Length
        config['MIN_TICK_LENGTH'] = 1;
        config["MAX_TICK_LENGTH"] = 250;

        // TICK characters allowed
        config['TICK_CHARACTERS'] = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~!@#$%^&*()_+-={}[]:<>.?';

        // Reserved TICK names (COIN names and GAS token)
        config['RESERVED_TICKS'] = config['COINS'].concat([gas]);

        // Min/Max DECIMALS
        config['MIN_TOKEN_DECIMALS'] = 0;
        config['MAX_TOKEN_DECIMALS'] = 18;

        // Min/Max SUPPLY (stored as strings to preserve full precision beyond Number.MAX_SAFE_INTEGER)
        config['MIN_TOKEN_SUPPLY'] = '0.000000000000000001';
        config['MAX_TOKEN_SUPPLY'] = '1000000000000000000000';

        // Max DESCRIPTION length
        config['MAX_TOKEN_DESCRIPTION'] = 250;

        // Max MEMO length
        config['MAX_MEMO_LENGTH'] = 250;

        // MAX FILE lengths
        config['MAX_FILE_NAME_LENGTH']  = 250;
        config['MAX_FILE_TYPE_LENGTH']  = 255; // MAX MIME type length according to RFC 4288
        config['MAX_FILE_TITLE_LENGTH'] = 250;

        // BROADCAST lengths
        config['MAX_BROADCAST_MESSAGE_LENGTH']  = 250;
        config['MAX_BROADCAST_VALUE_LENGTH']    = 25; 

        // MAX number of dispenses per dispenser
        config['MAX_DISPENSES'] = 1000;

        // MESSAGE encryption methods
        config['MESSAGE_ENCRYPTION_METHODS'] = [
            1, // Elliptic Curve Integrated Encryption Scheme (ECIES)
            2, // Elliptic-curve Diffie–Hellman (ECDH)
            3, // Advanced Encryption Standard (AES)
        ];

        // SLEEP Immediate methods
        config['SLEEP_IMMEDIATE_METHODS'] = [
            -1, // Sleep actions indefinitely
             0, // Resume actions immediately
        ];

        // Delay dispenser list updates by X seconds (1 hour)
        config['DISPENSER_LIST_DELAY'] = 3600;

        // Delay dispenser closing by X seconds (1 hour)
        config['DISPENSER_CLOSE_DELAY'] = 3600;

        // FIAT dispenser price matching window in seconds (24 hours)
        config['FIAT_DISPENSER_PRICE_WINDOW'] = 86400;

        // Max MESSAGE lengths
        config['MAX_MESSAGE_LENGTH']     = 1048576; // 1 MB = 1,048,576 Characters
        config['MAX_MESSAGE_KEY_LENGTH'] = 1048576; // 1 MB = 1,048,576 Characters

        // Minimum XCHAIN deposit a VOTE v0 poll creator must escrow (anti-spam,
        // refunded on quorum / forfeited to DONATE1 on failed_quorum). '0' = no
        // deposit required (the deposit is optional until a deployment raises this).
        config['POLL_DEPOSIT_MIN'] = '0';

        // Define list of NUMBER fields
        config['NUMBER_FIELDS'] = [
            'ALLOW_LIST', 
            'AMOUNT', 
            'BALANCES',
            'BLOCK_LIST', 
            'BROADCAST_ACTION_INDEX',
            'CALLBACK_AMOUNT', 
            'CALLBACK_BLOCK', 
            'COIN1_ACTION_INDEX',
            'COIN2_ACTION_INDEX',
            // CONTRACT_ACTION_INDEX / TARGET_CONTRACT_INDEX: DEPOSIT/WITHDRAW/EXECUTE and
            // the contract-staking family write their row even when the action is invalid,
            // so a non-numeric wire value ('null', text) must normalize to NULL for storage.
            // Without this the BIGINT insert throws under STRICT_TRANS_TABLES and the
            // block-processing retry loop hard-wedges the indexer (found 2026-07-05 when a
            // broadcast DEPOSIT|0|null|... wedged the LTC-regtest venue).
            'CONTRACT_ACTION_INDEX',
            // CONTRACT_INDEX is the storage-side key createContractExecution /
            // createContractState read; the EXECUTE handler copies the (possibly junk)
            // wire CONTRACT_ACTION_INDEX into it for the row write, so it needs the
            // same numeric-or-NULL normalization.
            'CONTRACT_INDEX',
            'CONTROLLER',
            'COOLDOWN_BLOCKS',
            'DECIMALS',
            'DISPENSER_ACTION_INDEX',
            'EDIT',
            'ENCRYPTION_METHOD',
            'EXPIRATION', 
            'FEE',
            'FEE_AMOUNT',
            'FIAT_AMOUNT',
            'GET_AMOUNT', 
            'GIVE_AMOUNT', 
            'GIVE_ESCROW', 
            'LIST_ACTION_INDEX',
            'MAX_SUPPLY', 
            'MAX_MINT', 
            'MINT_ADDRESS_MAX', 
            'MINT_START_BLOCK', 
            'MINT_STOP_BLOCK',
            'MINT_SUPPLY', 
            'ORDER_ACTION_INDEX',
            'OWNERSHIPS',
            'RESUME_BLOCK',
            'SWAP_ACTION_INDEX',
            'TARGET_CONTRACT_INDEX',
            'TRANSFER_SUPPLY',
            'TYPE',
            'UNBIND',
            'VALUE',
        ];

        // Define list of LOCK fields
        config['LOCK_FIELDS'] = [
            'LOCK_MAX_SUPPLY',
            'LOCK_MINT',
            'LOCK_MINT_SUPPLY',
            'LOCK_MAX_MINT',
            'LOCK_DESCRIPTION',
            'LOCK_SLEEP',
            'LOCK_CALLBACK'
        ];

        // Define list of LIST fields
        config['LIST_FIELDS'] = [
            'ALLOW_LIST',
            'BLOCK_LIST'
        ];

        // Programmable policy layer: the action-classes a token/account may route to a guard
        // contract. Derived by a STATIC map from the action name (never from data['ACTION']) so a
        // future action can't accidentally fall into a controlled class. See Controller_Bound_Tokens.md.
        // ROUTABLE set: an incoming action is mapped to exactly one of these (utility.controllerActionClass).
        config['CONTROLLER_ACTION_CLASSES'] = [
            'transfer',
            'trade',
            'burn',
            'mint',
            'stake'
        ];

        // BINDABLE set: the action-classes a bind (ISSUE v6 / ADDRESS v1) may target. Superset of the
        // routable set with the catch-all 'all' class: 'all' is BINDABLE but never ROUTABLE; routing
        // still maps an action to one of the 5 concrete classes, and resolution falls back to an 'all'
        // binding only when no class-specific controller gates that class (most-specific-wins, single
        // guard, no stacking). 'all' means all classes present AND future; it auto-gates mint/stake the
        // moment those stub handlers wire their guards. See Controller_Bound_Tokens.md.
        config['CONTROLLER_BINDABLE_CLASSES'] = [
            'transfer',
            'trade',
            'burn',
            'mint',
            'stake',
            'all'
        ];

        // Programmable policy layer: hard protocol ceiling (basis points, 10000 = 100%) on the total
        // royalty/fee a controlled-token sale guard may take from the seller's proceeds. The guard's
        // returned payoutLegs sum to <= this at create (else the listing is denied); applyProceedsSplit
        // re-checks conservation at match. A contract's manifest may declare a TIGHTER maxTakeBps
        // (Phase E); this is the absolute cap. 10000 = conservation is the only binding constraint.
        config['CONTROLLER_MAX_TAKE_BPS'] = 10000;

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

        // Genesis ledger bootstrap (Counterparty/Dogeparty name-ownership injection). The
        // consensus-critical GENESIS_BLOCK + GENESIS_LEDGER_HASH are pinned per-network in
        // configs/<COIN>.js; these are the indexer-wide defaults plus the bundled-manifest
        // path. A genesis block carries ~240k synthetic ISSUE/TRANSFER actions (BTC: 121,716
        // names x2 passes), far more than a normal block, so it gets its own watchdog.
        // Even after the genesis-path optimizations (intern cache + read-skip in genesis.js /
        // issue.js), the full BTC CSV derivation measured ~124 min on commodity hardware. That
        // path is now the FALLBACK/generator only - normal full-parse nodes import the precomputed
        // state dump (minutes, see genesisDump.js) - but the watchdog must still cover the CSV
        // fallback on a slower DB, so it is set to 4h. See genesis.js and
        // claude/reports/launch/GENESIS-LEDGER-BOOTSTRAP.md.
        config['GENESIS_BLOCK']            = 0;     // 0 = disabled; pinned per chain in configs/<COIN>.js
        config['GENESIS_LEDGER_HASH']      = null;  // sha256 hex of the bundled CSV; null = skip verify
        config['GENESIS_LEDGER_PATH']      = process.env.GENESIS_LEDGER_PATH || path.join(__dirname, '..', 'data', 'genesis', coin + '-ledger.csv');
        config['GENESIS_BLOCK_TIMEOUT_MS'] = parseIntMin0(process.env.GENESIS_BLOCK_TIMEOUT_MS, 14400000); // 4 hours

        // Precomputed genesis state dump (genesisDump.js). When this artifact is present at
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

        // Merge indexer config and COIN config into a single config object
        let fullConfig = Object.assign({}, config, coinConfig);

        // Native-fee chains (LTC/DOGE) MUST have a FEE_DESTINATION. detectFeePaymentMode
        // falls back to 'xchain' for any action when FEE_DESTINATION is unset/placeholder;
        // on BTC that is the intended fallback, but on LTC/DOGE the correct behavior is
        // native-only (a missing fee output is 'rejected'). A node started without a
        // FEE_DESTINATION would therefore ACCEPT actions a correctly-configured node
        // rejects, a consensus-acceptance divergence. Fail closed at startup rather than
        // ship a divergent indexer (the coin configs carry real defaults, so this only
        // fires on an explicit misconfiguration).
        if(coin === 'LTC' || coin === 'DOGE'){
            let fd = fullConfig['ADDRESS'] ? fullConfig['ADDRESS']['FEE_DESTINATION'] : null;
            if(!fd || fd === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'){
                throw new Error('FEE_DESTINATION is required on ' + coin + ' (native-fee chain). It is the consensus-pinned coin-bundle default (src/coins/' + coin + '.js); the XCHAIN_FEE_DESTINATION_' + coin + '_' + String(network).toUpperCase() + ' env var is honored on regtest ONLY and is ignored on mainnet/testnet. Restore the coin-bundle default (or, on regtest, set that env var). A missing value would make every action fall back to XCHAIN fee mode and diverge from a correctly-configured node.');
            }
        }

        return fullConfig;
    },

}