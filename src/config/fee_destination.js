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
 * The startup FEE_DESTINATION guard src/config.js's getConfig() runs on the
 * merged (indexer + coin bundle) configuration.
 ********************************************************************/

'use strict';

// Native-fee chains (LTC/DOGE) MUST have a FEE_DESTINATION. detectFeePaymentMode
// falls back to 'xchain' for any action when FEE_DESTINATION is unset/placeholder;
// on BTC that is the intended fallback, but on LTC/DOGE the correct behavior is
// native-only (a missing fee output is 'rejected'). A node started without a
// FEE_DESTINATION would therefore ACCEPT actions a correctly-configured node
// rejects, a consensus-acceptance divergence. Fail closed at startup rather than
// ship a divergent indexer (the coin configs carry real defaults, so this only
// fires on an explicit misconfiguration).
function assertFeeDestination(fullConfig, coin, network){
    if(coin === 'LTC' || coin === 'DOGE'){
        let fd = fullConfig['ADDRESS'] ? fullConfig['ADDRESS']['FEE_DESTINATION'] : null;
        if(!fd || fd === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'){
            throw new Error('FEE_DESTINATION is required on ' + coin + ' (native-fee chain). It is the consensus-pinned coin-bundle default (src/coins/' + coin + '.js); the XCHAIN_FEE_DESTINATION_' + coin + '_' + String(network).toUpperCase() + ' env var is honored on regtest ONLY and is ignored on mainnet/testnet. Restore the coin-bundle default (or, on regtest, set that env var). A missing value would make every action fall back to XCHAIN fee mode and diverge from a correctly-configured node.');
        }
    }
}

module.exports = { assertFeeDestination };
