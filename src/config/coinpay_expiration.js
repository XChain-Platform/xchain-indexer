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
 * The COINPay obligation expiration window, one part of src/config.js's
 * getConfig(). The override is read through the `readEnv` accessor the caller
 * passes (src/config.js readEnvNow), so the value is still taken at call time
 * and this module never reads process.env itself.
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability/index.js');

// Resolve the COINPay obligation expiration window. `frozen` is the pinned
// protocol constant; `envKey` an operator override honored ONLY on regtest.
// `readEnv(envKey)` returns that override's raw environment value at call time.
//
// CONSENSUS INPUT. The window is added to a match's BLOCK_TIME and STORED as the
// obligation's deadline, and the per-block expiry pass emits COINPAY_EXPIRE from
// that stored value, so two nodes running different windows release the same
// escrow at different blocks and fork the ledger. Off regtest a differing
// override is therefore IGNORED with a loud startup warning and the frozen value
// wins, the same one-sided gating as resolveWatermarkGrace (src/hub/hub_db_sync.js)
// and resolveFeeDestination (src/coins/index.js). On regtest a SET override that
// is not a positive integer THROWS at startup rather than being stamped as a
// silent NaN deadline, which would compare false against every block time and
// leave every obligation pending forever. Zero is refused for the mirror-image
// reason: it expires an obligation in the block that creates it.
//
// WHY A REGTEST VENUE NEEDS THIS. An e2e suite cannot wait out a two-hour
// deadline, so it freezes the node clock past the deadline and mines. That
// stamps the mined blocks two hours into the future, and any barrier comparing a
// block's own timestamp against a wall-clock watermark then stalls the indexer
// for the whole window in REAL time. The anchor-reward attestation barrier does
// exactly that (`streamWatermark >= blockTime + grace`, src/hub/hub_db_sync.js), and
// on the 2026-09-06 release matrix it held one BTC regtest block for 2h08m50s,
// all 119 deferrals naming that single block. A short regtest window removes the
// need for the clock jump entirely, which is cheaper and safer than teaching
// every block-loop barrier to special-case a future-stamped block.
function resolveCoinpayExpiration(frozen, envKey, network, readEnv){
    const override = readEnv(envKey);
    if(override === undefined || override === '') return frozen;
    if(network !== 'regtest'){
        if(String(override) !== String(frozen))
            getLogger().info('WARNING: ' + envKey + ' is set but IGNORED on ' + String(network) +
                '; using the frozen protocol constant ' + frozen + 's. The COINPay expiration ' +
                'window is a consensus input (a per-node value forks settlement) and is not ' +
                'operator-tunable off regtest.');
        return frozen;
    }
    const raw = String(override).trim();
    const parsed = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if(!Number.isFinite(parsed) || parsed <= 0)
        throw new Error('Invalid ' + envKey + '="' + override + '": the COINPay expiration must be ' +
            'a positive integer number of seconds (frozen protocol default ' + frozen + ').');
    return parsed;
}

module.exports = { resolveCoinpayExpiration };
