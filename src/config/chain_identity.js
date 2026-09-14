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
 * The gas / coin / network identity keys of src/config.js's getConfig(),
 * including the consensus COINPay expiration window.
 ********************************************************************/

'use strict';

const { resolveCoinpayExpiration } = require('./coinpay_expiration.js');

// `readEnv` is src/config.js's call-time environment accessor, handed through
// to the one key here an operator may override (on regtest only).
function applyChainIdentity(config, gas, coin, network, readEnv){
    // Parse in the gas / coin / network information
    config['GAS']     = gas;
    config['COIN']    = coin;
    config['NETWORK'] = network;

    // Chain identifier for deriving smart-contract addresses (C:<CHAIN>:<action_index>,
    // e.g. C:BTC:500) and for tagging attestation actions. Equal to the coin symbol; kept as a
    // distinct key because the VM/contract layer references config['CHAIN'] by that name.
    // Without this, contract addresses derive as "C:undefined:<index>", breaking the
    // documented cross-chain uniqueness guarantee (C:BTC:500 vs C:DOGE:500).
    config['CHAIN']   = coin;

    // Native TICK
    config['NATIVE_TICK']          = coin;
    config['NATIVE_TICK_DECIMALS'] = 8;
    config['COIN_DECIMALS']        = 8;     // Native coin decimal places (BTC/LTC/DOGE all use 8)
    // COINPay obligation expiration in seconds (2 hours). Consensus: added to a
    // match's BLOCK_TIME and stored as the obligation deadline. Regtest-only
    // override, ignored with a warning elsewhere; see resolveCoinpayExpiration.
    config['COINPAY_EXPIRATION']   = resolveCoinpayExpiration(7200, 'XCHAIN_COINPAY_EXPIRATION_S', network, readEnv);
}

module.exports = { applyChainIdentity };
