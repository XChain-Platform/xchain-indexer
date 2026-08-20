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
 * Exact ledger amounts flag-day.
 *
 * THE DEFECT. db.createLedgerChangeRecord quantized every credit / debit /
 * escrow row to the TICK's own decimal places on the way in
 * (`bcadd(amount, 0, decimals)`). Fees are computed at 8 dp
 * (gas * GAS_PRICE), so wherever the gas tick carries fewer decimals than the
 * fee needs, the ROW was rounded half-up while the `fees` table kept the true
 * figure. Measured on BTC regtest 2026-08-13: XCHAIN there is issued at
 * decimals=0, so ISSUE_SUBTOKEN's 0.5 XCHAIN was RECORDED as 0.5 in `fees` and
 * DEBITED as 1. Every sub-command of a batch re-reads the payer's balance
 * as-of its own action index, so the rounded row is what actually meters the
 * batch: one parent plus 50 children spent 51 XCHAIN instead of the 25.5 the
 * fee schedule charges. The exposure is per-fee and not batch-specific; batch
 * issuance only multiplies it (up to ~249x in one transaction).
 *
 * THE RULE. When active, the ledger stores the amount EXACTLY (quantized at
 * LEDGER_AMOUNT_PRECISION = 18 dp, the platform's maximum token precision and
 * the same scale getAddressBalances / getNetBalance already work in) and
 * rounding happens exactly ONCE, at the supply/balance projection. The three
 * projections (ledger sum, balances+escrows sum, tokens.supply) each sum at
 * 18 dp and round once at the tick's decimals, so they agree by construction:
 * round(C) - round(D) + round(E) is NOT round(C - D + E), and mixing the two
 * shapes is what the old per-row quantization was papering over.
 *
 * WHY A FLAG-DAY OF ITS OWN. This changes fee arithmetic platform-wide, for
 * every action family, not just the batch work that found it. A replay of
 * history under the new rule writes different credits/debits rows, moves
 * balances, and therefore moves balances_root. It does NOT ride
 * BATCH_ISSUANCE_LIMITS: folding it in would widen an already-large consensus
 * change late and entangle its replay evidence with
 * everything else there. Spec: claude/specs/ledger-amount-precision.md.
 *
 * `null` means inert: below any threshold, and on every chain with no pinned
 * height, the legacy per-row quantization runs and historical replay stays
 * byte-identical. Mainnet carries measured heights above the tip; testnet is
 * genesis-active, which is only safe because those chains are rebuilt from
 * chain before launch, so every row is recomputed under this rule and none
 * written under the legacy one survives to disagree.
 *
 * READ-SIDE AGGREGATION IS NOT GATED. The projection changes (sum at 18 dp,
 * round once) are unconditional because they are provably a no-op on rows
 * written under the old rule: every such row is already an exact multiple of
 * 10^-decimals, so a per-row cast to that scale and an outer cast of the sum
 * produce the same value. Gating them would instead split the read path from
 * the write path (API queries carry no block context) and report balances the
 * indexer does not hold.
 *
 ********************************************************************/

// Scale the ledger stores amounts at once the rule is live. 18 is
// MAX_TOKEN_DECIMALS: the finest precision any tick can be issued with, and the
// scale getAddressBalances / stateCommitment.getNetBalance already net in.
const LEDGER_AMOUNT_PRECISION = 18;

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy per-row quantization, byte-identical
// replay). Only regtest is armed, so fresh regtest stacks exercise the exact-fee
// path end to end; mainnet/testnet heights are pinned at flag-day assembly with
// the replay evidence this item requires.
const LEDGER_AMOUNT_PRECISION_ACTIVATION = {
    // Pinned on the standing 21-day rule, to the same boundary the oracle
    // stale-round gate uses, so both consensus changes arm in one fleet deploy
    // and one rehearsal rather than two. Each height sits above the tip
    // recorded beside it, because a height a carrying fleet has not yet passed
    // opens a retroactive window: a node that reindexes across it derives
    // different state than one that did not.
    'BTC:mainnet':  966500,     // tip 963,334 (2026-08-20) + 21d @144/day
    'LTC:mainnet':  3175500,    // tip 3,163,414 + 21d @576/day
    'DOGE:mainnet': 6370000,    // tip 6,340,174 + 21d @1440/day
    // TESTNET ARMED AT GENESIS, operator-ratified 2026-08-18. The pre-launch ruling is
    // that every platform feature must be ACTIVE on testnet, and block 0 is safe here
    // because that chain's indexer state is rebuilt from the chain itself before launch: a
    // rebuild recomputes every row under this rule, so no row written under the legacy one
    // survives to disagree with it. Without the rebuild a genesis height is NOT safe here,
    // which is why a network with history carries a measured height instead.
    'BTC:testnet':  0,
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,
};

// Per-chain threshold with a network-wide fallback, byte-for-byte the lookup
// stateHash.js / caret_ref_strict_activation.js use. A coin-less caller (unit
// fixtures) falls through to the bare network key and stays inert on
// mainnet/testnet, which is the safe side.
function _activationThreshold(map, network, coin){
    if(coin != null && map[coin + ':' + network] !== undefined) return map[coin + ':' + network];
    return map[network];
}

// Whether the ledger stores EXACT amounts for a block on `network`/`coin`.
// An unpinned chain, an unknown network, or an unparseable/absent block_index
// (out-of-band writes, API-side callers) -> off, i.e. legacy quantization.
function isLedgerAmountPrecisionActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(LEDGER_AMOUNT_PRECISION_ACTIVATION, network, coin);
    if(threshold === undefined || threshold === null) return false;
    return b >= threshold;
}

// The scale createLedgerChangeRecord should quantize at for a given block:
// the exact-ledger precision once the rule is live, the tick's own decimals
// before it. Callers pass the tick's decimals so the legacy answer is unchanged.
function ledgerWriteScale(tickDecimals, blockIndex, network, coin){
    if(isLedgerAmountPrecisionActive(blockIndex, network, coin))
        return LEDGER_AMOUNT_PRECISION;
    return tickDecimals;
}

// SQL for "sum this ledger amount column exactly, at 18 dp". The per-row CAST is
// still required (the column is VARCHAR), but it no longer rounds to the tick's
// scale; the caller rounds the total ONCE. On legacy rows this is value-identical
// to the old SUM(CAST(amount AS DECIMAL(60,d))).
function exactSumSql(column){
    return 'SUM(CAST(' + column + ' AS DECIMAL(60,' + LEDGER_AMOUNT_PRECISION + ')))';
}

module.exports = {
    LEDGER_AMOUNT_PRECISION,
    LEDGER_AMOUNT_PRECISION_ACTIVATION,
    isLedgerAmountPrecisionActive,
    ledgerWriteScale,
    exactSumSql
};
