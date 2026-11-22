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
 * Time table part 3 of 5: COOLDOWN_BLOCKS_INTEGER through BATCH_SUBACTION_NORMALIZATION.
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
    // with isCryptoAddress (mirroring mint.js / issue.js / dispenser/validate.js). The 'BURN' sentinel
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

    // Release the seller's escrowed token leg on expiry, never COIN_AMOUNT.
    // Key by time because native-chain heights diverge.
    ['COINPAY_EXPIRE_TOKEN_AMOUNT', '0.2.0',1786060800,0,0,0,0,0],

    // Settle native matches only when both legs mirror exactly.
    // Pick roles consistently by which order gives native coin.
    ['COINPAY_NATIVE_RECIPROCITY', '0.2.0',1786060800,0,0,0,0,0],

    // Attribute cooldown returns to a synthetic UNSTAKE at the expiry block.
    // Keep ledger_hash attribution aligned with balances_root.
    ['UNSTAKE_COOLDOWN_COMPLETION_ACTION', '0.2.0',1786060800,0,0,0,0,0],

    // Process data-bearing transactions once at the lowest output index.
    // Preserve fan-out only for COINPAY and empty-data DISPENSE transactions.
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

    // Materialize rotations onto stake rows and journal each rewrite.
    // Use a dedicated future gate; never substitute a read-side remap.
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

    // Select non-reference-chain fee prices by timestamp after this time gate.
    // Keep the block-loop price barrier unconditional on every chain.
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

    // Normalize BATCH sub-actions like top-level actions after this gate.
    // Apply aliases and implied version zero; leave sub-actions raw below it.
    ['BATCH_SUBACTION_NORMALIZATION', '0.2.0',1786060800,0,0,0,0,0],
];
