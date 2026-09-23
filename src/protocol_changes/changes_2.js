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
 * Time table part 2 of 4: VOTE_POLL_TICK_VISIBLE through LOCK_NULL_PRIOR_UNSET.
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
    VM_BANNED_ASYNC_MAINNET_TIME,
} = require('./flag_times.js');

// Resolved when the table is BUILT rather than when this file loads, which is what
// the row had inside parseChanges(): the royalty drill suite sets the override, drops
// the entry module from the require cache and expects a fresh table to carry it. An
// argument written as a function is what core.applyChanges() resolves at build time.
const ccRoyaltyRegtestTime = () => parseInt(process.env.CROSS_CHAIN_ROYALTY_REGTEST_TIME) || 0;

module.exports = [
    // BonkDAO lesson 4: expose a poll's electorate TICK to
    // contracts so a binding-poll callback can verify WHICH token decided
    // it (the treasury template's arm() pins poll.tick === its governing
    // govTick, defeating a "raid a throwaway token's poll to drain an
    // unrelated treasury" swap). Two surfaces flip together at this
    // activation: (1) the finalize/timelock callback EXECUTE gains a `tick`
    // positional arg inserted after min_voters_met and before the
    // developer callback params, and (2) each getPollResultsForVM snapshot
    // entry (backing xchain.getPollResult) gains a `tick` field. The tick
    // is the poll's immutable electorate (polls.tick_id resolved through
    // index_tickers), deterministic on every node and on replay. Gated as
    // its own consensus rule because BOTH changes alter VM execution
    // inputs: the callback arg shifts every developer param one position
    // (a contract reading getInputParam(7) reads a different value), and
    // adding a snapshot key changes what a contract observes via the poll
    // accessor - an ungated flip forks a heterogeneous fleet on the first
    // binding-poll callback or tick-reading contract. Keyed on block_TIME
    // and armed at the ratified coordinated anchor 1786060800 (2026-08-07
    // 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort, for the reasons
    // stated at DEPLOY_BASE64_CODE above; a divergent value is a fork. testnet/regtest
    // activate at genesis (no history to preserve; the e2e/regtest stack
    // exercises the visible tick from block 0).
    ['VOTE_POLL_TICK_VISIBLE', '0.2.0',1786060800,0,0,0,0,0],

    // ATTEST v1 canonical id-case normalization. Below this activation
    // the canonical signing bytes (and the EQUIV ROUND_ID) use the RAW wire
    // REQUEST_ID case, the original behaviour: a case-mutated replay of a
    // pending v1 fails ed25519 verification because the hub signed the
    // lowercase id, and every node rejects it identically. At/above it the
    // canonical uses the LOWERCASED id, making byte-identity with the hub's
    // AttestationConsensus._buildCanonical self-contained instead of resting
    // on the external producer-lowercases invariant. Gated as its own
    // consensus rule because the switch is a validity LOOSENING: wire bytes a
    // legacy node rejects (uppercase id, lowercase-signed sigs) verify on an
    // upgraded node, so an ungated flip lets any attacker split a
    // heterogeneous fleet with a single case-mutated replay (which is why the
    // inline fix was deferred to this flag-day). Keyed on block_TIME and
    // armed at the ratified coordinated anchor 1786060800 (2026-08-07
    // 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort, for the reasons
    // stated at DEPLOY_BASE64_CODE above; a divergent value is
    // a fork. testnet/regtest activate at genesis (no history to preserve;
    // the e2e/regtest stack exercises the self-contained canonical from
    // block 0).
    ['ATTEST_CANONICAL_LOWERCASE_ID', '0.2.0',1786060800,0,0,0,0,0],

    // Attestation Phase 5 (spec §12): the origin-side half of the
    // cross-chain relay. Below this activation an ATTEST v0 emitted by an
    // LTC or DOGE contract is REJECTED at admission, because
    // Attest._computeResponsibleSet returns [] on any non-BTC chain (the
    // capability stake that qualifies attestation validators exists only on
    // BTC) and ATTEST_ADMISSION_ACTIVATION rejects a request whose
    // responsible set is smaller than its REDUNDANCY. At/above it such a
    // request is instead admitted 'pending' and marked with its origin
    // chain, so the hub's relay driver can materialize it onto BTC (ATTEST
    // v3) and relay the response back (ATTEST v4). Nothing else about
    // admission changes: a request that fails any OTHER validation is still
    // rejected, and on BTC the rule is a no-op because a BTC responsible set
    // is never empty by construction.
    //
    // Keyed on block_TIME for the same reason ATTEST_CANONICAL_LOWERCASE_ID
    // above is: the rule must flip on LTC and DOGE, whose local heights sit
    // millions of blocks above any BTC-derived threshold, so a height gate
    // carrying a BTC value would already be satisfied there and would ship
    // the rule live instead of inert (the ATTEST_ADMISSION_ACTIVATION plane
    // trap, documented in attest_admission_activation.js). The mainnet
    // timestamp is ARMED to the same ratified contract-era cohort anchor
    // 1786060800; a divergent value is a fork. The BTC-anchored half of
    // Phase 5 (accepting v3/v4 on the wire) rides ATTEST_RELAY_ACTIVATION in
    // attest_relay_activation.js; either order of the two is safe, see the
    // note there. testnet/regtest activate at genesis.
    ['ATTEST_RELAY_ORIGIN', '0.2.0',1786060800,0,0,0,0,0],

    // VM xchain.attestation.getResponse(requestId) reader. Below this
    // activation the VM snapshot's attestationData is always null, so
    // getResponse() returns null for every request (the pre-reader behaviour);
    // the callback EXECUTE remains the only channel a contract observes a
    // response through. At/above it execute.js pre-loads this contract's
    // fulfilled responses (getAttestationDataForVM) into the snapshot and
    // getResponse() returns { status, payload, providerId, blockIndex,
    // validatorCount } for any prior fulfilled request from the SAME contract.
    // Gated as its own consensus rule because it adds a NEW read source to the
    // VM: a contract that branches on getResponse() sees null on a legacy node
    // and a populated object on an upgraded node, forking a heterogeneous fleet
    // (and the per-block contract_hash, since the divergent branch writes
    // different state) on the first getResponse-reading contract. Keyed on
    // block_TIME and armed at the ratified coordinated anchor 1786060800
    // (2026-08-07 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort, for
    // the reasons stated at DEPLOY_BASE64_CODE above; a divergent value is a
    // fork. testnet/regtest
    // activate at genesis (no pre-reader history to preserve; the e2e/regtest
    // stack exercises getResponse from block 0).
    ['VM_ATTESTATION_GETRESPONSE', '0.2.0',1786060800,0,0,0,0,0],

    // Synthesized-execution TX_HASH on the injected-callback seam. Four
    // sites inject a system EXECUTE that runs a contract callback (attest.js v1
    // response + v2 expiry, vote.js poll-finalize, xcall.js result); two of them
    // historically omitted TX_HASH, so a contract emitting ATTEST/XCALL from
    // inside its expiry or poll-finalize callback was charged gas for an id the
    // indexer then hard-rejected ('invalid: TX_HASH'), stranding the contract
    // permanently. Below this activation those two sites keep the hashless
    // context (the original behaviour, so a from-genesis mainnet replay stays
    // byte-identical); at/above it every injected context carries a TX_HASH
    // (real when the trigger rode an on-chain tx, else the deterministic
    // sha256('TAG:NETWORK:CHAIN:UNIQUE_ID') synthesis in actions/execContext.js)
    // and execute.js hard-asserts the invariant so a fifth injector site cannot
    // regress the class. Gated as its own consensus rule because the switch is a
    // validity LOOSENING: an ATTEST/XCALL emission every legacy node rejects
    // becomes valid on an upgraded node, so an ungated flip forks a
    // heterogeneous fleet on the first contract that emits from such a callback.
    // Keyed on block_TIME and armed at the ratified coordinated anchor
    // 1786060800 (2026-08-07 00:00:00 UTC), the confirmed 2.0.0 contract-era
    // cohort, for the reasons stated at DEPLOY_BASE64_CODE above; a divergent
    // value is a fork.
    // testnet/regtest activate at genesis (no hashless-callback history to
    // preserve; the e2e/regtest stack exercises the synthesized hash from
    // block 0).
    ['SYNTH_EXEC_TX_HASH', '0.2.0',1786060800,0,0,0,0,0],

    // Dispenser auto-close compares remaining inventory against the
    // PER-UNIT price, not a buyer's aggregate purchase. The legacy check
    // closes the dispenser when GIVE_REMAINING drops below the triggering
    // dispense's total give_amount (multiplier * GIVE_AMOUNT), so a large
    // order shuts a dispenser down early and non-deterministically based on
    // any one buyer's order size, even though enough escrow remains to
    // serve further single-unit buyers. At/above this activation the close
    // fires only when GIVE_REMAINING < the dispenser's per-unit GIVE_AMOUNT
    // (it genuinely cannot serve another unit). Gated as its own consensus
    // rule because the switch changes WHICH BLOCK a DISPENSER_CLOSE system
    // action lands in (different actions/dispenser_statuses rows, hence
    // different consensus block hashes): an ungated flip forks a
    // heterogeneous fleet on the first multi-unit dispense that empties
    // below the aggregate but not the per-unit threshold. Keyed on
    // block_TIME and armed at the ratified coordinated anchor 1786060800
    // (2026-08-07 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort,
    // for the reasons stated at DEPLOY_BASE64_CODE above; a
    // divergent value is a fork. testnet/regtest activate at genesis (no
    // early-close history to preserve; the e2e/regtest stack exercises the
    // per-unit close from block 0).
    ['DISPENSER_CLOSE_PER_UNIT', '0.2.0',1786060800,0,0,0,0,0],

    // Mode B (user PRICE v1 oracle) dispenser settlement prices one TOKEN, not
    // one FILL. Below this activation actions/dispense.js takes the affordable
    // token count straight from utility.reverseOraclePriceMatch and uses it as
    // the FILL multiplier, then credits multiplier x GIVE_AMOUNT tokens, so a
    // dispenser giving N tokens per fill sold every token at 1/N of the price
    // its oracle published. At/above it the affordable token count is divided by
    // GIVE_AMOUNT first, so the published figure is what one token costs.
    //
    // Per-token is the canonical reading, and settlement was the only one of four
    // surfaces disagreeing with it: the protocol docs' Mode A and Mode B examples,
    // the wallet's oracle publishing form ("Price of one <TICK> in <FIAT>") and the
    // oracle-fee base all state the per-token price. That last one is money: the
    // fee is FEE x (oracle_price x GIVE_ESCROW) / coin_price, which is only the
    // projected proceeds if one dispense costs oracle_price x GIVE_AMOUNT, so
    // pre-activation an oracle at GIVE_AMOUNT 5 is PAID on five times what the
    // dispenser can actually take in.
    //
    // Gated as its own consensus rule because the switch changes the token
    // amount a settled dispense credits (different dispenses/credits/escrow
    // rows, hence different consensus block hashes): an ungated flip forks a
    // heterogeneous fleet on the first Mode B dispense against a dispenser whose
    // GIVE_AMOUNT is not 1. At GIVE_AMOUNT 1 the two readings coincide exactly,
    // which is why every documented example and every test before 2026-07-31
    // missed it.
    //
    // Keyed on block_TIME like the sibling dispenser rules. Minted at its own
    // future instant rather than reusing the contract-era anchor for the reason
    // CONTRACT_DELEGATION_MATERIALIZE states above: that anchor is already in
    // the past, and a retroactive boundary makes a from-genesis replay credit
    // different balances than the live fleet settled. It shares
    // CONTRACT_DELEGATION_MATERIALIZE's already-ratified post-contract-era
    // instant (2026-09-15 00:00:00 UTC) rather than inventing a second date;
    // mainnet is economically pre-launch, so this may be repinned EARLIER at any
    // time provided the value is still in the future when the last indexer and
    // sync process finishes deploying. Every indexer and sync process must carry
    // this gate before mainnet crosses it; a divergent value is a fork.
    // testnet/regtest activate at genesis (the per-fill reading has no history
    // worth preserving there, and the regtest stack is where the defect was
    // measured).
    ['DISPENSER_ORACLE_PER_TOKEN_PRICE', '0.2.0',1789430400,0,0,0,0,0],

    // Cross-chain royalty enforcement, layered on CONTROLLER_GUARD. Once the guard
    // produces royalty payout_legs (post-CONTROLLER_GUARD), a CROSS-CHAIN listing of
    // a royalty-bearing token needs its legs applied on the PROCEEDS chain, which
    // only a fleet that carries legs in the validator-signed match canonical can do.
    // Below this activation such a listing is DENIED at create ('royalty not
    // enforceable cross-chain', fail-closed: accepting it would silently evade the
    // royalty); at/above it the listing is accepted after every leg address proves
    // re-encodable to GET_COIN (Utility.canReencodeAddress), and the legs travel in
    // the signed match for settlement-time application. Same-chain royalties and
    // leg-less cross-chain listings are unaffected either side of the flag. This
    // entry gates the CREATE-side acceptance rule (local block, like any acceptance
    // rule); the match-canonical format flip is keyed on the BTC-anchored
    // snapshot_block via the twin-module pattern (see the STAKE_WEIGHTED_QUORUM note
    // below), NOT this entry. The mainnet timestamp is CONFIRMED (2026-07-07,
    // re-anchored the same day when the contract-era cohort moved to 2026-08-07) at
    // 2027-01-01 00:00:00 UTC, on its own date months AFTER the CONTROLLER_GUARD
    // flag-day: the deny window between the two dates is the safe interim while the
    // fleet upgrades to legs-in-canonical. The canonical partner is ARMED at BTC anchor
    // 961000 (~2026-08-04), months before this date, satisfying the canonical-first
    // ordering; if the CONTROLLER_GUARD cohort moves again, re-decide this date
    // deliberately, keeping a deny window after the cohort and never placing it before
    // the canonical partner; a wrong value is a fork. testnet/regtest activate at genesis so the
    // propagate+apply path is exercisable from block 0; regtest accepts an env
    // override (a future activation time) so the OFF/deny path stays drillable on a
    // single-node regtest stack. The override is regtest-only ON PURPOSE: two
    // regtest nodes with different overrides fork each other, which is fine for a
    // one-node drill and unacceptable anywhere else.
    ['CROSS_CHAIN_ROYALTY', '0.2.0',1798761600,0,ccRoyaltyRegtestTime,0,0,0],

    // REST_PATTERN_METER: the deploy half of the rest-destructuring metering change.
    // A rest destructure (`{...c}`, `[...c]`) copies O(n) at a flat __gas(1) today, so
    // the allocator meter cannot see it. The VM half wraps a TOP-LEVEL rest's source
    // expression in the size-charged helper; the positions that have no addressable
    // source (rest PARAMETER, NESTED rest, CATCH-clause rest) cannot be metered at all
    // and are rejected here at deploy instead, which is what closes the class rather
    // than narrowing it.
    //
    // The instant is the VM's REST_PATTERN_METER_GATE_BLOCK_TIME literal and the two
    // are pinned to equality by consensus-params suites in BOTH repos: a repin that
    // edits one and misses the other passes both CIs and forks the fleet at activation,
    // so this third argument stays an inline literal the guard's regex can read.
    //
    // It deliberately does NOT ride the contract-era flag day (1786060800, 2026-08-07):
    // that instant is in the PAST, and reusing it would retroactively re-price every
    // rest destructure already executed and rewrite settled gasUsed on replay. It takes
    // its own FUTURE instant, shared with CROSS_CHAIN_ROYALTY above so the fleet has one
    // coordination event rather than two. testnet and regtest activate at genesis,
    // matching the VM's isRestPatternMeterActive, which returns true on both
    // unconditionally; measured 2026-09-09, no deployed contract on any chain uses rest
    // syntax (0 mainnet contracts; 12 on TBTC, none containing `...` outside a comment),
    // so arming testnet at genesis reinterprets no accepted deploy.
    ['REST_PATTERN_METER', '0.2.0',1798761600,0,0,0,0,0],

    // Async/Promise contract surface (VM CONSENSUS_VERSION '2'). Below this
    // activation the on-chain deploy validator (validateSyntax) ACCEPTS a
    // contract that uses async/await or references the global Promise, and the
    // VM executes it with the Promise global present; the original pre-2.x.y
    // behaviour. At/above it the deploy validator REJECTS such a contract
    // (CODE_ENCODING: banned async surface) and the sandbox strips the Promise
    // global at execution. Gated as its own consensus rule because the change
    // flips both a deploy verdict (the resolved status string is hashed into the
    // block, and the contract's registration/non-registration is hashed state)
    // and an execution result (a Promise-referencing contract gets a different
    // gasUsed/status/emission set → contract_hash → federation checkpoint
    // preimage): an ungated flip forks a heterogeneous fleet on the first such
    // DEPLOY/EXECUTE, and a from-genesis replay on a new build would otherwise
    // produce a different verdict than the original live processing. The indexer
    // threads the resolved activation into vm.validateSyntax(code, {enforceBannedAsync})
    // (deploy.js); the matching execution-side Promise strip is gated VM-side on
    // the same flag-day (xchain-vm ASYNC_SURFACE_GATE_BLOCK_TIME). Keyed on
    // block_TIME (not block_index), mirroring DEPLOY_BASE64_CODE: DEPLOY/EXECUTE
    // run on BTC, LTC and DOGE whose heights diverge by millions of blocks, so no
    // single shared block height names one cutover across all three chains, but a
    // single timestamp does. The mainnet timestamp is the same coordinated
    // contract-era flag-day as the other consensus fixes in this window
    // (2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07), aligned with the fleet
    // upgrade before any async/Promise-relevant DEPLOY is broadcast to
    // mainnet; a wrong value is a fork. testnet/regtest activate at genesis (no
    // pre-activation history to preserve; the e2e/regtest stack has run with the
    // rule live, so genesis activation preserves its current behaviour).
    ['VM_BANNED_ASYNC', '0.2.0',VM_BANNED_ASYNC_MAINNET_TIME,0,0,0,0,0],

    // VM deploy-linter hardening: one gate for the
    // six hardened lint-core rules (exponentiation `**`/`**=` ban, reserved
    // CONTRACT_WRAPPER control bindings, SAFE_MATH-complement Math ban,
    // dynamic import() rejection, shorthand `{ Promise }` rejection, and the
    // shadowed-local Promise relaxation), plus the VM's gated wrapper
    // closure move and corroborated error classifier. Deploy verdicts are
    // consensus: below the activation a deploy resolves exactly as it did
    // historically; deploy.js threads the resolved activation into
    // vm.validateSyntax(code, {enforceLintHardening}). Armed at the ratified
    // contract-era anchor, the SAME instant VM_BANNED_ASYNC activates (zero
    // partially-hardened window); the literal timestamp is pinned by
    // test/unit/flagdayPlaceholderGuard.test.js. testnet/regtest activate at
    // genesis (no pre-activation history to preserve). A divergent value is
    // a fork.
    ['VM_LINT_HARDENING', '0.2.0',1786060800,0,0,0,0,0],

    // ISSUE validity: strict LOCK_MAX_SUPPLY guard. Before this activation the guard used
    // a truthy check, so an explicit LOCK_MAX_SUPPLY=0 field (a no-op lock intent with no
    // cap declared) incorrectly triggered the 'invalid: LOCK_MAX_SUPPLY (no max supply)'
    // outcome. After activation the guard requires LOCK_MAX_SUPPLY==1, matching the field's
    // intended semantics. Gated so a heterogeneous fleet and any from-genesis replay all
    // switch at the same block: mainnet pins the same coordinated contract-era flag-day
    // as the sibling ISSUE/SLEEP validity gates below (2026-08-07 00:00:00 UTC) - a
    // mainnet_time of 0 would flip the verdict on binary version alone, forking a skewed
    // fleet on any ISSUE carrying an explicit LOCK_MAX_SUPPLY=0 and diverging a
    // from-genesis replay. testnet/regtest activate at genesis (all zeros).
    ['LOCK_MAX_SUPPLY_EXACT', '0.2.0',1786060800,0,0,0,0,0],

    // ISSUE validity: a NULL/absent prior lock value counts as UNSET.
    // getTokenInfo rebuilds token state by replaying the `issues` rows and SKIPS a
    // column that is NULL, so a token whose genesis ISSUE simply omitted the lock
    // fields (the create-time "don't lock anything" path, and 108 of 109 ticks on the
    // BTC regtest venue) reaches isValidLock with an UNDEFINED prior. Every comparison
    // there is loose-equality against '' / value / 0, and `undefined` matches none of
    // them, so the function fell through to false and issue.js reported
    // "invalid: <FIELD> (locked)" for a flag that had never been locked. Net effect:
    // a later LOCK was impossible for effectively every token, the create-time
    // checkbox was the only way a token ever became locked, each attempt burned a
    // protocol fee on a guaranteed-invalid action, and the refusal text asserted the
    // opposite of the truth. After activation an unset prior is treated exactly like
    // the '' prior the function already accepted, so an owner can freeze
    // supply/description/mint after launch. Locking stays one-way: a prior of 1 is
    // still refused a move to 0 on both sides of the gate.
    //
    // UNGATED as of the pre-launch redesign (spec §0). This rule was built under the
    // v1 three-key train and registered on its Key A block TIME (1796083200 =
    // 2026-12-01), because it CHANGES WHICH ACTIONS ARE VALID: an ungated flip on a
    // LIVE network would accept an ISSUE that peers on the old binary reject, forking
    // a heterogeneous fleet, and would break from-genesis replay byte-identity for any
    // historical LOCK that committed 'invalid'.
    //
    // Both of those hazards are what the redesign's mandatory fleet-wide
    // wipe-and-replay rebase removes: the platform has not launched, every byte of
    // derived state is operator-owned, no service keeps pre-batch derived state
    // through the window, and every node replays from genesis under these rules. With
    // no old prefix to preserve and no mixed fleet to straddle, the flag day protects
    // nothing and only costs a divergence risk of its own (a node that replays before
    // the date and one that replays after would disagree). So the gate is removed
    // rather than moved, per spec §0 "Fixes ship plain".
    //
    // The rule is applied to PRIOR STATE, not to issuance date, so on replay every
    // token with an unset lock prior becomes lockable regardless of when it was
    // issued: no reconciliation pass and no per-token grandfathering. Locking stays
    // one-way (a prior of 1 is still refused a move to 0). Any historical LOCK whose
    // verdict flips from 'invalid' to 'valid' on replay surfaces in the §3.1
    // snapshot diff and is adjudicated in the deploy report, which is exactly the
    // mechanism the redesign put there for this class of change.
    ['LOCK_NULL_PRIOR_UNSET', '0.2.0',0,0,0,0,0,0],
];
