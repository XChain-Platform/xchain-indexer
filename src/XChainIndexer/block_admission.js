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
 * XChain Indexer - Block admission
 *
 * Filtering a block's transactions through an admission predicate. The predicate is taken
 * as an argument and receives the prelaunch input shape. Only an exact true admits a
 * transaction, so the filter fails closed. No database call is made here.
 *
 ********************************************************************/

// The argument shape handed to the admission predicate for one transaction.
function prelaunchInput(tx, { network, coin, blockTime } = {}){
    if(tx === null || typeof tx !== 'object'){
        throw new TypeError('prelaunchInput requires a transaction object');
    }
    return { network, coin, blockTime, data: tx.data, source: tx.source };
}

// Keep, in order and as the same objects, the transactions the predicate admits with true.
function admittedTransactions(blockTransactions, admits, ctx){
    if(!Array.isArray(blockTransactions)){
        throw new TypeError('admittedTransactions requires an array of transactions');
    }
    if(typeof admits !== 'function'){
        throw new TypeError('admittedTransactions requires an admits function');
    }
    return blockTransactions.filter((tx) => admits(prelaunchInput(tx, ctx)) === true);
}

module.exports = { prelaunchInput, admittedTransactions };
