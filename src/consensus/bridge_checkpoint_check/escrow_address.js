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
 * XChain Platform - the escrow cross-check: the one door onto the escrow address.
 *
 * Its own file so both the check's binding phase and the settle pass's proof fetch reach the
 * SAME resolver (both go through the entry's export), which is the property the function's own
 * comment is about.
 *
 ********************************************************************/

'use strict';

// Escrow roles come from the coin bundle through this adapter. The call stays guarded
// below because an unknown ticker is a caller error that must resolve to null, not throw.
const coinAdapter = require('../../coins/to_indexer_config.js');
const { ESCROW_ROLE_PREFIX } = require('./reasons.js');
const { str } = require('./fields.js');

/**
 * The escrow address on `originChain` that backs transfers to `destChain`, read through the
 * SAME door the lock handler credits: the origin coin's indexer config ADDRESS block. One
 * door on purpose. If the resolver and the handler read different sources they can disagree,
 * and a cross-check that proves the balance of an address nothing was ever credited to is
 * worse than no cross-check at all.
 *
 * Returns null when the role is absent, which fails the check closed rather than proving
 * some other address.
 *
 * @param {string} originChain - the chain that holds the escrow (the transfer's src_chain)
 * @param {string} destChain   - the chain the units are bridged to
 * @param {string} network     - mainnet / testnet / regtest
 * @returns {string|null}
 */
function resolveEscrowAddress(originChain, destChain, network){
    const chain = str(originChain), dest = str(destChain), net = str(network);
    if(!chain || !dest || !net) return null;
    if(!/^[A-Z]{2,10}$/.test(chain) || !/^[A-Z]{2,10}$/.test(dest)) return null;
    let conf;
    try { conf = coinAdapter.toIndexerConfig(chain, net); }
    catch(e){ return null; }
    const addresses = (conf && (conf.ADDRESS || conf.address)) || {};
    return str(addresses[ESCROW_ROLE_PREFIX + dest]);
}

module.exports = { resolveEscrowAddress };
