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
 * Slash-grid flag-day: a slash credits exactly what it debited.
 *
 * THE DEFECT. db.slashContractStake ran its whole deduction at the staked
 * tick's own decimal places, and util.bcsub / util.bcadd round HALF-UP at that
 * scale (measured, see the note above utility.bcmulfloor). The reduction
 * written to the row and the amount handed back to the caller are computed
 * from the same `take` but by two independent roundings, so they can disagree:
 * with a decimals=0 tick, a stake row of '1' and a slash of '0.5',
 * bcsub('1','0.5',0) is '1' - the row is written back UNCHANGED - while
 * bcadd('0','0.5',0) is '1', so actions/execute.js _processSlashEmission
 * releases a full unit of escrow and credits a full unit to the slash
 * destination against a stake that was never debited. The stake stays
 * slashable again and withdrawable. Both passes carry it, active
 * contract_stakes and the contract_unstakes cooldown alike, and nothing
 * upstream defends it: xchain-vm gateway contract.slash validates the amount's
 * SHAPE only (<=8 or <=18 fractional digits), never the token's DECIMALS, and
 * SLASH is the one emission execute.js does not run through
 * _truncateEmissionAmounts.
 *
 * THE RULE. When active, the requested amount is floored to the tick's grid
 * ONCE at entry (floored, never rounded: a punishment may not grow on the way
 * in), a request that floors to zero is a no-op returning '0', and the per-row
 * deduction then runs at SLASH_DEDUCTION_PRECISION so `take` is derived from
 * the reduction ACTUALLY written to the row. The credit, the escrow release,
 * the contract_slash_debits audit amount and the remaining budget are all that
 * same value, so total == sum(prev_amount - written amount) == sum(releases)
 * holds by construction, for any caller and even for a stored row that is
 * itself off-grid.
 *
 * WHY THE DEDUCTION SCALE IS EXACT, NOT THE TICK'S. Deriving the delta at the
 * tick's decimals re-introduces the same defect one step along: with an
 * off-grid stored row ('0.5' on a decimals=0 tick) bcsub(rowAmt, newAmt, dec)
 * rounds the delta back up to '1' and credits a unit the row never held. `dec`
 * quantizes the INCOMING amount and nothing else.
 *
 * WHY A FLAG-DAY. It changes block-processing output (row amounts, ledger
 * rows, slash_events), so a from-genesis replay under the new rule diverges
 * from a chain indexed under the old one. It does NOT ride the VM's
 * BINARY_ALLOC gate (xchain-vm/src/index.js, 1786060800 = 2026-08-07): that
 * flag-day is already in the past, and arming against it would retroactively
 * change blocks the fleet has processed, the exact hazard
 * ledger_amount_precision_activation.js documents.
 *
 * `null` means NOT YET PINNED and therefore inert: the legacy arithmetic runs
 * verbatim and historical replay stays byte-identical.
 *
 * MAINNET IS ARMED AT GENESIS, all three chains (operator ruling 2026-09-09).
 * The measurement this arming waited on, how many historical slashes are
 * off-grid against a coarse-decimals staked tick, was taken read-only against
 * the live indexer databases on 2026-09-09: mainnet holds 0 stakes and 0
 * slashes, so slashContractStake has never run there and the floored-at-entry
 * rule is the identity function over every mainnet block committed so far. The
 * BINARY_ALLOC objection above is about borrowing a passed threshold from
 * another gate, which supplies no such measurement; this height carries its
 * own. The proof is a per-chain OLD-vs-ON replay witness, not this comment.
 *
 * TESTNET STAYS UNPINNED: it has been a live public ledger since 2026-09-01 and
 * carries stake history, so the empty-chain argument does not reach it. regtest
 * runs from genesis, matching stake_weight_collation_activation.js, the nearest
 * gate in this family.
 *
 * Indexer-only with no xchain-sync twin: xchain-sync replicates materialized
 * rows and never runs slashContractStake.
 *
 ********************************************************************/

// Scale the per-row deduction runs at once the rule is live. 18 is
// MAX_TOKEN_DECIMALS (src/config.js), the finest precision any tick can be
// issued with, so a subtraction at this scale is exact for every stored amount
// and the derived delta is the reduction written rather than a re-rounding of it.
const SLASH_DEDUCTION_PRECISION = 18;

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy arithmetic, byte-identical replay).
const SLASH_GRID_ACTIVATION = {
    // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet
    // history (0 stakes, 0 slashes on every chain, measured 2026-09-09).
    'BTC:mainnet':  0,
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
    // Unpinned: testnet carries stake history, so its heights are pinned at
    // flag-day assembly with the replay evidence that step requires.
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    regtest: 0,
};

// Per-chain threshold with a network-wide fallback, byte-for-byte the lookup
// stake_weight_collation_activation.js uses. A coin-less caller (unit fixtures)
// falls through to the bare network key and stays inert on mainnet/testnet,
// which is the safe side.
function _activationThreshold(network, coin){
    if(coin != null && SLASH_GRID_ACTIVATION[coin + ':' + network] !== undefined)
        return SLASH_GRID_ACTIVATION[coin + ':' + network];
    return SLASH_GRID_ACTIVATION[network];
}

// Whether the slash conservation rule binds for a block on `network`/`coin`.
// An unpinned chain, an unknown network, or an unparseable/absent block_index
// -> off, i.e. the legacy tick-scale arithmetic.
function isSlashGridActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined || threshold === null) return false;
    return b >= threshold;
}

module.exports = {
    SLASH_DEDUCTION_PRECISION,
    SLASH_GRID_ACTIVATION,
    isSlashGridActive
};
