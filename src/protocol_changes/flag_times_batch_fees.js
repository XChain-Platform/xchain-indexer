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
 * Flag-day instants for the BATCH issuance and fee re-pricing cohort of the time table.
 *
 * The second half of the flag-day constants: BATCH_ISSUANCE_LIMITS,
 * BATCH_COST_WEIGHTING, EMISSION_ISSUANCE_LIMITS and the two
 * UNIFIED_FEES_SWEEP_CALLBACK instants. Same rule as flag_times.js: each is one
 * network instant of a `protocol_changes.changes.*` row, the entry module exports
 * it, and the comment beside it is the ruling. Moved verbatim from the top of
 * src/protocol_changes.js.
 *
 ********************************************************************/

'use strict';

// Mainnet arm for BATCH_ISSUANCE_LIMITS, the BATCH issuance rework: the dotted-TICK
// exemption that lets one BATCH carry a parent plus any number of child ISSUEs, the global
// 250-command cap that bounds the scan it rides on, the batch-cumulative fee/settlement
// accounting that stops one command's fee from satisfying all N, and the caret-TICK and
// ticker-intern tightenings that ship with them (see the registration below).
//
// ARMED 2026-08-14 (operator), pre-launch, at 1786838400 = 2026-08-16T00:00:00Z.
//
// It was parked on the house UNARMED sentinel (9999999999) while the public-repo release
// was prepared; the operator lifted that on 2026-08-14 on the grounds that the platform is
// pre-launch with no live fleet to coordinate, so the set does not need a ceremonial flag
// day. What it DOES still need is the property this file has always enforced, and the
// instant above satisfies both halves of it:
//
//   - FUTURE, never retroactive. This entry carries BOTH a loosening (the exemption) and
//     several TIGHTENINGS (the cap, the fee ledger), so a backdated boundary forks a
//     from-genesis replay in BOTH directions at once: the replay would reject batches the
//     chain accepted AND accept batches it rejected. That hazard is independent of how
//     busy the chain is, which is why "pre-launch" does not license a past instant.
//   - At or after BATCH_SUBACTION_NORMALIZATION (mainnet 1786060800, 2026-08-07), because
//     classification reads the TICK out of NORMALIZED sub-command params. The assertion in
//     test/unit/batchIssuanceLimitsGate.test.js is what actually holds that ordering.
//
// OPERATIONAL DEPENDENCY, and it is the real one: every mainnet indexer must be running
// this code BEFORE the instant. The mainnet indexers deliberately do not track
// master, so this does not reach them by `xchain-node update` on its own - it is an
// explicit deploy. A node still on the pre-arm code at 2026-08-16T00:00:00Z applies the
// old rules past the boundary and forks from the ones that did.
const BATCH_ISSUANCE_LIMITS_MAINNET_TIME = 1786838400;

// Mainnet arm for BATCH_COST_WEIGHTING, the weighted per-BATCH cost budget that replaces
// the flat 250-command cap registered above (see the batch cost-weighting spec).
//
// ARMED AT GENESIS (0) by the operator's 2026-09-09 ruling (sitting-1 Q3). That ruling
// SUPERSEDES the 2026-08-20 one which reserved a dedicated mainnet flag day for this
// entry: mainnet has never carried a BATCH. Its whole indexed history is 124,160 BTC
// ISSUEs, 43,934 DOGE ISSUEs and 56 DOGE ANCHORs, with zero BATCHes, DEPLOYs, EXECUTEs,
// AIRDROPs and DIVIDENDs (measured read-only on the mainnet replicas 2026-09-09), so
// neither the budget nor the weights can move a verdict a from-genesis replay reaches,
// and the acceptance evidence a flag day would have bought has nothing to measure. The
// OLD-vs-ON replay witness per chain is the proof; a divergence there returns this
// constant to a future instant.
//
// WHAT IT GATES. The flat count check becomes a WEIGHT BUDGET: each sub-command
// contributes a weight and the batch caps their SUM. The budget stays 250 and the default
// weight is 1, so every batch carrying no VM and no fan-out action is admitted or refused
// EXACTLY as it is today, byte for byte - that compatibility is the design's own proof and
// is what acceptance test A1 measures over a real corpus. The rule only bites where the
// flat cap was already wrong: DEPLOY (one consumes the budget), EXECUTE/XEXEC (VM compute,
// capped at nothing today) and AIRDROP/DIVIDEND (one sub-command writes a row PER
// RECIPIENT).
//
// Gated because it moves verdicts in BOTH directions, which is also why the instant may
// never be backdated: batches that were valid become invalid (a second DEPLOY, N EXECUTEs,
// a wide fan-out) and the weight arithmetic changes which sub-commands run at all, both of
// which change the actions/ledger state hashed into the checkpoint preimage. Keyed on
// block TIME like every sibling BATCH gate, for the same reason: BATCH runs on BTC, LTC and
// DOGE, whose heights diverge by millions of blocks, so no single height names one cutover
// across all three but a single timestamp does.
//
// ORDERING AGAINST BATCH_ISSUANCE_LIMITS, and why 0 does not break it. The budget check
// REPLACES that entry's command cap in the same position (first, so it still bounds the
// O(N) scans behind it) and reuses its classification of sub-commands, so a window where
// the budget ran and the cap did not would weigh un-normalized params and leave the batch
// with no bound at all. On mainnet this constant is now BELOW that entry's 1786838400,
// and the invariant survives because batch.js never lets the two run apart: every site
// that reads `weightsActive` sits inside an `if(limitsActive)` (parse's cap block and the
// aggregate gas pre-check), so the weighting gate is a strict refinement of the issuance
// one and its effective mainnet activation is still 2026-08-16T00:00:00Z. That window is
// also entirely in the past and holds zero BATCHes. The numeric ordering still holds on
// testnet and regtest, where both are 0; batchCostWeightingGate.test.js pins the nesting
// by driving a batch inside the window rather than by comparing the two constants.
const BATCH_COST_WEIGHTING_MAINNET_TIME = 0;

// Mainnet arm for EMISSION_ISSUANCE_LIMITS: VM-emitted ISSUEs counted against
// the SAME per-transaction top-level issuance limit the wire path has always carried.
//
// ARMED AT GENESIS (0) by the operator's 2026-09-09 ruling. Mainnet holds zero EXECUTEs
// and zero contracts, so there is no VM emission for the budget to count (124,160 BTC
// ISSUEs, 43,934 DOGE ISSUEs, 56 DOGE ANCHORs, no LTC actions, measured read-only on the
// mainnet replicas 2026-09-09). ONE CAVEAT, and the from-genesis OLD-vs-ON replay witness
// per chain is what settles it rather than this comment: the budget is per TRANSACTION,
// so it would also bite if the genesis import ever put two top-level ISSUEs in a single
// transaction. If the witness finds such a transaction, this constant goes back to a
// future instant beside UNCAPPED_MAX_SUPPLY_ZERO.
//
// WHAT IT GATES. Every ISSUE, whatever emitted it, draws from one per-TRANSACTION budget
// of ONE top-level (undotted) tick; dotted child ticks stay exempt exactly as batch.js
// exempts them, and a caret TICK is never exempt (its dot is a decimal, not a namespace
// separator). Below the flag nothing counts and every historical verdict replays
// byte-identically.
//
// WHY IT EXISTS. execute.js routes a VM emission straight to the ISSUE handler, past the
// per-BATCH limit scan that is the only place top-level issuance was ever counted, and
// ISSUANCE_FEE_EMISSION_EXEMPT (armed) makes those emissions fee-free. One EXECUTE could
// therefore register up to maxEmissions (50) top-level names for nothing, and a BATCH of
// 250 EXECUTEs up to 12,450 - which is the namespace the dotted/undotted rule exists to
// protect. Operator decision 2026-08-15: count them, rather than charge them or widen the
// per-EXECUTE emission cap.
//
// WHY IT IS ITS OWN ENTRY rather than a widening of BATCH_ISSUANCE_LIMITS above: that
// entry is armed on mainnet at 2026-08-16T00:00:00Z, and editing an armed instant is
// never allowed, whatever the new value would be. A separate entry is how a rule that
// lands after an armed one gets its own boundary, and here that boundary is genesis.
//
// Keyed on block TIME like every sibling issuance gate: ISSUE runs on BTC, LTC and DOGE,
// whose heights diverge by millions of blocks, so no single height names one cutover
// across all three but a single timestamp does.
const EMISSION_ISSUANCE_LIMITS_MAINNET_TIME = 0;

// Arms for UNIFIED_FEES_SWEEP_CALLBACK: SWEEP and CALLBACK priced on the unified gas
// schedule instead of the legacy flat per-DB-hit fee.
//
// MAINNET IS ARMED AT GENESIS (0) and TESTNET at 1790812800 (2026-10-01T00:00:00Z).
// Regtest is genesis-active (0) so the suites and every regtest venue exercise the
// unified price from block 0. The two networks differ because their histories do, and
// the constants below carry the reasoning for each.
//
// WHAT IT GATES. Below the flag both actions keep the legacy model exactly: db_hits counted
// as they always were (itself still gated by LEGACY_FEE_NUMERIC_DBHITS above) and priced at
// getTransactionFee's flat 1000 satoshis of XCHAIN per hit. At or above it SWEEP costs
// GAS_SCHEDULE.SWEEP_BASE + items * SWEEP_PER_ITEM (an item is one swept balance, one closed
// order/swap/dispenser escrow, or one transferred ownership) and CALLBACK costs
// CALLBACK_BASE + recipients * CALLBACK_PER_RECIPIENT, both priced at GAS_PRICE. That is the
// same shape DIVIDEND and AIRDROP have taken since UNIFIED_FEES, which is genesis-active
// everywhere; sweep.js and callback.js were the only two handlers never given a unified
// branch.
//
// WHY IT EXISTS. The legacy price is a pure per-DB-hit charge with no floor, so the smallest
// SWEEP or CALLBACK costs almost nothing - and on LTC and DOGE the protocol fee MUST be paid
// as a native-coin output (detectFeePaymentMode returns 'rejected' when it is missing; only
// BTC keeps an XCHAIN-balance lane). "Almost nothing" there is an output below the chain's
// dust threshold, which cannot be created, so the action cannot be submitted AT ALL. Measured
// on Litecoin: a SWEEP quoted 600 litoshi against a 5460-satoshi dust floor, and needed ~273
// DB hits before it became submittable at LTC $100 / XCHAIN $2. This reproduces on mainnet
// Litecoin and is not a regtest artifact. The unified BASE terms put a floor under the fee,
// which is what makes a small SWEEP payable.
//
// WHY IT IS A FLAG DAY AT ALL. fees.AMOUNT is a consensus-visible ledger amount (the fee
// DEBIT, hashed into balances_root and ledger_hash), so flipping the price ungated forks a
// skewed fleet on the first fee-bearing SWEEP or CALLBACK and diverges a from-genesis replay
// from the committed ledger. Same reasoning, and the same block_TIME keying, as
// LEGACY_FEE_NUMERIC_DBHITS below: these actions run on BTC, LTC and DOGE, whose heights
// diverge by millions of blocks, so no single shared height names one cutover across all
// three but a single timestamp does.
//
// MAINNET, genesis (0) by the operator's 2026-09-09 ruling. The re-pricing can only move
// a ledger amount where a SWEEP or CALLBACK was committed, and mainnet has never carried
// either: its whole indexed history is 124,160 BTC ISSUEs, 43,934 DOGE ISSUEs and 56 DOGE
// ANCHORs, with zero SWEEPs and zero CALLBACKs (measured read-only on the mainnet
// replicas 2026-09-09). No fee DEBIT a from-genesis replay recomputes can differ, so
// there is no committed ledger to preserve and no fleet to coordinate. The OLD-vs-ON
// replay witness per chain is the proof.
//
// TESTNET IS DIFFERENT, and this is the one gate in this cohort where 0 was never an
// option. Testnet went PUBLIC on 2026-09-01 with third-party validators, wallets and
// explorers reading it, and it has carried real SWEEP and CALLBACK traffic since, so a
// genesis-active testnet arm would re-price fees already committed there and fork every
// synced testnet node against a fresh reindex. The instant below is 1790812800
// (2026-10-01T00:00:00Z), about three weeks out, which clears the 14-day pre-launch
// notice the upgrade policy requires. It rides the v0.17.0 train, and if that train slips
// the instant is DEFERRED by the release that does carry it: an activation already past
// is not a flag day, because the fleet applies the legacy price beyond it while a
// from-genesis replay applies the new one, and the two diverge at the first comparison.
// Every testnet indexer must be running this code before the instant, and testnet4 tips
// can run about 2h ahead of wall clock, so the deploy needs that margin.
const UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME = 0;
const UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME = 1790812800;

module.exports = {
    BATCH_ISSUANCE_LIMITS_MAINNET_TIME,
    BATCH_COST_WEIGHTING_MAINNET_TIME,
    EMISSION_ISSUANCE_LIMITS_MAINNET_TIME,
    UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME,
    UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME,
};
