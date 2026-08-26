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
 * Token-SEND dispense trigger: numeric amount compare flag-day.
 *
 * THE DEFECT. db.findDispenserSends decides whether a token SEND to a
 * dispenser address is large enough to fire a DISPENSE with the bare SQL
 * predicate `s1.amount >= d1.get_amount`. Both operands are VARCHAR(250)
 * columns (src/sql/sends.sql, src/sql/dispensers.sql) holding minimal decimal
 * text, so MariaDB compares them as STRINGS under the column collation, i.e.
 * lexicographically. The two orderings disagree whenever the operands differ
 * in integer-digit count: get_amount '9' against a send of '10' is FALSE as
 * text ('1' < '9') and TRUE as a number.
 *
 * The false-negative direction loses money. utility.processDispenserSends
 * iterates exactly the rows this query returns and is the only thing that
 * turns a token SEND into a DISPENSE, so a row dropped here means the sender's
 * tokens sit at the dispenser address and nothing is ever dispensed back, on a
 * perfectly legal overpayment. The false-positive direction is harmless: the
 * native-coin gate in findMatchingDispensers re-checks the same question with
 * exact-decimal util.bcgte and discards the action.
 *
 * THE RULE. When active, both operands are CAST to DECIMAL(60,SCALE) before
 * comparing, which is the CAST-before-compare convention ~25 sibling queries
 * in db.js already follow (see ledger_amount_precision_activation.exactSumSql).
 *
 * WHY A FLAG-DAY OF ITS OWN. Changing which sends fire a DISPENSE changes how
 * already-valid blocks evaluate, so it cannot land ungated. It explicitly does
 * NOT ride dispense_cancelling_match_activation: that gate's mainnet threshold
 * (1786060800 = 2026-08-07) is in the PAST, and hanging new behaviour on a
 * passed threshold arms it retroactively over blocks the fleet has already
 * committed - a chain split, not a flag day.
 *
 * `null` means inert: below any threshold, and on every chain with no pinned
 * height, the legacy string compare is emitted BYTE-IDENTICALLY and historical
 * replay is unchanged. Only regtest is armed, so fresh regtest stacks exercise
 * the corrected path end to end; mainnet and testnet heights are pinned at
 * flag-day assembly on the standing 21-day rule, as a separate coordinated
 * release step, with the replay evidence that step requires.
 *
 ********************************************************************/

// Scale the two amount operands are compared at once the rule is live.
//
// FROZEN. This is the emitted SQL of a consensus predicate: once any chain
// arms a height, changing this number changes how blocks above that height
// evaluate on a replay, which is a fork. It is deliberately a local constant
// rather than an import of LEDGER_AMOUNT_PRECISION, so that a future edit to
// that gate's scale cannot silently rewrite this predicate. The two are equal
// today (both 18) and both exist for the same reason: 18 is
// config.MAX_TOKEN_DECIMALS, the finest precision any tick can be issued with,
// so no token amount can be truncated by the cast. Raising MAX_TOKEN_DECIMALS
// above this value would make the comparison lossy; the accompanying unit test
// pins that relationship so the divergence fails CI instead of shipping.
const DISPENSER_SEND_COMPARE_SCALE = 18;

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy lexicographic compare, byte-identical
// replay). Only regtest is armed.
const DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION = {
    // Unpinned. Mainnet and testnet arm at flag-day assembly, above the tip
    // recorded at that time, in one coordinated fleet deploy. A height a
    // carrying fleet has already passed opens a retroactive window: a node that
    // reindexes across it derives different state than one that did not.
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    regtest: 0,
};

// Per-chain threshold with a network-wide fallback, byte-for-byte the lookup
// stateHash.js / ledger_amount_precision_activation.js use. A coin-less caller
// (unit fixtures) falls through to the bare network key and stays inert on
// mainnet/testnet, which is the safe side.
function _activationThreshold(map, network, coin){
    if(coin != null && map[coin + ':' + network] !== undefined) return map[coin + ':' + network];
    return map[network];
}

// Whether the token-SEND dispense trigger compares amounts NUMERICALLY for a
// block on `network`/`coin`. An unpinned chain, an unknown network, or an
// unparseable/absent block_index (out-of-band writes, API-side callers) -> off,
// i.e. the legacy string compare, so no caller that lacks block context can be
// moved onto the new rule by accident.
function isDispenserSendAmountCompareActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION, network, coin);
    if(threshold === undefined || threshold === null) return false;
    return b >= threshold;
}

// The affordability predicate findDispenserSends should emit for a given block.
// The inactive string is byte-identical to the predicate that shipped before
// this gate existed; do not reformat it.
function sendAmountComparePredicate(blockIndex, network, coin){
    if(isDispenserSendAmountCompareActive(blockIndex, network, coin))
        return 'CAST(s1.amount AS DECIMAL(60,' + DISPENSER_SEND_COMPARE_SCALE + ')) >= ' +
               'CAST(d1.get_amount AS DECIMAL(60,' + DISPENSER_SEND_COMPARE_SCALE + '))';
    return 's1.amount >= d1.get_amount';
}

module.exports = {
    DISPENSER_SEND_COMPARE_SCALE,
    DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION,
    isDispenserSendAmountCompareActive,
    sendAmountComparePredicate
};
