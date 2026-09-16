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
 * XChain Indexer - State commitment part: leaf values
 *
 * The canonical-amount and value-leaf helpers every balances and stakes leaf
 * passes through (SPV spec §4.2). Part of the block commitment that
 * src/state_commitment/index.js orchestrates; the net each leaf commits is read by
 * db/state_commitment/ledger_reads.js getNetBalance.
 *
 ********************************************************************/

'use strict';

const M = require('../consensus/merkle.js');

const ZERO_CANON = M.canonicalAmount('0');

// The canonical 18 dp string for any amount a ledger read or a stake weight
// returns, so zero tests and leaf hashes compare one spelling.
function canonicalAmountOf(amountStr){ return M.canonicalAmount(String(amountStr)); }

// Returns the value-leaf hex for an amount, or null when it is exactly zero
// (delete-on-zero, normative §4.2).
function leafOrNull(amountStr){
    const canon = canonicalAmountOf(amountStr);
    return (canon === ZERO_CANON) ? null : M.toHex(M.leafHash(canon));
}

module.exports = {
    ZERO_CANON,
    canonicalAmountOf,
    leafOrNull
};
