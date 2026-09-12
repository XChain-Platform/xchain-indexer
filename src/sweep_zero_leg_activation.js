/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 *
 * SWEEP zero-amount leg flag day: a held balance of exactly 0 writes no
 * debit or credit leg once the sweep settles.
 *
 * THE GAP. getAddressBalances passes a zero balance forward on purpose (an
 * address that was swept before, or whose fee debit reduced a tick to
 * nothing, still holds the row). The SWEEP settle loop wrote a
 * [tick, '0', SOURCE] debit and a [tick, '0', DESTINATION] credit for every
 * such tick, and createLedgerChangeRecord has no zero guard, so the rows
 * landed in credits and debits. Nothing moved, but the explorer showed a
 * credit on the action page and on the address Credits tab, and the ledger
 * carried two rows per tick that describe no transfer.
 *
 * WHY IT CANNOT SIMPLY BE DROPPED. The credits and debits tables are hashed
 * per block into the ledger hash getBlockHashes reports, so a node that skips
 * the rows hashes a block differently from a node that writes them. Testnet
 * history carries at least one such leg (the regression test cites the live
 * sweep it was seen on), so an ungated skip re-grades an anchored block on a
 * from-genesis replay and forks the fleet at that block, which is the exact
 * divergence a flag day exists to prevent. The validation-phase guard loop
 * has skipped zero balances since before this history existed; only the
 * settle write is new, and only the settle write is gated here.
 *
 * THE RULE. Below a chain's height the settle loop writes the zero legs
 * exactly as the deployed fleet does, byte for byte, so every hashed block is
 * reproduced. At and above it a tick whose held amount is not greater than
 * zero writes no leg. The gate moves WHICH rows are written, never how an
 * amount is computed or ordered: the non-zero legs settle identically on both
 * sides of the height.
 *
 * DIRECTION OF SAFETY. An unevaluable gate (inert network, unknown network,
 * unusable height, missing block index) resolves to "write the leg", which is
 * the behaviour the deployed fleet already has. A node that cannot evaluate
 * the gate stays with the majority instead of unilaterally dropping a hashed
 * row.
 *
 * HEIGHT-KEYED per network AND coin, not time-keyed. A SWEEP settles in the
 * processing chain's own block, the ledger hash it lands in is that chain's,
 * and the quantity every node agrees on at settle time is that block's index.
 * The map carries every coin, because a SWEEP is valid on every chain; the
 * resolver is called with the SWEEP's own COIN and BLOCK_INDEX.
 *
 * SIZING (method, so a later re-pin can be re-derived rather than guessed).
 *   regtest 0: genesis-active, so the e2e venue exercises the armed rule from
 *   block 0. Regtest stacks are rebuilt from genesis, so nothing in a regtest
 *   ledger is re-graded.
 *
 *   mainnet null: the INERT sentinel. Mainnet writes are held and the instant
 *   is the operator's, sized on the train that arms it and strictly above the
 *   fleet's deploy tip at that moment. A height already passed is not a flag
 *   day: a node replaying from genesis would drop rows where a long-running
 *   node wrote them, and the two diverge at the first hash comparison.
 *
 *   testnet armed per coin at the SAME heights as STAKE_KEY_REUSE_ACTIVATION,
 *   on purpose: both gates ship on one train, so the fleet rehearses ONE
 *   crossing per coin instead of two. Those heights were sized at the tip
 *   measured 2026-09-11 plus 21 days of that chain's blocks, rounded up to a
 *   clean number, the headroom every height-keyed gate in this directory
 *   uses. Testnet carries a live public ledger with at least one zero leg in
 *   anchored history, so it is armed ahead rather than at genesis: a genesis
 *   arming there would re-grade that block, which is a rewrite, not a flag
 *   day.
 *
 *   Tips re-measured 2026-09-11 at 00:40Z off the platform's own testnet
 *   explorer status endpoint (/TBTC|/TLTC|/TDOGE api/status, field
 *   chain_tip), never a mainnet service, and confirmed still below the shared
 *   heights. Rates are each chain's target block time: BTC 144/day, LTC
 *   576/day, DOGE 1440/day.
 *
 *     BTC  tip    151,994 + 3,024  (21d @144/day)  =    155,018 ->    156,000
 *     LTC  tip  4,883,984 + 12,096 (21d @576/day)  =  4,896,080 ->  4,897,000
 *     DOGE tip 67,888,041 + 30,240 (21d @1440/day) = 67,918,281 -> 67,920,000
 *
 * CANONICAL TWIN. The authority for these values is
 * xchain-documentation/protocol/constants.js, and the activation-constant
 * parity suite holds the two value-identical; a one-sided edit forks the
 * ledger hash at the boundary.
 *
 * NOT VENDORED into xchain-sync. This decides which rows the indexer WRITES
 * during action processing; the sync follower's BlockHasher reads the
 * materialized credits and debits rows and never re-runs SWEEP settlement,
 * so it hashes whatever the origin wrote on either side of the height.
 *
 ********************************************************************/

'use strict';

// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height a SWEEP settle writes no debit/credit leg
// for a held tick whose amount is not above zero; below it the legs are
// written exactly as the deployed fleet writes them.
const SWEEP_ZERO_LEG_ACTIVATION = {
    'BTC:mainnet':  null,         // INERT: operator-owned, sized above the deploy tip on the arming train
    'LTC:mainnet':  null,         // INERT: operator-owned, sized above the deploy tip on the arming train
    'DOGE:mainnet': null,         // INERT: operator-owned, sized above the deploy tip on the arming train
    mainnet:        null,         // INERT: a coin with no entry above inherits the unarmed posture
    'BTC:testnet':  156000,       // SIZED 2026-09-11: chain_tip 151,994 + 3,024 (21d @144/day) = 155,018, rounded up; shared with STAKE_KEY_REUSE_ACTIVATION
    'LTC:testnet':  4897000,      // SIZED 2026-09-11: chain_tip 4,883,984 + 12,096 (21d @576/day) = 4,896,080, rounded up; shared with STAKE_KEY_REUSE_ACTIVATION
    'DOGE:testnet': 67920000,     // SIZED 2026-09-11: chain_tip 67,888,041 + 30,240 (21d @1440/day) = 67,918,281, rounded up; shared with STAKE_KEY_REUSE_ACTIVATION
    testnet:        null,         // INERT: a testnet coin with no entry above keeps writing the legs
    regtest:        0,            // genesis-active so the e2e venue exercises the armed rule
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown network -> undefined -> inert/off.
function _activationThreshold(network, coin){
    if(coin != null && SWEEP_ZERO_LEG_ACTIVATION[coin + ':' + network] !== undefined)
        return SWEEP_ZERO_LEG_ACTIVATION[coin + ':' + network];
    return SWEEP_ZERO_LEG_ACTIVATION[network];
}

// Whether the zero-leg skip binds at `blockIndex` on `network` for `coin`,
// rather than the legacy write of a zero-amount debit and credit.
//
// Fails CLOSED on anything it cannot evaluate (inert network, unknown network,
// unusable height): false means the legacy write runs, which is the row set
// the deployed fleet already hashes, so a node that cannot evaluate the gate
// stays with the majority instead of unilaterally dropping a hashed row.
//
// null is the INERT sentinel and must read as off: without the explicit null
// test `b >= null` coerces to `b >= 0` and arms the skip on every block of an
// unratified chain, the inverse of what the sentinel means. The same coercion
// is why the height itself goes through the empty-ish guard before Number():
// Number(null), Number('') and Number(false) are all a perfectly finite 0,
// which on a genesis-armed network would read as ACTIVE for an action carrying
// no block index at all.
function isSweepZeroLegActive(blockIndex, network, coin){
    let threshold = _activationThreshold(network, coin);
    if(threshold === null || threshold === undefined) return false;
    if(blockIndex === null || blockIndex === undefined || blockIndex === '' || typeof blockIndex === 'boolean')
        return false;
    let b = Number(blockIndex);
    if(!Number.isFinite(b)) return false;
    return b >= threshold;
}

module.exports = {
    SWEEP_ZERO_LEG_ACTIVATION,
    isSweepZeroLegActive
};
