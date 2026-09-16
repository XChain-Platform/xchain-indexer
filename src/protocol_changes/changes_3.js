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
 * Time table part 3 of 4: COOLDOWN_BLOCKS_INTEGER through BATCH_SUBACTION_NORMALIZATION.
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
    NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME,
} = require('./flag_times.js');

module.exports = [
    // DEPLOY validity: integer COOLDOWN_BLOCKS. Before this activation the staking
    // cooldown was gated only by isNumeric + range, so a fractional value ('50.5')
    // deployed successfully and stored a fractional contracts.cooldown_blocks,
    // violating the documented unsigned-int bound (protocol/Contract_Staking.md
    // DEPLOY v1 field type) and flowing a non-integer COOLDOWN_END_BLOCK into
    // UNSTAKE. After activation the guard requires an integer, matching the
    // EXPIRATION siblings (order/swap/dispenser). Gated so a from-genesis replay
    // reproduces any historic fractional-cooldown accept verdict below the
    // flag-day: mainnet pins the same coordinated contract-era flag-day as the
    // sibling validity gates (2026-08-07 00:00:00 UTC); testnet/regtest activate
    // at genesis (all zeros).
    ['COOLDOWN_BLOCKS_INTEGER', '0.2.0',1786060800,0,0,0,0,0],

    // DEPLOY validity (Pkg6 / dede7788): an EXPLICIT SLASH_DESTINATION on a stakeable
    // DEPLOY (v1/v3) must resolve to a well-formed chain address. Before this activation
    // deploy.js only resolved the SDK's ^<id> compaction and never validated the result,
    // so an unresolvable caret id or a malformed literal was interned into the IMMUTABLE
    // contracts.slash_destination; every later slash then routed stake to an unspendable
    // address (permanent money loss). After activation the resolved destination is checked
    // with isCryptoAddress (mirroring mint.js / issue.js / dispenser.js). The 'BURN' sentinel
    // and the default-to-BURN path are exempt (they resolve to the trusted configured burn
    // address). Gated as its own consensus rule because rejecting a DEPLOY that historically
    // committed 'valid' changes both the acceptance verdict AND the contract_hash
    // (contracts.status_id is contract-hashed): an ungated flip forks a heterogeneous fleet
    // and breaks from-genesis replay byte-identity on the first stakeable DEPLOY carrying a
    // malformed SLASH_DESTINATION. mainnet pins the coordinated contract-era flag-day
    // (2026-08-07 00:00:00 UTC); testnet/regtest activate at genesis (all zeros).
    ['DEPLOY_SLASH_DEST_ADDRESS_VALID', '0.2.0',1786060800,0,0,0,0,0],

    // UNSTAKE validity (Pkg6 / 048fdea9 + ce6a484f): strict contract-cooldown derivation.
    // _parseContractUnstake historically computed COOLDOWN_END_BLOCK from
    // `(contractInfo && contractInfo.cooldown_blocks) ? Number(...) : 1000` - a fallback to
    // the capability-staking global 1000 that is a DEAD branch on the valid path (the
    // handler already rejects a null/non-stakeable cooldown, and DEPLOY enforces an integer
    // cooldown in [1,100000]) yet FIRED on every ERROR path (unknown target, not-stakeable,
    // no active stake), persisting a phantom BLOCK_INDEX+1000 into the INVALID
    // contract_unstakes row - a replicated, state_hash-covered column. After activation the
    // handler rejects a non-positive-integer contract cooldown outright (closing the latent
    // cross-file trap) and computes COOLDOWN_END_BLOCK only on the valid path, leaving error
    // rows at 0. The valid-path value is UNCHANGED (it always took Number(cooldown_blocks)),
    // so the only observable change is the error-path row value; gated so a from-genesis
    // replay / heterogeneous fleet reproduces the historic (phantom-1000) error-row values
    // below the flag-day. mainnet pins the coordinated contract-era flag-day (2026-08-07
    // 00:00:00 UTC); testnet/regtest activate at genesis (all zeros).
    ['UNSTAKE_CONTRACT_COOLDOWN_STRICT', '0.2.0',1786060800,0,0,0,0,0],

    // ISSUE validity: cumulative MINT_SUPPLY cap. Before this activation the only guard on
    // an ISSUE's MINT_SUPPLY was a single-shot `MINT_SUPPLY > MAX_SUPPLY` check, which
    // ignores supply that already exists: an owner could re-ISSUE the same tick with
    // MINT_SUPPLY repeatedly (LOCK_MINT_SUPPLY unset) and mint fresh supply past MAX_SUPPLY
    // (and past a locked NFT edition size), because MINT_SUPPLY is credited on every valid
    // ISSUE, not just the first. After activation the cap is enforced against
    // SUPPLY + MINT_SUPPLY, matching mint.js's cumulative MAX_SUPPLY invariant (bcadd(SUPPLY,
    // AMOUNT) > MAX_SUPPLY). Gated because it TIGHTENS validity (an over-cap re-ISSUE
    // that was valid becomes invalid): an ungated flip would fork a heterogeneous fleet on the
    // first such re-ISSUE and diverge a from-genesis replay from the committed ledger_hash.
    // Same coordinated contract-era flag-day timestamp as the other tightening consensus
    // fixes in this window (2026-08-07 00:00:00 UTC); testnet/regtest activate at genesis
    // (all zeros) so the check is in force from block 0 there and in the unit/e2e suites.
    ['ISSUE_MINT_SUPPLY_CUMULATIVE_CAP', '0.2.0',1786060800,0,0,0,0,0],

    // SLEEP validity: honor the token's LOCK_SLEEP flag. Before this activation the SLEEP
    // handler never inspected tokenInfo['LOCK_SLEEP'], so a token issued with LOCK_SLEEP=1
    // (a documented, immutable "cannot be paused" guarantee holders rely on) could still be
    // frozen indefinitely by its owner (SLEEP|1|-1|TICK) - the only LOCK_* flag with zero
    // enforcement anywhere in src/. After activation a TICK sleep of a LOCK_SLEEP=1 token is
    // rejected ('invalid: LOCK_SLEEP'), mirroring the LOCK_MINT (mint.js) / LOCK_CALLBACK
    // (callback.js) enforcement pattern. Gated because it TIGHTENS validity (a SLEEP that
    // was valid becomes invalid), so the fleet and any from-genesis replay must flip at one
    // coordinated block. Same contract-era flag-day timestamp as the other tightening fixes
    // (2026-08-07 00:00:00 UTC); testnet/regtest activate at genesis.
    ['SLEEP_RESPECTS_LOCK_SLEEP', '0.2.0',1786060800,0,0,0,0,0],

    // COINPAY_EXPIRE escrow-release amount correctness. A native-coin ORDER_MATCH
    // escrows the SELLER's token leg (order_matches give/get amount) and records a
    // coinpay_obligation whose COIN_AMOUNT is the BUYER's native-coin leg (a different
    // asset and quantity). The fulfill path (coinpay.js) correctly releases the token
    // leg (getOrderMatchAmounts) from escrow to the buyer. Before this activation the
    // EXPIRE path released obligation.COIN_AMOUNT of the seller's TOKEN back to the
    // seller instead: it credited a token quantity equal to the native-coin amount,
    // over- or under-releasing the seller's escrow by (COIN_AMOUNT - tokenAmount). An
    // over-release is a net-zero (+credit / -escrow) phantom mint out of the global
    // escrow pool that evades the per-block supply sanity check (same class as OM-1);
    // an under-release strands tokens in escrow. After activation the EXPIRE path
    // releases the same token leg the fulfill path does. Gated because it CHANGES a
    // consensus-visible ledger movement (the credited/escrow amounts, hashed into
    // balances_root + ledger_hash): an ungated flip forks a heterogeneous fleet on the
    // first native-coin coinpay expiry and diverges a from-genesis replay from the
    // committed ledger. Keyed on block_TIME (not block_index), mirroring the other
    // multi-chain gates: native-coin DEX pairs settle on BTC, LTC and DOGE whose
    // heights diverge by millions of blocks, so no single shared height names one
    // cutover across all three chains, but a single timestamp does. Same coordinated
    // contract-era flag-day as the other tightening fixes in this window (2026-08-07
    // 00:00:00 UTC); testnet/regtest activate at genesis (all zeros) so the correct
    // release is in force from block 0 there and in the unit/e2e suites.
    ['COINPAY_EXPIRE_TOKEN_AMOUNT', '0.2.0',1786060800,0,0,0,0,0],

    // COINPAY native-coin match reciprocity + role detection. A native-coin ORDER_MATCH
    // settles two-phase: order_match.js reserves the token seller's escrowed leg and
    // records a coinpay_obligation whose PAYER is the coin offerer and PAYEE is the token
    // seller; COINPAY/COINPAY_EXPIRE later release the seller's token leg. Which order is
    // the coin offerer vs the token seller must be identified IDENTICALLY in all three
    // files. findOrderMatches enforces the forward leg (orderInfo.GIVE == matchInfo.GET)
    // strictly but NULL-relaxes the reverse leg (orderInfo.GET == matchInfo.GIVE) so a
    // native-coin side can pair. That relaxation also lets a token-for-COIN order
    // (GET_TICK null) match a token-for-token maker whose GIVE_TICK is a real token: no
    // side actually gives native coin to the coin-wanting side, yet order_match would mint
    // a bogus COINPay obligation, and its 4-case role detection (which reads GET_TICK)
    // disagrees with coinpay.js / coinpay_expire.js's 2-case detection (which reads only a
    // single GIVE_TICK) - releasing the WRONG order's escrowed token on fulfill/expire
    // (a net-zero +credit / -phantom-escrow mint out of the global escrow pool, same class
    // as OM-1 / the COINPAY_EXPIRE_TOKEN_AMOUNT bug, invisible to the supply sanity check).
    // After activation order_match.js skips a native match whose legs are not an exact
    // null-to-null / token mirror (so a legitimate native match has exactly one coin-giving
    // side), and coinpay.js / coinpay_expire.js key the seller/coin split on which side
    // actually GIVES native coin (checking BOTH orders) and refuse to settle an ambiguous
    // shape. On the only reachable well-formed shapes (exactly one GIVE_TICK null) the new
    // and legacy detections agree byte-for-byte, so this only removes the mis-paired path.
    // Gated because it CHANGES which matches settle (a consensus-visible ledger movement
    // hashed into balances_root + ledger_hash): an ungated flip forks a heterogeneous fleet
    // and diverges a from-genesis replay. Keyed on block_TIME like the sibling native-coin
    // gates (BTC/LTC/DOGE heights diverge; one timestamp names the cutover across all three).
    // Same coordinated contract-era flag-day (2026-08-07 00:00:00 UTC); testnet/regtest
    // activate at genesis (all zeros) so the correct routing holds from block 0 there and in
    // the unit/e2e suites.
    ['COINPAY_NATIVE_RECIPROCITY', '0.2.0',1786060800,0,0,0,0,0],

    // UNSTAKE cooldown-completion action attribution. When a capability/contract
    // UNSTAKE cooldown elapses, processCooldownCompletions credits the returned
    // tokens back to the source. Before this activation the credit reused the
    // UNSTAKE's OWN action_index (whose block_index is the earlier UNSTAKE block),
    // so the block-hash query buckets the credit into the UNSTAKE's origin block,
    // whose ledger_hash was committed BEFORE the credit existed, while a
    // recompute-from-final-state (a snapshot-bootstrapped xchain-sync replica, an
    // SPV verifier) buckets it there too and diverges from the committed hash. The
    // balances_root already attributes the effect to the cooldown block, so the
    // ledger_hash was the sole mis-attributed commitment. After activation the
    // return credit is attributed to a fresh synthetic UNSTAKE (format 2) action
    // minted at the cooldown-expiry block, so it hashes into the block where the
    // effect is applied and the ledger_hash chain agrees with balances_root and
    // with any recompute. Consensus-breaking (changes actions_hash + ledger_hash
    // for cooldown-completion blocks), so it is gated on the same coordinated
    // flag-day as the other contract-era consensus fixes (2026-08-07 00:00:00 UTC,
    // CONFIRMED 2026-07-07, aligned with the fleet upgrade; a wrong value forks).
    // testnet/regtest activate at genesis (all zeros); the e2e/regtest stack must
    // be rebuilt fresh so no pre-activation cooldown-completion blocks remain.
    ['UNSTAKE_COOLDOWN_COMPLETION_ACTION', '0.2.0',1786060800,0,0,0,0,0],

    // FIX_OUTPUT_FANOUT: collapse the reader-side per-output fan-out for data-bearing,
    // non-COINPAY transactions. getDecoderBlockData (db.js) LEFT JOINs transaction_outputs
    // and emits ONE row per stored native-coin output, each carrying the same tx `data`;
    // the block loop runs processTransaction once per row and createActionIndex dedupes on
    // a per-row tx_vout, so a data-bearing action (e.g. SEND) whose transaction ALSO pays a
    // dispenser and/or a native fee-destination output executes once PER output row -
    // duplicate credits/debits for a single on-chain transaction. Per-output processing is
    // only intended for COINPAY payment settlement and empty-data DISPENSE triggers. At/after
    // this flag-day, output_fanout.collapseOutputFanout keeps exactly one row (the lowest
    // vout, deterministic across nodes) for every other transaction; COINPAY and empty-data
    // rows keep their fan-out. BELOW the flag-day the historical per-row behaviour is
    // preserved, except that such a multi-row data-bearing transaction is a consensus-critical
    // fault that aborts the block (visible halt via the watchdog/rollback path) rather than
    // silently double-executing. Consensus-visible (changes actions_hash + ledger_hash for any
    // affected block), so gated on the same coordinated contract-era flag-day as the other
    // 2026-08-07 00:00:00 UTC fixes (a wrong value forks); keyed on block TIME because the
    // affected native-coin payment/dispenser flows settle on BTC, LTC and DOGE whose heights
    // diverge, so no single height names one cutover. testnet/regtest activate at genesis
    // (all zeros) so the collapse is in force from block 0 there and in the unit/e2e suites.
    ['FIX_OUTPUT_FANOUT', '0.2.0',1786060800,0,0,0,0,0],

    // Staking-family stress-sweep fixes (2026-07-09). All three are consensus-visible
    // validity/derivation changes, gated on the same coordinated contract-era flag-day
    // as the other 2026-08-07 fixes (a wrong value forks); testnet/regtest at genesis.

    // DEL-1: DELEGATE v2 delegation-revoke, before this activation, INSERTed a fresh status=valid,
    // activation_block=0 delegations row (createRevokeDelegation -> createDelegation) in
    // addition to deactivating the parent, so a repeat revoke before maturity EXTENDED the
    // revoked key's signer lifetime and the stray rows corrupt historical as-of effective-set
    // reads. At/after this flag-day the revoke mirrors the v3 path: NO insert, deactivate the
    // parent only. Changes the delegations table that feeds _stakeWeightsSql/stakes_root, so
    // it is a hashed-derivation change (flag-day, not a query tweak).
    ['DELEGATE_REVOKE_NO_REINSERT', '0.2.0',1786060800,0,0,0,0,0],

    // STAKE-1: the contract-targeted TARGET_CONTRACT_INDEX was validated with /^[0-9]+$/, which
    // accepts non-canonical leading-zero forms ('007'). Benign at runtime (Number-coerced
    // consistently, no fund-stranding, unlike the DEPOSIT custody-address bug), but it is a
    // non-canonical validity surface inconsistent with deposit/withdraw's /^[1-9]\d*$/. At/after
    // this flag-day STAKE v3 / UNSTAKE v1 / DELEGATE v1,v3 reject leading zeros. UNLIKE the
    // deposit/withdraw tightening (ungated - a leading-zero deposit was ALREADY a stranded-funds
    // bug, so rejecting forked nothing valid), a leading-zero contract stake currently produces a
    // VALID, correct row, so tightening it is a live validity change and MUST be gated.
    // EXEC-1 joins the same flag-day: EXECUTE's CONTRACT_ACTION_INDEX was also
    // /^\d+$/, and there a leading-zero index is NOT benign - the VM hashes Number(index)
    // into the attestation request_id preimage while the host re-hashes the raw EMITTER
    // string, so '007' makes the two disagree and the host rejects an ATTEST the VM
    // accepted. Same gate because it is the same validity change (an index form that is
    // valid today stops being valid), and it also rejects indexes past the safe-integer
    // range, whose Number() rounding is the same divergence class.
    ['CONTRACT_INDEX_CANONICAL', '0.2.0',1786060800,0,0,0,0,0],

    // DEL-2 (#4366): a DELEGATE v1 signing-key rotation wrote contract_delegations but NEVER
    // reached contract_stakes, so the rotated key owned nothing the protocol actually reads.
    // All three contract-stake lookup surfaces key on contract_stakes.signing_pubkey_id:
    // getContractStakeDataForVM (the getStake/getStakers/getTotalStaked snapshot a contract
    // observes), getActiveContractStakeByPubkey (the UNSTAKE refund aggregate) and
    // slashContractStake (the SLASH deduction). The rotated key therefore never appeared in
    // getStakers, could not UNSTAKE, and a SLASH against it deducted nothing while the
    // contract still recorded the punishment - the incoherence the build-a-stakeable-contract
    // guide promises does not exist.
    //
    // At/after this flag-day the rotation is MATERIALIZED onto contract_stakes: the end-of-
    // activation-delay sweep (utility.processContractDelegationMaterializations ->
    // db.materializeContractDelegations) rewrites signing_pubkey_id on the delegating source's
    // active (target, tick) stake rows and journals each rewrite in
    // contract_delegation_rotations so a reorg restores the previous key verbatim. The three
    // lookup surfaces then agree by construction, with no per-surface remap: remapping only
    // the READ (the finding's proposal A) would make a contract emit SLASH against a key the
    // ledger cannot debit, which is worse than the coherent gap it replaces.
    //
    // Gated because it changes what EXECUTE observes through getStake/getStakers/
    // getTotalStaked, so historical blocks must replay byte-identically. Minted at its own
    // future instant rather than reusing the contract-era anchor: that anchor is already in
    // the past, and a retroactive boundary would make a from-genesis replay hand contracts a
    // DIFFERENT staker set than the live fleet observed. The value lives here and is
    // rendered into the docs by xchain-documentation/bin/generate-flag-days.js; every
    // indexer and sync process must be deployed before mainnet crosses it.
    // testnet/regtest are live from genesis, exactly like the sibling contract-era gates.
    ['CONTRACT_DELEGATION_MATERIALIZE', '0.2.0',1789430400,0,0,0,0,0],

    // SLASH-1: slashCapabilityStake Pass 1 filtered `activation_block <= block`, so a
    // pending-activation capability top-up (debited at STAKE time) escaped the equivocation bond
    // burn and could later be UNSTAKEd/refunded (the sibling slashContractStake has no such
    // filter). At/after this flag-day the whole locked bond burns, activated or not. Gated on the
    // BTC-anchored EQUIV activation HEIGHT (equivocation_header.js EQUIV_HEADER_ACTIVATION.mainnet
    // = 961000), NOT the 2026-08-07 timestamp: real slashing is inert below the EQUIV flag-day,
    // and 961000 (~2026-08-04) precedes 2026-08-07, so a timestamp gate would leave a window where
    // slashing ran with the old (incomplete) burn. Height-gated so the fix goes live exactly when
    // slashing does. slashCapabilityStake is indexer-only (the follower mirrors the zeroed rows),
    // so this is not a byte-locked twin.
    ['SLASH_BURNS_PENDING_STAKE', '0.2.0',0,0,0,961000,0,0],

    // SLASH-2: an XORACLE equivocation proof must agree on the ORACLE ROUND
    // carried in the signed JSON, not just on the BTC height in the EQUIV key. Oracle
    // rounds advance on wall-clock while the captured BTC tip can stand still, so an
    // honest validator signing rounds N and N+1 at one tip produced two messages sharing
    // the header prefix `EQUIV|XORACLE|<height>|0||` with different content, which
    // slash.js read as equivocation and burned its ENTIRE bond (permanent, fleet-wide
    // disqualification). Same gate as SLASH-1 and for the same reason: real slashing is
    // inert below the BTC-anchored EQUIV activation HEIGHT (equivocation_header.js
    // EQUIV_HEADER_ACTIVATION.mainnet = 961000), so a height gate lands the fix exactly
    // where the rule it narrows can first fire. Gated rather than unconditional because
    // this REJECTS proofs a pre-fix node accepts, and a half-upgraded fleet disagreeing
    // on a SLASH's validity is a ledger fork.
    ['SLASH_ORACLE_ROUND_DISCRIMINATED', '0.2.0',0,0,0,961000,0,0],

    // H-3: deterministic price_snapshots selection for native-coin fee
    // validation on NON-reference chains. Price rounds are anchored to BTC
    // heights, so getLatestPrice's `reference_block <= blockIndex` gate is
    // vacuously true against LTC/DOGE heights (numerically far above any BTC
    // anchor): the query returned whatever globally-latest round the local
    // mirror held, so mirror lag forked the fleet AND a from-genesis replay
    // read today's newest round instead of the round used live. At/after
    // this flag-day, non-BTC chains select by the round's consensus
    // timestamp instead (`block_timestamp <= block time`, the same pair of
    // quantities the staleness guard already compares). Keyed on block TIME (not
    // height) for the same reason as DEPLOY_BASE64_CODE: no single height
    // names one cutover across chains. Evaluation happens in exactly one place,
    // utility.getFeeOraclePrices via isNativeFeePriceTimeGateActive() above;
    // registered here so the flag-day inventory carries it. The block loop's
    // time-keyed price barrier is NOT a consumer of this flag: it is unconditional
    // on every chain (XChainIndexer.js:877-888), and re-conditioning it on this
    // flag-day would re-open the LTC/DOGE FIAT-dispense divergence window.
    ['NATIVE_FEE_PRICE_TIME_GATE', '0.2.0', NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME,0,0,0,0,0],

    // DEPLOY_INIT_STRICT (F-14 follow-on): a contract that exports `initialize`
    // (a constructor) deployed with NO CONSTRUCTOR_PARAMS today runs no
    // constructor yet still commits 'valid' - it silently deploys uninitialized.
    // At/after this flag-day the DEPLOY of a constructor-declaring contract with
    // no CONSTRUCTOR_PARAMS field is REJECTED, and the constructor trigger moves
    // from truthy to field-present so an explicit empty CONSTRUCTOR_PARAMS runs a
    // zero-arg initialize (deploy.js). Below the flag-day: byte-identical to today
    // (truthy trigger, no reject), so a from-genesis replay reproduces the historic
    // accept-below/reject-above verdict. Keyed on block TIME with the 2026-08-07
    // contract-era cohort (CONTROLLER_GUARD / VM_BANNED_ASYNC); testnet/regtest
    // genesis-on. Indexer-only verdict (uses the VM readManifest `hasInitialize`
    // flag), so not a byte-locked twin; the VM readManifest change ships alongside.
    ['DEPLOY_INIT_STRICT', '0.2.0',1786060800,0,0,0,0,0],

    // BATCH sub-action normalization: the top-level dispatcher
    // (actions.js) rewrites ACTION aliases (TRANSFER->SEND, ADDR->ADDRESS,
    // DROP->AIRDROP, CAST->BROADCAST, MSG->MESSAGE) and injects the implied
    // legacy VERSION 0 for BTNS-style ISSUE/MINT/SEND params, but batch.js
    // historically did neither for its sub-actions: an aliased sub-action
    // name fails the activation lookup (whole BATCH -> 'invalid: ACTION
    // (unknown)') and a legacy-format sub-action parses its TICK as the
    // FORMAT version. At/after this flag-day BATCH sub-actions are
    // normalized exactly like top-level actions (alias rewrite in the
    // limit/validity scans, the sibling pre-parse and the dispatch loop;
    // VERSION-0 injection before FORMAT derivation and handler dispatch).
    // Below it: byte-identical to today, so a from-genesis replay
    // reproduces every historic reject/misparse verdict (a BATCH that
    // was invalid becoming valid changes actions/ledger state hashed
    // into the checkpoint preimage; an ungated flip forks a skewed fleet
    // on the first aliased or legacy-format sub-action). Keyed on block
    // TIME with the ratified 2026-08-07 contract-era cohort;
    // testnet/regtest activate at genesis (all zeros).
    ['BATCH_SUBACTION_NORMALIZATION', '0.2.0',1786060800,0,0,0,0,0],
];
