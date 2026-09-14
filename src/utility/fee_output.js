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
 * XChain Indexer - Utility: fee output matcher
 *
 * The one rule both fee checks use to find the transaction output that pays a fee
 * address. A plain helper, not a method: nothing here is installed on Utility.prototype.
 *
 ********************************************************************/

'use strict';

// The first transaction output paying `address`, matched on either field the decoder may set
// (address or scriptPubKey_address), or null when no output pays it or there are no outputs.
// validateNativeCoinFee and validateOracleFee both call this, so the native fee check and the
// oracle fee check can never disagree about which output is the one that pays.
function findFeeOutput(txOutputs, address){
    if(txOutputs && Array.isArray(txOutputs)){
        for(let output of txOutputs){
            if(output.address === address || output.scriptPubKey_address === address)
                return output;
        }
    }
    return null;
}

module.exports = { findFeeOutput };
