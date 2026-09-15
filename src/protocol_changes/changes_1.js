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
 * Time table part 1 of 4: ADDRESS through VOTE_RESPECTS_SLEEP.
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

module.exports = [
    // Define `ACTION` commands and activation time/blocks (ALL UPPER case)
    ['ADDRESS',    '0.1.0',0,0,0,0,0,0],
    ['AIRDROP',    '0.1.0',0,0,0,0,0,0],
    ['BATCH',      '0.1.0',0,0,0,0,0,0],
    ['BET',        '0.1.0',0,0,0,0,0,0],
    ['BROADCAST',  '0.1.0',0,0,0,0,0,0],
    ['CALLBACK',   '0.1.0',0,0,0,0,0,0],
    ['DESTROY',    '0.1.0',0,0,0,0,0,0],
    ['DISPENSER',  '0.1.0',0,0,0,0,0,0],
    ['DIVIDEND',   '0.1.0',0,0,0,0,0,0],
    ['DISPENSE',   '0.1.0',0,0,0,0,0,0],
    ['FILE',       '0.1.0',0,0,0,0,0,0],
    ['ISSUE',      '0.1.0',0,0,0,0,0,0],
    ['LINK',       '0.1.0',0,0,0,0,0,0],
    ['LIST',       '0.1.0',0,0,0,0,0,0],
    ['MESSAGE',    '0.1.0',0,0,0,0,0,0],
    ['MINT',       '0.1.0',0,0,0,0,0,0],
    ['ORDER',      '0.1.0',0,0,0,0,0,0],
    ['SEND',       '0.1.0',0,0,0,0,0,0],
    ['SLEEP',      '0.1.0',0,0,0,0,0,0],
    ['SWAP',       '0.1.0',0,0,0,0,0,0],
    ['SWEEP',      '0.1.0',0,0,0,0,0,0],
    ['COINPAY',        '0.1.0',0,0,0,0,0,0],
    ['COINPAY_EXPIRE', '0.1.0',0,0,0,0,0,0],

    // VM actions (all chains). DEPLOY covers inline (v0/v1), chunked-assemble
    // (v2/v3), and the chunk carrier (v4): all gated under this one entry.
    ['DEPLOY',             '0.2.0',0,0,0,0,0,0],
    ['EXECUTE',            '0.2.0',0,0,0,0,0,0],
    ['DEPOSIT',            '0.2.0',0,0,0,0,0,0],
    ['WITHDRAW',           '0.2.0',0,0,0,0,0,0],

    // Inline DEPLOY (v0/v1) CODE_ENCODING format. Below this activation the inline
    // contract source is decoded as HEX (the original format); at/above it as BASE64
    // (1.33x the source vs hex's 2x, and base64's alphabet has no '|' so it stays safe
    // in the pipe-delimited action string). Gated so a heterogeneous fleet and any
    // from-genesis replay decode every historical inline DEPLOY identically: an ungated
    // flip silently re-reads every hex-era DEPLOY as base64, which changes its code_hash
    // → the per-block contract_hash → the federation checkpoint preimage, forking the
    // ledger. Keyed on block_TIME (not block_index) on purpose: DEPLOY runs on BTC, LTC
    // and DOGE, whose heights diverge by millions of blocks, so no single shared block
    // height can name one coordinated cutover across all three chains, but a single
    // timestamp can. testnet/regtest activate at genesis (base64-native; no pre-base64
    // history to preserve, and the e2e/regtest stack deploys base64 from block 0).
    // The mainnet timestamp below is the coordinated contract-era flag-day:
    // 1786060800 == 2026-08-07 00:00:00 UTC, aligned with
    // the SDK base64 rollout. It must stay equal to every other 2.0.0
    // contract-era entry in this file and to xchain-vm's
    // ASYNC_SURFACE_GATE_BLOCK_TIME; a wrong value is a second fork.
    ['DEPLOY_BASE64_CODE', '0.2.0',1786060800,0,0,0,0,0],

    // Staking actions: capability variants (STAKE v1/v2, UNSTAKE v0, DELEGATE v0/v2, COLLECT) are BTC-only;
    // contract variants (STAKE v3, UNSTAKE v1, DELEGATE v1/v3) work on any chain
    ['STAKE',              '0.2.0',0,0,0,0,0,0],
    ['UNSTAKE',            '0.2.0',0,0,0,0,0,0],
    ['DELEGATE',           '0.2.0',0,0,0,0,0,0],
    ['COLLECT',            '0.2.0',0,0,0,0,0,0],
    // SLASH: permissionless capability-stake equivocation slashing (WI-2 bump 2). The
    // verifier only ACCEPTS proofs whose two messages carry the EQUIV header, so slashing
    // is naturally inert until the EQUIV flag-day (no coupling with the SLASH protocol gate).
    ['SLASH',              '0.2.0',0,0,0,0,0,0],

    // PRICE action: validator oracle (v0) and user oracle (v1) pricing
    // Publishable on any chain (DOGE recommended for low fees)
    ['PRICE',              '0.2.0',0,0,0,0,0,0],

    // VOTE action: token-weighted governance polls. Single action with
    // v0=create poll, v1=cast ballot (v2=system finalize is Phase 2).
    // Genesis-active here for regtest/testnet prototyping; mainnet gets a
    // coordinated flag-day timestamp before BTC activation.
    // (See xchain-documentation/protocol/actions/VOTE.md)
    ['VOTE',               '0.2.0',0,0,0,0,0,0],

    // External attestation framework: single ATTEST action with v0=request, v1=response, v2=expire
    // (See xchain-documentation/protocol/actions/ATTEST.md)
    ['ATTEST',             '0.2.0',0,0,0,0,0,0],

    // ANCHOR: DOGE-only on-chain state commitments: v0=checkpoint,
    // v1=checkpoint+match archive, v2=archive continuation
    // (See xchain-documentation/protocol/actions/ANCHOR.md)
    ['ANCHOR',             '0.2.0',0,0,0,0,0,0],

    // Cross-chain contract calls: XCALL v0=request (VM-emission-only; never
    // decoded from the wire), v2=expire (system-synthesized). The relay rows
    // ride the hub mirror; registered for consistency/documentation.
    // (See xchain-documentation/protocol/actions/XCALL.md)
    ['XCALL',              '0.2.0',0,0,0,0,0,0],

    // NODEPROOF: full-node possession-proof verdict (v0; validator-broadcast).
    // Records which validators answered the derived possession challenge, so the
    // verified set earns the full-node oracle-round reward tranche. BTC-only.
    // (See xchain-documentation/protocol/actions/NODEPROOF.md)
    ['NODEPROOF',          '0.2.0',0,0,0,0,0,0],

    // ROLLCALL: validator liveness presence proofs (v0; validator-broadcast).
    // Inverts its NODEPROOF neighbour above: DOGE-only, because that is where
    // every validator can already publish. Carries a BTC epoch height and is
    // proved BTC-side at the epoch close. Registered at all-zero columns like
    // every other action: the per-network HEIGHT gate is ROLLCALL_ACTIVATION in
    // rollcall_activation.js, not this registry, so mainnet stays inert here.
    // (See xchain-documentation/protocol/actions/rollcall.md)
    ['ROLLCALL',           '0.2.0',0,0,0,0,0,0],

    // XBRIDGE: cross-chain lock/burn/settle, one action across six versions
    // (v0/v1 lock/burn XCHAIN, v2 settle XCHAIN, v3/v4 lock/burn a token,
    // v5 settle a token). Registered at all-zero columns like every other
    // action: the real HEIGHT gates are XCHAIN_BRIDGE_ACTIVATION (v0-v2,
    // xchain_bridge_activation.js, keyed '<COIN>:<network>' because the three
    // chains arm at three heights) and TOKEN_BRIDGE_ACTIVATION (v3-v5,
    // token_bridge_activation.js, keyed per network), not this registry, so
    // mainnet stays inert here until those are armed.
    // (See xchain-documentation/protocol/actions/xbridge.md)
    ['XBRIDGE',            '0.2.0',0,0,0,0,0,0],

    ['UNIFIED_FEES',   '0.2.0',0,0,0,0,0,0],
    // INVENTORY-ONLY, gates nothing. Nothing calls
    // isEnabled('VM_ACTIONS'): the VM actions it nominally covered
    // (DEPLOY/EXECUTE/DEPOSIT/WITHDRAW) are gated by their own '2.0.0' action
    // registrations above and dispatched directly from actions.processAction.
    // Kept declared, not deleted, because the cross-repo action-manifest prose
    // cites it by name as the canonical example of a non-action feature gate.
    // Genesis-active (all-zero), so there is no enablement hazard either way;
    // do NOT wire a consumer to it without a flag-day, since flipping a
    // genesis-active gate into a real one changes replay.
    ['VM_ACTIONS',     '0.2.0',0,0,0,0,0,0],
    // Cross-chain DEX gate: when enabled, ORDER/SWAP allow GET_COIN != COIN and the
    // xchain-hub federation drives cross-chain matching + mirror-delivered settlement.
    // Genesis-activated (pre-launch).
    ['CROSS_CHAIN_DEX','0.2.0',0,0,0,0,0,0],
    // Origin-standing dispenser creates: the SOURCE of a prior VALID
    // dispenser create on GET_ADDRESS (its "origin") may open additional
    // dispensers on that address without the freshness check or
    // DISPENSER_PREFERENCE=2. Completes the one-main-address-managing-
    // many-dispenser-addresses pattern (origin already holds permanent
    // refill/close authority via the v1/v2 owner check).
    // Genesis-activated (pre-launch).
    ['DISPENSER_ORIGIN_STANDING','0.2.0',0,0,0,0,0,0],
    // FIAT dispenser settlement: a dispenser carrying FIAT_CODE is priced by
    // reverse price matching rather than by GET_AMOUNT, in either mode
    // (validator PRICE v0 snapshot, or a user PRICE v1 oracle when
    // ORACLE_ADDRESS is set). Below activation a FIAT dispenser cannot settle
    // at all and its dispense records 'invalid: FIAT dispenser pricing not
    // active'; above it, actions/dispense.js runs the reverse match.
    //
    // Genesis-activated (pre-launch), and provably free of replay
    // consequences: retrofitted 2026-07-24 after confirming every mainnet
    // chain holds ZERO dispensers and ZERO dispenses (BTC, LTC and DOGE
    // mainnet indexer DBs all read 0/0/0), so there is no history in which
    // the gated branch was ever taken and genesis-on is byte-identical to
    // the ungated code it replaces.
    //
    // Registered for two reasons even though it is on everywhere today.
    // First, inventory: every sibling dispenser rule is gated
    // (dispenser_caps, dispenser_freshness, dispenser_ownership_cancel,
    // DISPENSER_CLOSE_PER_UNIT, DISPENSER_ORIGIN_STANDING) and a
    // consensus-affecting settlement path that appears in no activation map
    // is invisible to the flag-day tooling. Second, and the reason to do it
    // now rather than later: any future correction to the matching algorithm
    // needs a gate to hang a height off, and once a mainnet FIAT dispenser
    // exists that retrofit costs a cohort height plus a replay-compatibility
    // branch. Doing it while the set is empty costs nothing (an earlier
    // dispenser-unit correction already demonstrated the shape this will need).
    ['FIAT_DISPENSER_PRICING','0.2.0',0,0,0,0,0,0],
    // Issuance fee activation. Mainnet turns on at the historical block 862633;
    // testnet/regtest charge from block 0 so the fee path is exercisable there.
    // mainnet_block=862633 is a BTC block height used as an 'always-on' activation
    // for LTC and DOGE (both passed this height long ago). This is intentional legacy
    // behaviour. A single cross-chain activation height is chosen from BTC; see
    // xchain-documentation/protocol/CONFIGURATION.md for the rationale.
    ['ISSUANCE_FEE',   '0.1.0',0,0,0,862633,0,0],
    // VM-emitted ISSUE (IS_EMISSION) issuance-fee exemption. A contract
    // constructor (or EXECUTE) that emits an ISSUE has no XCHAIN balance on the
    // freshly deployed contract address, so charging ISSUANCE_FEE against the
    // emitted ISSUE fails fee validation and reverts the constructor, so the
    // deployer already paid the DEPLOY/EXECUTE gas (base + per-byte + per-
    // emission), so the emitted ISSUE is fee-exempt. Gated as its own
    // consensus rule so the change in fee behaviour switches over at a
    // coordinated flag-day rather than implicitly the moment a node upgrades:
    // an ungated flip charges the fee on one node version and exempts it on
    // another at the SAME block, forking the ledger and the contract-state
    // checkpoint on the first constructor that emits an ISSUE. Keyed on
    // block_TIME (not block_index), mirroring DEPLOY_BASE64_CODE. Emitted
    // ISSUEs ride DEPLOY/EXECUTE, which run on BTC, LTC and DOGE whose heights
    // diverge by millions of blocks, so no single shared block height names one
    // cutover across all three chains, but a single timestamp does. The mainnet
    // timestamp is the same coordinated contract-era flag-day as the base64
    // rollout (2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07), aligned with the
    // other contract-deploy consensus fixes shipping in this window; a wrong
    // value is a second fork.
    // testnet/regtest activate at genesis (no pre-exemption history to preserve;
    // the e2e/regtest stack exercises VM emissions from block 0).
    ['ISSUANCE_FEE_EMISSION_EXEMPT', '0.2.0',1786060800,0,0,0,0,0],

    // VM getBalance()/getTokenInfo() reader. Below this activation the gateway
    // receives balances:null / tokenInfo:null in every execution path (the
    // original VM behaviour through 2.7.10); at/above it the indexer feeds the
    // deterministic buildVmBalancesAndTokenInfo snapshot scoped to SOURCE + the
    // contract's derived address. Gated as its own consensus rule because the
    // accessor is a NEW VM input: the first contract that calls getBalance or
    // getTokenInfo computes different gas_used, emitted_count, and ledger
    // movements on a node that feeds real balances vs one that still passes
    // null: an ungated flip forks the contract_hash (and the federation
    // checkpoint preimage) the moment a balance-reading contract executes, even
    // within the 2.x line (2.2.0–2.7.10 lack the reader; 2.7.11+ have it).
    // Keyed on block_TIME (not block_index), mirroring DEPLOY_BASE64_CODE and
    // ISSUANCE_FEE_EMISSION_EXEMPT. DEPLOY/EXECUTE run on BTC, LTC and DOGE
    // whose heights diverge by millions of blocks, so no single shared block
    // height names one cutover across all three chains, but a single timestamp
    // does. The mainnet timestamp is the same coordinated contract-era flag-day
    // as the other contract-deploy consensus fixes in this window (2026-08-07
    // 00:00:00 UTC, CONFIRMED 2026-07-07); a wrong value is a fork. testnet/regtest
    // activate at genesis (no pre-reader history to preserve; the e2e/regtest
    // stack exercises VM balance reads from block 0).
    ['VM_BALANCE_TOKENINFO', '0.2.0',1786060800,0,0,0,0,0],

    // Programmable-policy controller guard. Below this activation the bound
    // controller's `guard` method is NEVER run: every SEND/ORDER/SWAP/DISPENSER/
    // DESTROY on a controller-bound token settles with its plain (un-guarded)
    // semantics, no allow/deny veto, no royalty/fee payout_legs written, and no
    // guard contract_executions row, exactly as a node that lacks the controller
    // layer behaves. At/above it the shared chokepoint (_invokeController in
    // utility.js) runs the guard, may DENY the action, and may attach payout_legs
    // that the match-time proceeds split applies. Gated as its own consensus rule
    // because the guard is a NEW, ungated acceptance + ledger rule: a node version
    // with the controller layer and one without it process the SAME guarded action
    // differently (one allows/redirects funds, the other settles plainly), forking
    // the ledger AND the per-block contract_hash (guard emissions now write a guard
    // contract_executions row, so they contribute to the checkpoint preimage) on the
    // first guarded action. A single flag-day flips the whole surface: VM execution,
    // payout_legs write, match-time applyProceedsSplit, and the contract_hash
    // contribution, atomically across all nodes. Keyed on block_TIME (not
    // block_index), mirroring DEPLOY_BASE64_CODE / ISSUANCE_FEE_EMISSION_EXEMPT /
    // VM_BALANCE_TOKENINFO. Guarded actions run on BTC, LTC and DOGE whose heights
    // diverge by millions of blocks, so no single shared block height names one
    // cutover across all three chains, but a single timestamp does. The mainnet
    // timestamp is the same coordinated contract-era flag-day as the other
    // contract-era consensus fixes in this window (2026-08-07 00:00:00 UTC,
    // CONFIRMED 2026-07-07), aligned with the operator fleet upgrade before any
    // CONTROLLER-bound token is issued on mainnet; a wrong value is a fork. testnet/regtest activate
    // at genesis (no pre-guard history to preserve; the e2e/regtest stack exercises
    // controller guards from block 0).
    ['CONTROLLER_GUARD', '0.2.0',1786060800,0,0,0,0,0],

    // MINT-1: per-address mint allowance counts SELF-MINTED supply only.
    // Below this activation the MINT_ADDRESS_MAX check measures MINT-action
    // credits to SOURCE (the original behaviour), which also counts tokens the
    // address merely RECEIVED as another mint's DESTINATION, so a griefer can
    // exhaust any address's allowance by gifting minted supply to it. At/above
    // it the check measures the mints table by the action's SOURCE (only mints
    // the address itself authored count). Gated as its own consensus rule
    // because the fix is a validity LOOSENING: a MINT that historical processing
    // rejected ('mint exceeds MINT_ADDRESS_MAX' because of received supply)
    // becomes valid under the new measure, so an ungated flip forks a
    // heterogeneous fleet on the first such mint and breaks from-genesis replay
    // byte-identity. Keyed on block_TIME and armed at the ratified coordinated
    // anchor 1786060800 (2026-08-07 00:00:00 UTC), the confirmed 2.0.0
    // contract-era cohort, for the reasons stated at DEPLOY_BASE64_CODE above;
    // a divergent value is a fork.
    // testnet/regtest activate at genesis (no history to preserve; the
    // e2e/regtest stack exercises the corrected measure from block 0).
    ['MINT_SELF_MINTED_ONLY', '0.2.0',1786060800,0,0,0,0,0],

    // BonkDAO-class guard: a BINDING poll (VOTE v0 that names a
    // CALLBACK_CONTRACT, so its finalization can move contract-held value)
    // must set its own turnout floor: QUORUM required, MIN_VOTERS >= 1
    // required. Without them a treasury-binding poll with the default
    // 'balance' weighting is exactly the 2026-07 BonkDAO drain: an attacker
    // buys a sliver of supply, proposes, and passes it alone while nobody
    // is watching. Signaling polls
    // (blank CALLBACK_CONTRACT) stay permissive. Gated as its own consensus
    // rule because the requirement is a validity TIGHTENING: a v0 create
    // that historical processing accepted becomes invalid, so an ungated
    // flip forks a heterogeneous fleet on the first such poll and breaks
    // from-genesis replay byte-identity. Keyed on block_TIME and armed at
    // the ratified coordinated anchor 1786060800 (2026-08-07 00:00:00 UTC),
    // the confirmed 2.0.0 contract-era cohort, for the reasons stated at
    // DEPLOY_BASE64_CODE above; a divergent value is
    // a fork. testnet/regtest activate at genesis (no history to preserve;
    // the e2e/regtest stack exercises the requirement from block 0).
    ['VOTE_BINDING_MINIMUMS', '0.2.0',1786060800,0,0,0,0,0],

    // BonkDAO lesson 3: optional timelock between poll finalization
    // and the binding callback's execution. v0 gains a trailing
    // CALLBACK_DELAY_BLOCKS field: when set (> 0), the v2 finalize freezes
    // the tally and settles the deposit as always but DEFERS the callback
    // EXECUTE to resolved_block + delay (stamped as polls.callback_due_block,
    // fired by the per-block sweep), giving holders and guardians a reaction
    // window between a hostile pass and the value actually moving. Below the
    // activation the field is IGNORED (parsed but nulled, exactly how a
    // legacy node's setActionParams drops params beyond its format), so
    // acceptance and callback timing stay byte-identical to old nodes.
    // Gated as its own consensus rule because honoring the field changes
    // WHICH BLOCK the callback EXECUTE lands in (different actions rows,
    // contract_hash, checkpoint preimage): an ungated flip forks a
    // heterogeneous fleet on the first delayed poll. Keyed on block_TIME
    // and armed at the ratified coordinated anchor 1786060800
    // (2026-08-07 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort,
    // for the reasons stated at DEPLOY_BASE64_CODE above; a divergent
    // value is a fork. testnet/regtest activate at
    // genesis (no history to preserve; the e2e/regtest stack exercises the
    // timelock from block 0).
    ['VOTE_CALLBACK_TIMELOCK', '0.2.0',1786060800,0,0,0,0,0],

    // VOTE-SLEEP-1: VOTE respects the self-sleep gate. SLEEP v0
    // freezes an address ("pauses actions on an ADDRESS") and every sibling
    // governance/content handler (list/link/broadcast/message/file/address)
    // rejects a sleeping SOURCE via isActionAllowed, but VOTE never checked
    // it: a self-slept address could still create and fund polls (v0 moves
    // GAS into escrow), cast ballots (v1) and set delegations (v3) during
    // its own freeze window. At/after this activation all three
    // user-broadcast VOTE versions reject a sleeping SOURCE with
    // 'invalid: SOURCE (sleeping)'; v2 finalize is system-synthesized and
    // stays exempt. The same activation also makes v3 validate a set
    // (non-blank) DELEGATE_TO with isCryptoAddress, matching
    // MESSAGE/DISPENSER address handling (before, a malformed target was
    // accepted and simply resolved to no holder at tally time). Gated
    // because both checks TIGHTEN validity on a genesis-active action (a
    // VOTE that was valid becomes invalid), so an ungated flip forks a
    // heterogeneous fleet and diverges a from-genesis replay; mirrors
    // SLEEP_RESPECTS_LOCK_SLEEP. Keyed on block_TIME at the ratified
    // coordinated anchor 1786060800 (2026-08-07 00:00:00 UTC), the
    // confirmed 2.0.0 contract-era cohort; a divergent value is a fork.
    // testnet/regtest activate at genesis.
    ['VOTE_RESPECTS_SLEEP', '0.2.0',1786060800,0,0,0,0,0],
];
