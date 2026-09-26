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
 * Time table part 4 of 4: BATCH_ISSUANCE_LIMITS through CONTRACT_META_REQUIRED.
 *
 * One row per protocol change, in registration order, as the argument list of
 * ProtocolChanges.addChange(name, version, mainnet_time, testnet_time,
 * regtest_time, mainnet_block, testnet_block, regtest_block). The rows and the
 * comments beside them moved here verbatim from parseChanges() in
 * src/protocol_changes.js; only the call wrapper became an array literal.
 * core.applyChanges() feeds every part to the class and to the registry in
 * the order the entry module lists them. Data only: nothing here reads the
 * indexer, and the one environment read is a build-time thunk.
 *
 ********************************************************************/

'use strict';

const {
    UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME,
    CROSS_SETTLE_CAP_MAINNET_TIME,
    BATCH_ROOT_SUB_INDEX_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME,
    DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME,
    DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME,
    CONTRACT_META_REQUIRED_MAINNET_TIME,
    CONTRACT_META_REQUIRED_TESTNET_TIME,
} = require('./flag_times.js');
const {
    BATCH_ISSUANCE_LIMITS_MAINNET_TIME,
    BATCH_COST_WEIGHTING_MAINNET_TIME,
    EMISSION_ISSUANCE_LIMITS_MAINNET_TIME,
    UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME,
    UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME,
} = require('./flag_times_batch_fees.js');

module.exports = [
    // BATCH issuance limits v2. One entry gating the whole rework so a fleet can never
    // run half of it:
    //   - the per-action ISSUE limit stops counting DOTTED (child) ticks, so one BATCH
    //     may register a parent and any number of its children. A caret TICK ('^<id>')
    //     is NEVER exempt: its dot is an id/precision separator, not a namespace one.
    //   - a global 250-command cap per BATCH, checked FIRST so it bounds the scan loops
    //     the exemption runs inside and so its error wins over the per-action limit for
    //     a batch that breaks both. Without it the envelope lane admits ~35,000
    //     sub-commands, each buying its own ACTION_INDEX, mappings and invalid row.
    //   - fee and settlement value accounted CUMULATIVELY across the batch. TX_OUTPUTS
    //     is transaction-level state the batch loop preserves, and every per-command
    //     check read it untouched, so N fee-bearing sub-commands were satisfied by ONE
    //     command's worth of native fee (and N COINPAYs settled from one payment).
    //   - an ISSUE whose TICK is a caret form containing '.' is rejected rather than
    //     landing a valid issuance under a NULL ticker id, and an invalid ISSUE no
    //     longer interns its name into index_tickers for free.
    //
    // Gated because all four move consensus verdicts: a batch that was invalid becomes
    // valid (the exemption) and batches that were valid become invalid (the cap, the fee
    // ledger), and both directions change the actions/ledger state hashed into the
    // checkpoint preimage. Keyed on block TIME like the sibling BATCH gates: BATCH runs
    // on BTC, LTC and DOGE, whose heights diverge by millions of blocks, so no single
    // height names one cutover across all three but a single timestamp does.
    //
    // This entry MUST activate at or after BATCH_SUBACTION_NORMALIZATION above:
    // classification reads the TICK out of NORMALIZED sub-command params, and below the
    // normalization flag a legacy-format sub-action's params are not yet shifted, so
    // params[1] is not the TICK. Nothing in isEnabled() enforces the ordering, so
    // test/unit/batchIssuanceLimitsGate.test.js asserts it per network.
    //
    // MAINNET IS ARMED at 2026-08-16T00:00:00Z (see BATCH_ISSUANCE_LIMITS_MAINNET_TIME
    // above for the instant and the deploy dependency it carries);
    // testnet/regtest activate at genesis (all zeros).
    ['BATCH_ISSUANCE_LIMITS', '0.2.0',BATCH_ISSUANCE_LIMITS_MAINNET_TIME,0,0,0,0,0],

    // Weighted per-BATCH cost budget (BATCH_COST_WEIGHTING). Replaces the flat
    // 250-command cap registered immediately above with a budget over per-action
    // COST WEIGHTS, so the rule bounds worst-case indexer work directly instead of
    // by proxy. Budget 250, default weight 1: a batch with no VM and no fan-out
    // sub-command is decided exactly as it is today.
    //
    // EVERY NETWORK ACTIVATES AT GENESIS (all zeros). Mainnet was armed there on
    // 2026-09-09, superseding the 2026-08-20 ruling that reserved it a dedicated flag
    // day: mainnet has never carried a BATCH, so neither the budget nor the weights
    // can move a verdict. BATCH_COST_WEIGHTING_MAINNET_TIME above carries the
    // measurement and the ordering note (this entry now registers BELOW
    // BATCH_ISSUANCE_LIMITS on mainnet, and batch.js is what keeps the two together).
    ['BATCH_COST_WEIGHTING', '0.2.0',BATCH_COST_WEIGHTING_MAINNET_TIME,0,0,0,0,0],

    // Per-TRANSACTION top-level issuance budget that VM emissions draw from too
    // (EMISSION_ISSUANCE_LIMITS). One transaction may register ONE top-level
    // (undotted) tick, counting wire sub-commands and VM-emitted ISSUEs alike; dotted
    // child ticks are exempt exactly as the BATCH classifier exempts them, and a caret
    // TICK is never exempt. The wire path is already capped at one per BATCH by
    // actionLimits['ISSUE'], so this entry moves no wire verdict: it closes the emission
    // path, which routes past that scan and is fee-exempt under
    // ISSUANCE_FEE_EMISSION_EXEMPT.
    //
    // EVERY NETWORK ACTIVATES AT GENESIS (all zeros). Mainnet was armed there on
    // 2026-09-09 on the measurement that it holds zero EXECUTEs and zero contracts, so
    // there is no VM emission for the budget to count. The one caveat, which the
    // from-genesis replay witness settles, is a genesis-import transaction carrying two
    // top-level ISSUEs; EMISSION_ISSUANCE_LIMITS_MAINNET_TIME above carries it.
    ['EMISSION_ISSUANCE_LIMITS', '0.2.0',EMISSION_ISSUANCE_LIMITS_MAINNET_TIME,0,0,0,0,0],

    // Numeric legacy-fee db_hits accumulation. The legacy
    // (non-UNIFIED_FEES) transaction-fee model in dividend.js / callback.js / sweep.js
    // accumulates a db_hits count and prices it via getTransactionFee. The original
    // accumulators used `db_hits += this.util.bcmul(count, N, 0)`; bcmul returns a
    // mathjs BigNumber whose valueOf() is a string, so the `+=` STRING-CONCATENATED the
    // running integer instead of adding it (e.g. 4 + bcmul(2,3,0) -> 4 + "6" -> "46",
    // and even a zero-escrow SWEEP concatenated "0" -> "10" -> "100"), inflating the
    // priced fee by orders of magnitude (getTransactionFee("100") = 0.001 vs the correct
    // 0.00001). Below this activation the code reproduces that string concatenation
    // byte-for-byte, so a from-genesis replay and a heterogeneous fleet commit the
    // IDENTICAL (inflated) fee that live pre-activation nodes committed. At/above it the
    // count accumulates numerically and getTransactionFee prices the true db_hits.
    // Gated as its own consensus rule because the fix CHANGES a consensus-visible ledger
    // amount (fees.AMOUNT / the fee DEBIT, hashed into balances_root + ledger_hash): an
    // ungated flip (the earlier un-gated numeric fix) forks a skewed fleet on the first
    // fee-bearing DIVIDEND-legacy/CALLBACK/SWEEP and diverges a from-genesis replay from
    // the committed ledger. Keyed on block_TIME (not block_index), mirroring the other
    // multi-chain gates: these actions run on BTC, LTC and DOGE whose heights diverge by
    // millions of blocks, so no single shared block height names one cutover across all
    // three chains, but a single timestamp does. The mainnet timestamp joins the
    // ratified coordinated contract-era anchor 1786060800 (2026-08-07 00:00:00 UTC);
    // testnet/regtest activate at genesis (all zeros) so the numeric model holds from
    // block 0 there and in the unit/e2e suites (the regtest stack is rebuilt fresh, so
    // no pre-activation fee-bearing blocks remain to replay).
    ['LEGACY_FEE_NUMERIC_DBHITS', '0.2.0',1786060800,0,0,0,0,0],

    // SWEEP and CALLBACK priced on the unified gas schedule (a BASE cost plus a
    // per-item cost) instead of the legacy flat per-DB-hit fee, so a small one clears
    // the dust threshold on the chains where the protocol fee must be a native-coin
    // output. MAINNET AND REGTEST ACTIVATE AT GENESIS (0); TESTNET is armed at a future
    // instant instead, because it is the only network of the three that has committed
    // SWEEP and CALLBACK fees a genesis arm would re-price. The measurement behind the
    // mainnet arm, and the testnet instant's notice and deferral rule, are at
    // UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME above.
    ['UNIFIED_FEES_SWEEP_CALLBACK', '0.2.0',
        UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME, UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME, 0, 0, 0, 0],

    // Partial claim + partial unstake. UNSTAKE v0/v1 and COLLECT v0 gain a
    // trailing OPTIONAL AMOUNT field (no new action versions):
    //   UNSTAKE v0: VERSION|SIGNING_PUBKEY[|AMOUNT]
    //   UNSTAKE v1: VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK[|AMOUNT]
    //   COLLECT v0: VERSION[|AMOUNT]
    // AMOUNT absent = the historical full sweep, byte-identical, so every action
    // already on-chain decodes and applies unchanged. AMOUNT present at/after this
    // flag-day = partial: UNSTAKE moves only that much into cooldown and the residual
    // stays staked (a synthetic re-stake row keyed by the UNSTAKE's own action_index,
    // activating exactly when the swept rows deactivate, so stake weight is continuous
    // with no double-count window); COLLECT claims only that much and the remainder
    // stays pending. An AMOUNT equal to the full balance is treated exactly as absent
    // (identical resulting state). Over-ask and malformed amounts REJECT (operator
    // decision 2026-07-23; matches house validator strictness, never clamps). BELOW
    // the flag-day a present AMOUNT is IGNORED (full sweep): every legacy layer
    // (decoder pass-through, actions.js blind split, the handlers' positional reads)
    // already drops extra trailing fields, so ignoring is the only pre-activation rule
    // an un-upgraded indexer can agree with; rejecting early would itself fork the
    // fleet on the first early-broadcast partial. Gated because honoring the field
    // changes consensus-visible state (unstakes/stakes/reward_claims rows, balances,
    // stake weights, all hashed): an ungated flip forks a heterogeneous fleet on the
    // first partial action. Keyed on block_TIME for the reasons stated at
    // DEPLOY_BASE64_CODE above. The mainnet timestamp joins the ratified coordinated
    // contract-era anchor 1786060800 (2026-08-07 00:00:00 UTC); a divergent value is a
    // fork. testnet/regtest activate at genesis (no partial-era history to preserve;
    // the e2e/regtest stack exercises partials from block 0).
    ['PARTIAL_UNSTAKE_COLLECT', '0.2.0',1786060800,0,0,0,0,0],

    // Retirement of XCALL result rows the source chain can never deliver.
    // A mirrored, finalized result row that matches no local XCALL v0 request (or
    // whose request routes to a different target chain, or whose signatures do not
    // meet the cross_chain quorum) is rejected by processResult on every block and
    // pruned by nothing, because pruning is keyed on a recorded callback and those
    // paths record none. The delivery pass is capped at XCALL_MAX_CALLS_PER_BLOCK,
    // so as few as 25 such rows at a low snapshot_block occupy the whole per-block
    // slice permanently and starve every real result behind them (measured on a
    // drill venue: 229 rows, head slice 25/25 unmatched, re-fetched every
    // block forever). At/above this activation such a row is retired once it can no
    // longer become deliverable: past the request's deadline_block where a request
    // exists, or XCALL_RESULT_ORPHAN_GRACE_SECONDS of block time past the row's
    // quorum-signed effective_time where none does. Retirement records a
    // 'skipped:<reason>' cross_chain_call_callbacks row against a freshly minted
    // action_index, exactly like the existing already-terminal skip branch.
    //
    // Gated because retirement is CONSENSUS-VISIBLE in two ways: it mints an actions
    // row (hashed), and freeing a capped delivery slot moves which block a real
    // result's callback EXECUTE lands in (contract hash, action indices). An ungated
    // flip would fork a heterogeneous fleet on the first orphaned result row. Keyed
    // on block_TIME for the reasons stated at DEPLOY_BASE64_CODE above. The mainnet
    // timestamp joins the ratified coordinated contract-era anchor 1786060800
    // (2026-08-07 00:00:00 UTC); testnet/regtest activate at genesis (no
    // orphaned-result history worth preserving there, and the drill venue needs the
    // rule from block 0).
    ['XCALL_RESULT_ORPHAN_RETIREMENT', '0.2.0',1786060800,0,0,0,0,0],

    // MAX_SUPPLY=0 is the UNCAPPED sentinel, so the supply ceiling is not
    // applied at all on a token that declares no cap. MAX_SUPPLY is stored as 0 when
    // the ISSUE omits it (createToken / db.js) and the protocol documents such a token
    // as unlimited, but mint.js applied `SUPPLY + AMOUNT > MAX_SUPPLY` with no
    // bcgt(MAX_SUPPLY,0) pre-condition, unlike all four sibling optional-cap checks in
    // the same function (MAX_MINT, MINT_ADDRESS_MAX, MINT_START_BLOCK,
    // MINT_STOP_BLOCK). Against a stored 0 that comparison is true for EVERY positive
    // AMOUNT, so every mint on an uncapped token was rejected and the token was
    // permanently unmintable. The same missing exemption sits on three ISSUE
    // cross-checks that compare another field against MAX_SUPPLY (MINT_SUPPLY single-
    // shot, MINT_SUPPLY cumulative, MINT_ADDRESS_MAX), which reject an uncapped token's
    // own genesis parameters for exceeding a cap that does not exist. At/above this
    // activation all four sites skip the comparison when no positive cap is declared.
    //
    // LOCK_MAX_SUPPLY is deliberately untouched: locking an uncapped token is still
    // refused by the unchanged 'invalid: LOCK_MAX_SUPPLY (no max supply)' guard, since
    // there is no cap to freeze.
    //
    // Gated as its own consensus rule because the change is a validity LOOSENING: a
    // MINT (or ISSUE) that every legacy node rejects becomes valid on an upgraded node,
    // so an ungated flip forks a heterogeneous fleet on the first mint of an uncapped
    // token and breaks from-genesis replay byte-identity. Keyed on block_TIME for the
    // reasons stated at DEPLOY_BASE64_CODE above.
    //
    // MAINNET IS UNARMED (see UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME above), and it is
    // the ONE gate the 2026-09-09 genesis-arm ruling deliberately held back: about
    // 168,000 mainnet ISSUEs carry MAX_SUPPLY=0, so unlike its siblings this rule has
    // real history to reinterpret and its instant is T, the mainnet launch instant,
    // which only the operator names. testnet/regtest activate at genesis (all zeros) so
    // the exemption is in force from block 0 there and in the unit/e2e suites.
    ['UNCAPPED_MAX_SUPPLY_ZERO', '0.2.0',UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME,0,0,0,0,0],

    // Per-block cap on the CROSS_SETTLE pass
    // (CROSS_SETTLE_MAX_PER_BLOCK in protocol/constants.js). With the
    // gate ON, processCrossChainSettlements settles at most the cap of finalized,
    // effective, unsettled matches per block and carries the remainder forward in
    // (snapshot_block, match_id) order; with it OFF the pass drains the whole
    // backlog in one block transaction, which is the legacy behavior.
    //
    // Kept as its own consensus rule because the cap is CONSENSUS-VISIBLE where it
    // bites: deferring a settlement moves the block it lands in, and with it the
    // actions rows, the contract hash and the checkpoint preimage. The 2026-08-11
    // ruling reserved a flag day for it on the belief that mainnet carried settled
    // cross-chain history, since the fresh-genesis restart of 816d1e1 covered the
    // three TESTNET chains only.
    //
    // Keyed on block_TIME like the other multi-chain gates: CROSS_SETTLE runs on
    // BTC, LTC and DOGE, whose heights diverge by millions of blocks, so no single
    // height names one cutover across all three but a single timestamp does.
    //
    // EVERY NETWORK NOW ACTIVATES AT GENESIS (all zeros). The 2026-09-09 measurement
    // showed mainnet holds no cross-chain matches at all, so the belief above was
    // wrong and there is nothing for the cap to reinterpret;
    // CROSS_SETTLE_CAP_MAINNET_TIME above carries the count and names the replay
    // witness that proves it.
    ['CROSS_SETTLE_PER_BLOCK_CAP', '0.2.0',CROSS_SETTLE_CAP_MAINNET_TIME,0,0,0,0,0],

    // Per-subcommand root discriminator for the ATTEST request_id / XCALL call_id
    // preimages.
    //
    // Those preimages carry a per-root discriminator whose value is the root action's
    // on-chain output index TX_VOUT, which was assumed unique per root within a
    // transaction. A BATCH breaks the assumption: actions.js assigns TX_VOUT once per
    // TRANSACTION and every subcommand of the batch is its own root action under it,
    // each seeding call-path ''. Two EXECUTE subcommands against the SAME contract in
    // one BATCH therefore derived the IDENTICAL request_id for their first attestation,
    // and db.createAttestationRequest dropped the second (warn-and-return on the prior
    // row), leaving the second execution bound to the first request's provider,
    // payload and callback while its value stayed escrowed against no row of its own.
    //
    // With the gate ON, a root action that is a BATCH subcommand carries the composite
    // discriminator "<TX_VOUT>.<subcommand position>" instead of the bare TX_VOUT (see
    // src/batch_root_discriminator.js). Nothing else about the preimages changes: a
    // non-BATCH root keeps the bare TX_VOUT, so every id derived outside a BATCH is
    // byte-identical across the flag day and no pending request's id moves.
    //
    // Kept as its own consensus rule because the request_id is a CONSENSUS preimage:
    // it is what the handler re-derives to accept an ATTEST v0, what validators sign
    // over, and what the callback resolves against. A network that had derived one
    // inside a BATCH would need a from-genesis replay to reproduce the historical
    // (colliding) id below the boundary.
    //
    // Keyed on block_TIME like the sibling contract-era gates: EXECUTE runs on BTC,
    // LTC and DOGE, whose heights diverge by millions of blocks, so no single height
    // names one cutover across all three but a single timestamp does.
    //
    // EVERY NETWORK ACTIVATES AT GENESIS (all zeros). Mainnet was armed there on
    // 2026-09-09 on the measurement that it holds no BATCHes, no EXECUTEs and no
    // attestations, so no id it ever derived can move;
    // BATCH_ROOT_SUB_INDEX_MAINNET_TIME above carries the counts and names the replay
    // witness that proves it.
    ['BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR', '0.2.0',BATCH_ROOT_SUB_INDEX_MAINNET_TIME,0,0,0,0,0],

    // ISSUE mint-window re-parameterization fix. Below this activation the
    // MINT_START_BLOCK / MINT_STOP_BLOCK recency checks in actions/issue.js run
    // against the MERGED action data, which the populate-empty-params step has
    // already filled with the existing token record's values, so a
    // re-parameterizing ISSUE that leaves the mint window untouched inherits the
    // stored MINT_START_BLOCK and is rejected the moment the window has opened
    // (the inherited value is by then in the past). At/above it the recency
    // checks apply only to a value the ISSUE explicitly carries on the wire (the
    // pre-merge snapshot), mirroring how the CALLBACK edit checks already detect
    // explicit fields; an explicitly restated past value is still rejected, so
    // the checks' anti-backdating purpose is untouched, and the
    // stop-before-start cross-check still runs on the merged (effective) window.
    //
    // Gated as its own consensus rule because the fix is a validity LOOSENING:
    // an ISSUE that historical processing rejected ('MINT_START_BLOCK <
    // BLOCK_INDEX' via inheritance) becomes valid, so an ungated flip forks a
    // heterogeneous fleet on the first such re-issue and breaks from-genesis
    // replay byte-identity. Keyed on block_TIME like the sibling multi-chain
    // gates: ISSUE runs on BTC, LTC and DOGE, whose heights diverge by millions
    // of blocks, so no single height names one cutover across all three but a
    // single timestamp does.
    //
    // MAINNET IS ARMED AT GENESIS (0) by the 2026-09-09 ruling, on the measurement
    // that mainnet holds no MINT at all, so no stored mint window has ever opened for
    // an inherited value to fall behind. TESTNET IS ARMED at
    // ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME (1787961600 = 2026-08-29T00:00:00Z,
    // re-pinned forward from the lapsed 2026-08-24 instant on 2026-08-25), because
    // BTC testnet4 holds a recorded rejection of exactly this shape and cannot be
    // genesis-active; the constants above carry both reasonings and name the replay
    // witness that settles the mainnet one. Regtest activates at genesis (0) so the
    // unit/e2e suites exercise the corrected rule from block 0.
    ['ISSUE_INHERITED_MINT_WINDOW', '0.2.0',ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME,ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME,0,0,0,0],

    // DEPLOY_DEFERRED_ASSEMBLY: a chunked DEPLOY group (one source, one code_hash)
    // deploys exactly once, in the block where its last piece confirms, whatever
    // order the pieces confirmed in. Below the flag day the assembling DEPLOY must
    // follow every carrier or it fails permanently; at/above it an early assembler
    // lands 'pending: CODE_HASH (awaiting chunks)' (base fee paid, no code, no
    // address, no state) and the first VALID action that completes the group, an
    // assembler or a carrier, runs the deployment at ITS action_index with the
    // pending assembler's wire parameters and its own transaction context; the
    // constructor row it writes names the consumed assembler in
    // contract_executions.assembler_action_index. One pending assembler per group
    // ('invalid: CODE_HASH (duplicate pending)'); no expiry; rollback is the generic
    // action-keyed delete because every row the deployment writes is keyed at the
    // completing action.
    //
    // Gated because the observable outcomes change: an out-of-order group deploys
    // instead of failing, an early assembler pays base gas and lands pending instead
    // of invalid and unpaid, the fee and sleeping checks now precede the chunk
    // verdict, and the pending contracts row enters that block's contract_hash.
    // Keyed on block_TIME like the sibling multi-chain gates. MAINNET at genesis (no
    // chunked-DEPLOY history on any mainnet chain), TESTNET UNARMED until the shipping
    // release pins the instant (the constants above carry the reasoning and the
    // testnet4 history that forbids a past instant), regtest at genesis (0).
    ['DEPLOY_DEFERRED_ASSEMBLY', '0.2.0',DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME,DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME,0,0,0,0],

    // CONTRACT_META_REQUIRED: a contract must name itself. At/above the flag day a
    // DEPLOY is rejected unless its exports carry a plain-object `meta` with a
    // conforming `name` and `description` (and a conforming `version` when the key
    // is present); the seven verdict strings and the text grammar live in
    // src/contract_meta.js. The meta verdict is judged AFTER the permissions and
    // maxTakeBps verdicts, so a contract malformed on both keeps reporting today's
    // string, and OUTSIDE the manifest success guard, so a module-level throw is
    // 'invalid: CONTRACT_MANIFEST (manifest read failed)' rather than a nameless
    // 'valid'. A chunked group is judged once, at the completing piece: a pending
    // assembler holds its verdict and never reaches the VM block.
    //
    // Gated because the observable outcome changes for two classes of contract that
    // deploy 'valid' today (no meta, and a throwing top level), and because the
    // extracted values are written into the new contracts.meta_* columns. Keyed on
    // block_TIME like the rest of the contract-era cohort (DEPLOY_INIT_STRICT,
    // CONTROLLER_GUARD, VM_BANNED_ASYNC): one indexer-side verdict, no per-coin axis.
    // MAINNET at genesis (no mainnet contracts), TESTNET UNARMED until the shipping
    // release pins the instant (the constants above carry the reasoning and the TBTC
    // history that forbids a past instant), regtest at genesis (0).
    ['CONTRACT_META_REQUIRED', '0.2.0',CONTRACT_META_REQUIRED_MAINNET_TIME,CONTRACT_META_REQUIRED_TESTNET_TIME,0,0,0,0],

    // NOTE: STAKE_WEIGHTED_QUORUM (WI-1) is deliberately NOT registered here.
    // Standard activations gate on the LOCAL processing block via isEnabled();
    // stake-weighted quorum must gate on the BTC-anchored `snapshot_block`
    // carried by each settlement (so BTC/LTC/DOGE + the hub flip on the same
    // anchor). Registering it would invite a wrong isEnabled(localBlock) call.
    // The gate + predicate live in src/stake_weighted_quorum.js
    // (isStakeWeightedQuorumActive / meetsStakeThreshold). Canonical activation
    // height: xchain-documentation/protocol/constants.js.

    // JSON_STRINGIFY_HOOK: mirrors xchain-vm's JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME
    // (VM CONSENSUS_VERSION 5, the value-hook depth-bypass fix). All three network
    // slots carry the VM's own instant; the release cut moves both literals together.
    ['JSON_STRINGIFY_HOOK', '0.2.0',9999999999,9999999999,9999999999,0,0,0],
];
