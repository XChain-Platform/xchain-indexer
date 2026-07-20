/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Indexer - Protocol Changes Class
 * 
 * This file defines all the supported actions and protocol changes
 *
 ********************************************************************/

// VM async/Promise flag-day, single source of truth for the cross-repo coupling
// guard. This MUST stay byte-identical to xchain-vm's ASYNC_SURFACE_GATE_BLOCK_TIME;
// a one-sided edit forks the fleet on the first async-using DEPLOY/EXECUTE after the
// earlier of the two timestamps. consensus-params.test.js asserts the two are equal.
const VM_BANNED_ASYNC_MAINNET_TIME = 1790812800;

// H-3 flag-day: deterministic (time-gated) price_snapshots selection for
// native-coin fee validation on non-reference chains (see the
// NATIVE_FEE_PRICE_TIME_GATE registration below). Same coordinated 2.0.0
// contract-era timestamp as the other flag-days; a divergent value forks the
// fleet on the first fee-bearing LTC/DOGE action after the earlier timestamp.
const NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME = 1790812800;

// Single shared predicate for the NATIVE_FEE_PRICE_TIME_GATE flag-day, used by
// utility.getFeeOraclePrices (query selection) and XChainIndexer (sync
// barrier) so the two can never gate differently. Semantics match the
// registry entry: testnet/regtest active from genesis, mainnet at the
// flag-day; an unknown/empty network is treated like mainnet (conservative:
// requires the flag-day).
function isNativeFeePriceTimeGateActive(network, blockTime){
    if(network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(Number(blockTime)) && Number(blockTime) >= NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME;
}

class ProtocolChanges {

    constructor(indexer){
        this.config    = indexer.config;
        this.util      = indexer.util;
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;

        // XChain Indexer Version and network.
        // Prefer process.env.npm_package_version (set under `npm run …`, and the
        // hook tests inject it to simulate a shipping consensus version), and fall
        // back to package.json when it is absent. A bare `node src/api.js` (Docker
        // entrypoints, one-off debugging) does NOT set the env var, which left
        // this.version undefined and made isEnabled()'s this.version.split('.')
        // throw, rolling back and silently retrying the same block forever; the
        // package.json fallback closes that crash while keeping both production
        // launch paths (npm run / bare node) resolving to the same version.
        this.version = process.env.npm_package_version || require('../package.json').version;
        // Read the network from the validated config (config.getConfig() sets NETWORK after
        // boot rejects an invalid network via coins.getCoinConfig) rather than re-reading the
        // raw process.env.INDEXER_NETWORK. A single validated source keeps the consensus
        // activation gate in isEnabled() aligned with every other config.NETWORK consumer and
        // removes the chance of the two diverging if the env is ever mutated after boot.
        this.network = this.config.NETWORK;

        this.changes = {};
        this.parseChanges();
    }

    parseChanges(){

        // Define `ACTION` commands and activation time/blocks (ALL UPPER case)
        this.addChange('ADDRESS',    '1.0.0',0,0,0,0,0,0);
        this.addChange('AIRDROP',    '1.0.0',0,0,0,0,0,0);
        this.addChange('BATCH',      '1.0.0',0,0,0,0,0,0);
        // this.addChange('BET',        '1.0.0',0,0,0,0,0,0);
        this.addChange('BROADCAST',  '1.0.0',0,0,0,0,0,0);
        this.addChange('CALLBACK',   '1.0.0',0,0,0,0,0,0);
        this.addChange('DESTROY',    '1.0.0',0,0,0,0,0,0);
        this.addChange('DISPENSER',  '1.0.0',0,0,0,0,0,0);
        this.addChange('DIVIDEND',   '1.0.0',0,0,0,0,0,0);
        this.addChange('DISPENSE',   '1.0.0',0,0,0,0,0,0);
        this.addChange('FILE',       '1.0.0',0,0,0,0,0,0);
        this.addChange('ISSUE',      '1.0.0',0,0,0,0,0,0);
        this.addChange('LINK',       '1.0.0',0,0,0,0,0,0);
        this.addChange('LIST',       '1.0.0',0,0,0,0,0,0);
        this.addChange('MESSAGE',    '1.0.0',0,0,0,0,0,0);
        this.addChange('MINT',       '1.0.0',0,0,0,0,0,0);
        this.addChange('ORDER',      '1.0.0',0,0,0,0,0,0);
        this.addChange('SEND',       '1.0.0',0,0,0,0,0,0);
        this.addChange('SLEEP',      '1.0.0',0,0,0,0,0,0);
        this.addChange('SWAP',       '1.0.0',0,0,0,0,0,0);
        this.addChange('SWEEP',      '1.0.0',0,0,0,0,0,0);
        this.addChange('COINPAY',        '1.0.0',0,0,0,0,0,0);
        this.addChange('COINPAY_EXPIRE', '1.0.0',0,0,0,0,0,0);

        // VM actions (all chains). DEPLOY covers inline (v0/v1), chunked-assemble
        // (v2/v3), and the chunk carrier (v4): all gated under this one entry.
        this.addChange('DEPLOY',             '2.0.0',0,0,0,0,0,0);
        this.addChange('EXECUTE',            '2.0.0',0,0,0,0,0,0);
        this.addChange('DEPOSIT',            '2.0.0',0,0,0,0,0,0);
        this.addChange('WITHDRAW',           '2.0.0',0,0,0,0,0,0);

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
        // The mainnet timestamp below is the coordinated contract-era flag-day
        // (2026-10-01 00:00:00 UTC, CONFIRMED 2026-07-07), aligned with the SDK base64
        // rollout; a wrong value is a second fork.
        this.addChange('DEPLOY_BASE64_CODE', '2.0.0',1790812800,0,0,0,0,0);

        // Staking actions: capability variants (STAKE v1/v2, UNSTAKE v0, DELEGATE v0/v2, COLLECT) are BTC-only;
        // contract variants (STAKE v3, UNSTAKE v1, DELEGATE v1/v3) work on any chain
        this.addChange('STAKE',              '2.0.0',0,0,0,0,0,0);
        this.addChange('UNSTAKE',            '2.0.0',0,0,0,0,0,0);
        this.addChange('DELEGATE',           '2.0.0',0,0,0,0,0,0);
        this.addChange('COLLECT',            '2.0.0',0,0,0,0,0,0);
        // SLASH: permissionless capability-stake equivocation slashing (WI-2 bump 2). The
        // verifier only ACCEPTS proofs whose two messages carry the EQUIV header, so slashing
        // is naturally inert until the EQUIV flag-day (no coupling with the SLASH protocol gate).
        this.addChange('SLASH',              '2.0.0',0,0,0,0,0,0);

        // PRICE action: validator oracle (v0) and user oracle (v1) pricing
        // Publishable on any chain (DOGE recommended for low fees)
        this.addChange('PRICE',              '2.0.0',0,0,0,0,0,0);

        // VOTE action: token-weighted governance polls. Single action with
        // v0=create poll, v1=cast ballot (v2=system finalize is Phase 2).
        // Genesis-active here for regtest/testnet prototyping; mainnet gets a
        // coordinated flag-day timestamp before BTC activation.
        // (See xchain-documentation/protocol/actions/VOTE.md)
        this.addChange('VOTE',               '2.0.0',0,0,0,0,0,0);

        // External attestation framework: single ATTEST action with v0=request, v1=response, v2=expire
        // (See xchain-documentation/protocol/actions/ATTEST.md)
        this.addChange('ATTEST',             '2.0.0',0,0,0,0,0,0);

        // ANCHOR: DOGE-only on-chain state commitments: v0=checkpoint,
        // v1=checkpoint+match archive, v2=archive continuation
        // (See xchain-documentation/protocol/actions/ANCHOR.md)
        this.addChange('ANCHOR',             '2.0.0',0,0,0,0,0,0);

        // Cross-chain contract calls: XCALL v0=request (VM-emission-only; never
        // decoded from the wire), v2=expire (system-synthesized). The relay rows
        // ride the hub mirror; registered for consistency/documentation.
        // (See xchain-documentation/protocol/actions/XCALL.md)
        this.addChange('XCALL',              '2.0.0',0,0,0,0,0,0);

        // NODEPROOF: full-node possession-proof verdict (v0; validator-broadcast).
        // Records which validators answered the derived possession challenge, so the
        // verified set earns the full-node oracle-round reward tranche. BTC-only.
        // (See xchain-documentation/protocol/actions/NODEPROOF.md)
        this.addChange('NODEPROOF',          '2.0.0',0,0,0,0,0,0);

        // Define protocol changes (ALL LOWER Case)
        // this.addChange('name','1.0.0',0,0,0,0,0,0);
        this.addChange('UNIFIED_FEES',   '2.0.0',0,0,0,0,0,0);
        this.addChange('VM_ACTIONS',     '2.0.0',0,0,0,0,0,0);
        // Cross-chain DEX gate: when enabled, ORDER/SWAP allow GET_COIN != COIN and the
        // xchain-hub federation drives cross-chain matching + mirror-delivered settlement.
        // Genesis-activated (pre-launch).
        this.addChange('CROSS_CHAIN_DEX','2.0.0',0,0,0,0,0,0);
        // Origin-standing dispenser creates: the SOURCE of a prior VALID
        // dispenser create on GET_ADDRESS (its "origin") may open additional
        // dispensers on that address without the freshness check or
        // DISPENSER_PREFERENCE=2. Completes the one-main-address-managing-
        // many-dispenser-addresses pattern (origin already holds permanent
        // refill/close authority via the v1/v2 owner check).
        // Genesis-activated (pre-launch).
        this.addChange('DISPENSER_ORIGIN_STANDING','2.0.0',0,0,0,0,0,0);
        // Issuance fee activation. Mainnet turns on at the historical block 862633;
        // testnet/regtest charge from block 0 so the fee path is exercisable there.
        // mainnet_block=862633 is a BTC block height used as an 'always-on' activation
        // for LTC and DOGE (both passed this height long ago). This is intentional legacy
        // behaviour. A single cross-chain activation height is chosen from BTC; see
        // xchain-documentation/protocol/CONFIGURATION.md for the rationale.
        this.addChange('ISSUANCE_FEE',   '1.0.0',0,0,0,862633,0,0);
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
        // rollout (2026-10-01 00:00:00 UTC, CONFIRMED 2026-07-07), aligned with the
        // other contract-deploy consensus fixes shipping in this window; a wrong
        // value is a second fork.
        // testnet/regtest activate at genesis (no pre-exemption history to preserve;
        // the e2e/regtest stack exercises VM emissions from block 0).
        this.addChange('ISSUANCE_FEE_EMISSION_EXEMPT', '2.0.0',1790812800,0,0,0,0,0);

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
        // as the other contract-deploy consensus fixes in this window (2026-10-01
        // 00:00:00 UTC, CONFIRMED 2026-07-07); a wrong value is a fork. testnet/regtest
        // activate at genesis (no pre-reader history to preserve; the e2e/regtest
        // stack exercises VM balance reads from block 0).
        this.addChange('VM_BALANCE_TOKENINFO', '2.0.0',1790812800,0,0,0,0,0);

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
        // contract-era consensus fixes in this window (2026-10-01 00:00:00 UTC,
        // CONFIRMED 2026-07-07), aligned with the operator fleet upgrade before any
        // CONTROLLER-bound token is issued on mainnet; a wrong value is a fork. testnet/regtest activate
        // at genesis (no pre-guard history to preserve; the e2e/regtest stack exercises
        // controller guards from block 0).
        this.addChange('CONTROLLER_GUARD', '2.0.0',1790812800,0,0,0,0,0);

        // MINT-1 : per-address mint allowance counts SELF-MINTED supply only.
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
        // byte-identity. Keyed on block_TIME (not block_index), mirroring
        // DEPLOY_BASE64_CODE: MINT runs on BTC, LTC and DOGE whose heights diverge
        // by millions of blocks, so no single shared block height names one cutover
        // across all three chains, but a single timestamp can. The mainnet timestamp
        // is ARMED 2026-07-16  to the ratified coordinated anchor
        // 1790812800 (2026-10-01 00:00:00 UTC), joining the confirmed 2.0.0
        // contract-era cohort; a divergent value is a fork.
        // testnet/regtest activate at genesis (no history to preserve; the
        // e2e/regtest stack exercises the corrected measure from block 0).
        this.addChange('MINT_SELF_MINTED_ONLY', '2.0.0',1790812800,0,0,0,0,0);

        //  (BonkDAO-class guard): a BINDING poll (VOTE v0 that names a
        // CALLBACK_CONTRACT, so its finalization can move contract-held value)
        // must set its own turnout floor: QUORUM required, MIN_VOTERS >= 1
        // required. Without them a treasury-binding poll with the default
        // 'balance' weighting is exactly the 2026-07 BonkDAO drain: an attacker
        // buys a sliver of supply, proposes, and passes it alone while nobody
        // is watching (see claude/reports/learned-knowledge/2026-07-07_bonkdao-
        // governance-attack-low-turnout-treasury-drain.md). Signaling polls
        // (blank CALLBACK_CONTRACT) stay permissive. Gated as its own consensus
        // rule because the requirement is a validity TIGHTENING: a v0 create
        // that historical processing accepted becomes invalid, so an ungated
        // flip forks a heterogeneous fleet on the first such poll and breaks
        // from-genesis replay byte-identity. Keyed on block_TIME (not
        // block_index), mirroring DEPLOY_BASE64_CODE: VOTE runs on BTC, LTC and
        // DOGE whose heights diverge by millions of blocks, so no single shared
        // block height names one cutover across all three chains, but a single
        // timestamp can. The mainnet timestamp is ARMED 2026-07-16  to
        // the ratified coordinated anchor 1790812800 (2026-10-01 00:00:00 UTC),
        // joining the confirmed 2.0.0 contract-era cohort; a divergent value is
        // a fork. testnet/regtest activate at genesis (no history to preserve;
        // the e2e/regtest stack exercises the requirement from block 0).
        this.addChange('VOTE_BINDING_MINIMUMS', '2.0.0',1790812800,0,0,0,0,0);

        //  (BonkDAO lesson 3): optional timelock between poll finalization
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
        // (not block_index), mirroring DEPLOY_BASE64_CODE: VOTE runs on BTC,
        // LTC and DOGE whose heights diverge by millions of blocks, so no
        // single shared block height names one cutover across all three
        // chains, but a single timestamp can. The mainnet timestamp is ARMED
        // 2026-07-16  to the ratified coordinated anchor 1790812800
        // (2026-10-01 00:00:00 UTC), joining the confirmed 2.0.0 contract-era
        // cohort; a divergent value is a fork. testnet/regtest activate at
        // genesis (no history to preserve; the e2e/regtest stack exercises the
        // timelock from block 0).
        this.addChange('VOTE_CALLBACK_TIMELOCK', '2.0.0',1790812800,0,0,0,0,0);

        //  (VOTE-SLEEP-1): VOTE respects the self-sleep gate. SLEEP v0
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
        // previously-valid VOTE becomes invalid), so an ungated flip forks a
        // heterogeneous fleet and diverges a from-genesis replay; mirrors
        // SLEEP_RESPECTS_LOCK_SLEEP. Keyed on block_TIME at the ratified
        // coordinated anchor 1790812800 (2026-10-01 00:00:00 UTC), the
        // confirmed 2.0.0 contract-era cohort; a divergent value is a fork.
        // testnet/regtest activate at genesis.
        this.addChange('VOTE_RESPECTS_SLEEP', '2.0.0',1790812800,0,0,0,0,0);

        //  (BonkDAO lesson 4): expose a poll's electorate TICK to
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
        // (not block_index), mirroring the sibling VOTE flag-days: VOTE runs on
        // BTC, LTC and DOGE whose heights diverge by millions of blocks, so no
        // single shared block height names one cutover across all three chains,
        // but a single timestamp can. The mainnet timestamp joins the ratified
        // coordinated anchor 1790812800 (2026-10-01 00:00:00 UTC), the confirmed
        // 2.0.0 contract-era cohort; a divergent value is a fork. testnet/regtest
        // activate at genesis (no history to preserve; the e2e/regtest stack
        // exercises the visible tick from block 0).
        this.addChange('VOTE_POLL_TICK_VISIBLE', '2.0.0',1790812800,0,0,0,0,0);

        // : ATTEST v1 canonical id-case normalization. Below this activation
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
        // heterogeneous fleet with a single case-mutated replay (the reason the
        // 2026-07-13 inline fix was deferred to this flag-day; see review item
        // #1979). Keyed on block_TIME (not block_index), mirroring
        // DEPLOY_BASE64_CODE: ATTEST rides EXECUTE emissions on BTC, LTC and
        // DOGE, whose heights diverge by millions of blocks, so no single shared
        // block height names one cutover across all three chains, but a single
        // timestamp can. The mainnet timestamp is ARMED 2026-07-16  to
        // the ratified coordinated anchor 1790812800 (2026-10-01 00:00:00 UTC),
        // joining the confirmed 2.0.0 contract-era cohort; a divergent value is
        // a fork. testnet/regtest activate at genesis (no history to preserve;
        // the e2e/regtest stack exercises the self-contained canonical from
        // block 0).
        this.addChange('ATTEST_CANONICAL_LOWERCASE_ID', '2.0.0',1790812800,0,0,0,0,0);

        // : VM xchain.attestation.getResponse(requestId) reader. Below this
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
        // block_TIME (not block_index), mirroring VM_BALANCE_TOKENINFO: EXECUTE runs
        // on BTC, LTC and DOGE whose heights diverge by millions of blocks, so no
        // single shared block height names one cutover across all three chains, but
        // a single timestamp does. The mainnet timestamp joins the ratified
        // coordinated anchor 1790812800 (2026-10-01 00:00:00 UTC), the confirmed
        // 2.0.0 contract-era cohort; a divergent value is a fork. testnet/regtest
        // activate at genesis (no pre-reader history to preserve; the e2e/regtest
        // stack exercises getResponse from block 0).
        this.addChange('VM_ATTESTATION_GETRESPONSE', '2.0.0',1790812800,0,0,0,0,0);

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
        // re-anchored the same day when the contract-era cohort moved to 2026-10-01) at
        // one quarter AFTER the CONTROLLER_GUARD flag-day (2027-01-01 00:00:00 UTC): the
        // deny window between the two dates is the safe interim while the fleet upgrades
        // to legs-in-canonical. The canonical partner is ARMED at BTC anchor 961000
        // (~2026-08-04), months before this date, satisfying the canonical-first
        // ordering; if the CONTROLLER_GUARD cohort moves again, re-anchor this one
        // quarter after it (never before the canonical partner); a wrong value is a
        // fork. testnet/regtest activate at genesis so the
        // propagate+apply path is exercisable from block 0; regtest accepts an env
        // override (a future activation time) so the OFF/deny path stays drillable on a
        // single-node regtest stack. The override is regtest-only ON PURPOSE: two
        // regtest nodes with different overrides fork each other, which is fine for a
        // one-node drill and unacceptable anywhere else.
        let ccRoyaltyRegtestTime = parseInt(process.env.CROSS_CHAIN_ROYALTY_REGTEST_TIME) || 0;
        this.addChange('CROSS_CHAIN_ROYALTY', '2.0.0',1798761600,0,ccRoyaltyRegtestTime,0,0,0);

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
        // (2026-10-01 00:00:00 UTC, CONFIRMED 2026-07-07), aligned with the fleet
        // upgrade before any async/Promise-relevant DEPLOY is broadcast to
        // mainnet; a wrong value is a fork. testnet/regtest activate at genesis (no
        // pre-activation history to preserve; the e2e/regtest stack has run with the
        // rule live, so genesis activation preserves its current behaviour).
        this.addChange('VM_BANNED_ASYNC', '2.0.0',VM_BANNED_ASYNC_MAINNET_TIME,0,0,0,0,0);

        // ISSUE validity: strict LOCK_MAX_SUPPLY guard. Before this activation the guard used
        // a truthy check, so an explicit LOCK_MAX_SUPPLY=0 field (a no-op lock intent with no
        // cap declared) incorrectly triggered the 'invalid: LOCK_MAX_SUPPLY (no max supply)'
        // outcome. After activation the guard requires LOCK_MAX_SUPPLY==1, matching the field's
        // intended semantics. Gated so a heterogeneous fleet and any from-genesis replay all
        // switch at the same block: mainnet pins the same coordinated contract-era flag-day
        // as the sibling ISSUE/SLEEP validity gates below (2026-10-01 00:00:00 UTC) - a
        // mainnet_time of 0 would flip the verdict on binary version alone, forking a skewed
        // fleet on any ISSUE carrying an explicit LOCK_MAX_SUPPLY=0 and diverging a
        // from-genesis replay. testnet/regtest activate at genesis (all zeros).
        this.addChange('LOCK_MAX_SUPPLY_EXACT', '2.0.0',1790812800,0,0,0,0,0);

        // DEPLOY validity: integer COOLDOWN_BLOCKS. Before this activation the staking
        // cooldown was gated only by isNumeric + range, so a fractional value ('50.5')
        // deployed successfully and stored a fractional contracts.cooldown_blocks,
        // violating the documented unsigned-int bound (protocol/Contract_Staking.md
        // DEPLOY v1 field type) and flowing a non-integer COOLDOWN_END_BLOCK into
        // UNSTAKE. After activation the guard requires an integer, matching the
        // EXPIRATION siblings (order/swap/dispenser). Gated so a from-genesis replay
        // reproduces any historic fractional-cooldown accept verdict below the
        // flag-day: mainnet pins the same coordinated contract-era flag-day as the
        // sibling validity gates (2026-10-01 00:00:00 UTC); testnet/regtest activate
        // at genesis (all zeros).
        this.addChange('COOLDOWN_BLOCKS_INTEGER', '2.0.0',1790812800,0,0,0,0,0);

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
        // (2026-10-01 00:00:00 UTC); testnet/regtest activate at genesis (all zeros).
        this.addChange('DEPLOY_SLASH_DEST_ADDRESS_VALID', '2.0.0',1790812800,0,0,0,0,0);

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
        // below the flag-day. mainnet pins the coordinated contract-era flag-day (2026-10-01
        // 00:00:00 UTC); testnet/regtest activate at genesis (all zeros).
        this.addChange('UNSTAKE_CONTRACT_COOLDOWN_STRICT', '2.0.0',1790812800,0,0,0,0,0);

        // ISSUE validity: cumulative MINT_SUPPLY cap. Before this activation the only guard on
        // an ISSUE's MINT_SUPPLY was a single-shot `MINT_SUPPLY > MAX_SUPPLY` check, which
        // ignores supply that already exists: an owner could re-ISSUE the same tick with
        // MINT_SUPPLY repeatedly (LOCK_MINT_SUPPLY unset) and mint fresh supply past MAX_SUPPLY
        // (and past a locked NFT edition size), because MINT_SUPPLY is credited on every valid
        // ISSUE, not just the first. After activation the cap is enforced against
        // SUPPLY + MINT_SUPPLY, matching mint.js's cumulative MAX_SUPPLY invariant (bcadd(SUPPLY,
        // AMOUNT) > MAX_SUPPLY). Gated because it TIGHTENS validity (a previously-valid over-cap
        // re-ISSUE becomes invalid): an ungated flip would fork a heterogeneous fleet on the
        // first such re-ISSUE and diverge a from-genesis replay from the committed ledger_hash.
        // Same coordinated contract-era flag-day timestamp as the other tightening consensus
        // fixes in this window (2026-10-01 00:00:00 UTC); testnet/regtest activate at genesis
        // (all zeros) so the check is in force from block 0 there and in the unit/e2e suites.
        this.addChange('ISSUE_MINT_SUPPLY_CUMULATIVE_CAP', '2.0.0',1790812800,0,0,0,0,0);

        // SLEEP validity: honor the token's LOCK_SLEEP flag. Before this activation the SLEEP
        // handler never inspected tokenInfo['LOCK_SLEEP'], so a token issued with LOCK_SLEEP=1
        // (a documented, immutable "cannot be paused" guarantee holders rely on) could still be
        // frozen indefinitely by its owner (SLEEP|1|-1|TICK) - the only LOCK_* flag with zero
        // enforcement anywhere in src/. After activation a TICK sleep of a LOCK_SLEEP=1 token is
        // rejected ('invalid: LOCK_SLEEP'), mirroring the LOCK_MINT (mint.js) / LOCK_CALLBACK
        // (callback.js) enforcement pattern. Gated because it TIGHTENS validity (a previously-
        // valid SLEEP becomes invalid), so the fleet and any from-genesis replay must flip at one
        // coordinated block. Same contract-era flag-day timestamp as the other tightening fixes
        // (2026-10-01 00:00:00 UTC); testnet/regtest activate at genesis.
        this.addChange('SLEEP_RESPECTS_LOCK_SLEEP', '2.0.0',1790812800,0,0,0,0,0);

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
        // contract-era flag-day as the other tightening fixes in this window (2026-10-01
        // 00:00:00 UTC); testnet/regtest activate at genesis (all zeros) so the correct
        // release is in force from block 0 there and in the unit/e2e suites.
        this.addChange('COINPAY_EXPIRE_TOKEN_AMOUNT', '2.0.0',1790812800,0,0,0,0,0);

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
        // Same coordinated contract-era flag-day (2026-10-01 00:00:00 UTC); testnet/regtest
        // activate at genesis (all zeros) so the correct routing holds from block 0 there and in
        // the unit/e2e suites.
        this.addChange('COINPAY_NATIVE_RECIPROCITY', '2.0.0',1790812800,0,0,0,0,0);

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
        // flag-day as the other contract-era consensus fixes (2026-10-01 00:00:00 UTC,
        // CONFIRMED 2026-07-07, aligned with the fleet upgrade; a wrong value forks).
        // testnet/regtest activate at genesis (all zeros); the e2e/regtest stack must
        // be rebuilt fresh so no pre-activation cooldown-completion blocks remain.
        this.addChange('UNSTAKE_COOLDOWN_COMPLETION_ACTION', '2.0.0',1790812800,0,0,0,0,0);

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
        // 2026-10-01 00:00:00 UTC fixes (a wrong value forks); keyed on block TIME because the
        // affected native-coin payment/dispenser flows settle on BTC, LTC and DOGE whose heights
        // diverge, so no single height names one cutover. testnet/regtest activate at genesis
        // (all zeros) so the collapse is in force from block 0 there and in the unit/e2e suites.
        this.addChange('FIX_OUTPUT_FANOUT', '2.0.0',1790812800,0,0,0,0,0);

        // Staking-family stress-sweep fixes (2026-07-09). All three are consensus-visible
        // validity/derivation changes, gated on the same coordinated contract-era flag-day
        // as the other 2026-10-01 fixes (a wrong value forks); testnet/regtest at genesis.

        // DEL-1: DELEGATE v2 delegation-revoke previously INSERTed a fresh status=valid,
        // activation_block=0 delegations row (createRevokeDelegation -> createDelegation) in
        // addition to deactivating the parent, so a repeat revoke before maturity EXTENDED the
        // revoked key's signer lifetime and the stray rows corrupt historical as-of effective-set
        // reads. At/after this flag-day the revoke mirrors the v3 path: NO insert, deactivate the
        // parent only. Changes the delegations table that feeds _stakeWeightsSql/stakes_root, so
        // it is a hashed-derivation change (flag-day, not a query tweak).
        this.addChange('DELEGATE_REVOKE_NO_REINSERT', '2.0.0',1790812800,0,0,0,0,0);

        // STAKE-1: the contract-targeted TARGET_CONTRACT_INDEX was validated with /^[0-9]+$/, which
        // accepts non-canonical leading-zero forms ('007'). Benign at runtime (Number-coerced
        // consistently, no fund-stranding, unlike the DEPOSIT custody-address bug), but it is a
        // non-canonical validity surface inconsistent with deposit/withdraw's /^[1-9]\d*$/. At/after
        // this flag-day STAKE v3 / UNSTAKE v1 / DELEGATE v1,v3 reject leading zeros. UNLIKE the
        // deposit/withdraw tightening (ungated - a leading-zero deposit was ALREADY a stranded-funds
        // bug, so rejecting forked nothing valid), a leading-zero contract stake currently produces a
        // VALID, correct row, so tightening it is a live validity change and MUST be gated.
        this.addChange('CONTRACT_INDEX_CANONICAL', '2.0.0',1790812800,0,0,0,0,0);

        // SLASH-1: slashCapabilityStake Pass 1 filtered `activation_block <= block`, so a
        // pending-activation capability top-up (debited at STAKE time) escaped the equivocation bond
        // burn and could later be UNSTAKEd/refunded (the sibling slashContractStake has no such
        // filter). At/after this flag-day the whole locked bond burns, activated or not. Gated on the
        // BTC-anchored EQUIV activation HEIGHT (equivocation_header.js EQUIV_HEADER_ACTIVATION.mainnet
        // = 961000), NOT the 2026-10-01 timestamp: real slashing is inert below the EQUIV flag-day,
        // and 961000 (~2026-08-04) precedes 2026-10-01, so a timestamp gate would leave a window where
        // slashing ran with the old (incomplete) burn. Height-gated so the fix goes live exactly when
        // slashing does. slashCapabilityStake is indexer-only (the follower mirrors the zeroed rows),
        // so this is not a byte-locked twin.
        this.addChange('SLASH_BURNS_PENDING_STAKE', '2.0.0',0,0,0,961000,0,0);

        // H-3: deterministic price_snapshots selection for native-coin fee
        // validation on NON-reference chains. Price rounds are anchored to BTC
        // heights, so getLatestPrice's `reference_block <= blockIndex` gate is
        // vacuously true against LTC/DOGE heights (numerically far above any BTC
        // anchor): the query returned whatever globally-latest round the local
        // mirror held, so mirror lag forked the fleet AND a from-genesis replay
        // read today's newest round instead of the round used live. At/after
        // this flag-day, non-BTC chains select by the round's consensus
        // timestamp instead (`block_timestamp <= block time`, the same pair of
        // quantities the staleness guard already compares) and the block loop
        // gates on the time-keyed price barrier. Keyed on block TIME (not
        // height) for the same reason as DEPLOY_BASE64_CODE: no single height
        // names one cutover across chains. Evaluation happens in
        // utility.getFeeOraclePrices / XChainIndexer via the shared
        // isNativeFeePriceTimeGateActive() below (one predicate, no drift);
        // registered here so the flag-day inventory carries it.
        this.addChange('NATIVE_FEE_PRICE_TIME_GATE', '2.0.0', NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME,0,0,0,0,0);

        // DEPLOY_INIT_STRICT (F-14 follow-on): a contract that exports `initialize`
        // (a constructor) deployed with NO CONSTRUCTOR_PARAMS today runs no
        // constructor yet still commits 'valid' - it silently deploys uninitialized.
        // At/after this flag-day the DEPLOY of a constructor-declaring contract with
        // no CONSTRUCTOR_PARAMS field is REJECTED, and the constructor trigger moves
        // from truthy to field-present so an explicit empty CONSTRUCTOR_PARAMS runs a
        // zero-arg initialize (deploy.js). Below the flag-day: byte-identical to today
        // (truthy trigger, no reject), so a from-genesis replay reproduces the historic
        // accept-below/reject-above verdict. Keyed on block TIME with the 2026-10-01
        // contract-era cohort (CONTROLLER_GUARD / VM_BANNED_ASYNC); testnet/regtest
        // genesis-on. Indexer-only verdict (uses the VM readManifest `hasInitialize`
        // flag), so not a byte-locked twin; the VM readManifest change ships alongside.
        this.addChange('DEPLOY_INIT_STRICT', '2.0.0',1790812800,0,0,0,0,0);

        // BATCH sub-action normalization : the top-level dispatcher
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
        // reproduces every historic reject/misparse verdict (a previously-
        // invalid BATCH becoming valid changes actions/ledger state hashed
        // into the checkpoint preimage; an ungated flip forks a skewed fleet
        // on the first aliased or legacy-format sub-action). Keyed on block
        // TIME with the ratified 2026-10-01 contract-era cohort (
        // batch); testnet/regtest activate at genesis (all zeros).
        this.addChange('BATCH_SUBACTION_NORMALIZATION', '2.0.0',1790812800,0,0,0,0,0);

        //  (flag-day Pkg 11): numeric legacy-fee db_hits accumulation. The legacy
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
        // ratified coordinated contract-era anchor 1790812800 (2026-10-01 00:00:00 UTC);
        // testnet/regtest activate at genesis (all zeros) so the numeric model holds from
        // block 0 there and in the unit/e2e suites (the regtest stack is rebuilt fresh, so
        // no pre-activation fee-bearing blocks remain to replay).
        this.addChange('LEGACY_FEE_NUMERIC_DBHITS', '2.0.0',1790812800,0,0,0,0,0);

        // NOTE: STAKE_WEIGHTED_QUORUM (WI-1) is deliberately NOT registered here.
        // Standard activations gate on the LOCAL processing block via isEnabled();
        // stake-weighted quorum must gate on the BTC-anchored `snapshot_block`
        // carried by each settlement (so BTC/LTC/DOGE + the hub flip on the same
        // anchor). Registering it would invite a wrong isEnabled(localBlock) call.
        // The gate + predicate live in src/stake_weighted_quorum.js
        // (isStakeWeightedQuorumActive / meetsStakeThreshold). Canonical activation
        // height: xchain-documentation/protocol/constants.js.
    }

    // Add protocol changes to protocol changes data object
    // @param {name}          string  Unique name for protocol change
    // @param {version}       string  Semantic version (XX.XX.XX)
    // @param {mainnet_time}  integer Mainnet activation block_time
    // @param {testnet_time}  integer Testnet activation block_time
    // @param {regtest_time}  integer Regtest activation block_time
    // @param {mainnet_block} integer Mainnet activation block_index
    // @param {testnet_block} integer Testnet activation block_index
    // @param {testnet_block} integer Testnet activation block_index
    addChange(name, version, mainnet_time, testnet_time, regtest_time, mainnet_block, testnet_block, regtest_block){
        let error = false;
        if(typeof name != 'string')
            error = 'protocol change name must be string!';
        if(!error && this.changes[name])
            error = 'protocol change name must be unique!';
        if(!error && typeof version != 'string')
            error = 'protocol change version must be string!';
        if(!error && version.split('.').length != 3)
            error = 'protocol change version must be in semantic version format (XX.XX.XX)!';
        if(!error && arguments[2] && typeof arguments[2] != 'number')
            error = 'protocol change mainnet_time must be integer!';
        if(!error && arguments[3] && typeof arguments[3] != 'number')
            error = 'protocol change testnet_time must be integer!';
        if(!error && arguments[4] && typeof arguments[4] != 'number')
            error = 'protocol change regtest_time must be integer!';
        if(!error && arguments[5] && typeof arguments[5] != 'number')
            error = 'protocol change mainnet_block must be integer!';
        if(!error && arguments[6] && typeof arguments[6] != 'number')
            error = 'protocol change testnet_block must be integer!';
        if(!error && arguments[7] && typeof arguments[7] != 'number')
            error = 'protocol change regtest_block must be integer!';
        if(error){
            this.util.throwError(error);
        } else {
            // Parse the protocol change into this.changes
            var change = {};
            let semantic_version    = version.split('.');
            change.version_major    = parseInt(semantic_version[0]);
            change.version_minor    = parseInt(semantic_version[1]);
            change.version_revision = parseInt(semantic_version[2]);
            change.mainnet_time     = parseInt(mainnet_time);
            change.testnet_time     = parseInt(testnet_time);
            change.regtest_time     = parseInt(regtest_time);
            change.mainnet_block    = parseInt(mainnet_block);
            change.testnet_block    = parseInt(testnet_block);
            change.regtest_block    = parseInt(regtest_block);
            this.changes[name] = change;
        }
    }

    // Determine of a protocol change has been defined
    isDefined(name){
        var change = this.changes[name];
        if(change)
            return true;
        return false;
    }

    // Determine if a specific protocol change is enabled based on version, block_time, and block_index
    // @param {name}        string  Unique protocol change name
    // @param {block_index} string  Block index
    async isEnabled(name, block_index){
        let enabled = true;
        try {
            let change  = this.changes[name];
            if(change){
                let current              = {};
                let network              = this.network;
                // Fail CLOSED on an unrecognized network. The mainnet/testnet/regtest branches
                // below have no else, so an unknown network (unset/typo'd INDEXER_NETWORK, or a
                // future network the gate logic doesn't handle) would match none of them, apply
                // NO time/block gate, and leave enabled=true - every flag-day change would read
                // as active from genesis and this node would activate gated consensus rules early
                // and fork the fleet. An un-evaluatable network is not "no gate": treat it like
                // the catch below and propagate, so block processing halts loudly instead of
                // silently diverging. (Boot already rejects an invalid network via
                // coins.getCoinConfig; this is the consensus-path backstop, and it also fails
                // closed rather than open the way the sibling isNativeFeePriceTimeGateActive does.)
                if(network !== 'mainnet' && network !== 'testnet' && network !== 'regtest')
                    throw new Error('ProtocolChanges.isEnabled: unrecognized network "' + network +
                        '" (expected mainnet/testnet/regtest); refusing to evaluate activation to avoid a silent fork');
                let semantic_version     = this.version.split('.');
                current.version_major    = parseInt(semantic_version[0]);
                current.version_minor    = parseInt(semantic_version[1]);
                current.version_revision = parseInt(semantic_version[2]);
                // Verify semantic versioning (compare major, then minor, then revision)
                if(enabled && change.version_major > current.version_major)
                    enabled = false;
                if(enabled && change.version_major == current.version_major && change.version_minor > current.version_minor)
                    enabled = false;
                if(enabled && change.version_major == current.version_major && change.version_minor == current.version_minor && change.version_revision > current.version_revision)
                    enabled = false;
                // Get block information given a block_index
                if(enabled){
                    // Get block time for a given block_index from the decoder database
                    current.block_time  = await this.decoderDb.getBlockTime(block_index);
                    current.block_index = parseInt(block_index);
                    // Verify block_time
                    if(enabled && network=='mainnet' && change.mainnet_time > current.block_time)
                        enabled = false;
                    if(enabled && network=='testnet' && change.testnet_time > current.block_time)
                        enabled = false;
                    if(enabled && network=='regtest' && change.regtest_time > current.block_time)
                        enabled = false;
                    // Verify block_index
                    if(enabled && network=='mainnet' && change.mainnet_block > current.block_index)
                        enabled = false;
                    if(enabled && network=='testnet' && change.testnet_block > current.block_index)
                        enabled = false;
                    if(enabled && network=='regtest' && change.regtest_block > current.block_index)
                        enabled = false;
                }
            } else {
                enabled = false;
            }
        } catch (e){
            // Could-not-evaluate is NOT the same as not-enabled. Swallowing an error here
            // (e.g. a transient decoder-DB fault in getBlockTime) would mark the action as
            // disabled on this node only, invalidating actions that healthy peers process
            // normally and silently forking the ledger. Propagate instead so block
            // processing rolls back and retries the block with correct activation state.
            console.log('protocol error e=',e);
            throw e;
        }
        return enabled;
    }
 
}

module.exports = ProtocolChanges;
// Canonical async-gate flag-day, exported for the cross-repo byte-identity guard in
// test/unit/consensus-params.test.js (must equal xchain-vm ASYNC_SURFACE_GATE_BLOCK_TIME).
module.exports.VM_BANNED_ASYNC_MAINNET_TIME = VM_BANNED_ASYNC_MAINNET_TIME;
// H-3 price-selection flag-day + its shared gate predicate (see registration).
module.exports.NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME = NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME;
module.exports.isNativeFeePriceTimeGateActive = isNativeFeePriceTimeGateActive;