/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Shared token-policy recipient checks for local ORDER and SWAP matching.
 *
 ********************************************************************/

'use strict';

// Returns whether a token policy rejects either payout address. Each policy
// applies only to the address receiving that token after activation.
function tokenPolicyRejects(lists, getTokenRecipient, giveTokenRecipient, perTokenPolicy){
    let { getTokenAllowList, getTokenBlockList, giveTokenAllowList, giveTokenBlockList } = lists;

    if(perTokenPolicy){
        return (getTokenAllowList && getTokenAllowList.length  && !getTokenAllowList.includes(getTokenRecipient))  ||
               (getTokenBlockList && getTokenBlockList.length  &&  getTokenBlockList.includes(getTokenRecipient))  ||
               (giveTokenAllowList && giveTokenAllowList.length && !giveTokenAllowList.includes(giveTokenRecipient)) ||
               (giveTokenBlockList && giveTokenBlockList.length &&  giveTokenBlockList.includes(giveTokenRecipient));
    }

    // Apply both token policies to both payout addresses below activation.
    return (getTokenAllowList && getTokenAllowList.length  && (!getTokenAllowList.includes(getTokenRecipient)  || !getTokenAllowList.includes(giveTokenRecipient)))  ||
           (getTokenBlockList && getTokenBlockList.length  && ( getTokenBlockList.includes(getTokenRecipient)  ||  getTokenBlockList.includes(giveTokenRecipient)))  ||
           (giveTokenAllowList && giveTokenAllowList.length && (!giveTokenAllowList.includes(getTokenRecipient) || !giveTokenAllowList.includes(giveTokenRecipient))) ||
           (giveTokenBlockList && giveTokenBlockList.length && ( giveTokenBlockList.includes(getTokenRecipient) ||  giveTokenBlockList.includes(giveTokenRecipient)));
}

module.exports = { tokenPolicyRejects };
