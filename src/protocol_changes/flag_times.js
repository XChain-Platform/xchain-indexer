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
 * Flag-day instants for the contract-era and genesis-arm cohorts of the time table.
 *
 * Each constant below is one network instant of a `protocol_changes.changes.*`
 * row in the changes_*.js part files, kept as a named constant so the entry
 * module can export it for the suites that pin the ratified value. The
 * comments carry the ruling behind every instant; they moved here with the
 * constants from the top of src/protocol_changes.js and are unchanged.
 * The BATCH issuance and fee re-pricing cohort lives in flag_times_batch_fees.js.
 *
 ********************************************************************/

'use strict';

// VM async/Promise flag-day, single source of truth for the cross-repo coupling
// guard. This MUST stay byte-identical to xchain-vm's ASYNC_SURFACE_GATE_BLOCK_TIME;
// a one-sided edit forks the fleet on the first async-using DEPLOY/EXECUTE after the
// earlier of the two timestamps. consensus-params.test.js asserts the two are equal.
const VM_BANNED_ASYNC_MAINNET_TIME = 1786060800;

// H-3 flag-day: deterministic (time-gated) price_snapshots selection for
// native-coin fee validation on non-reference chains (see the
// NATIVE_FEE_PRICE_TIME_GATE registration below). Same coordinated 2.0.0
// contract-era timestamp as the other flag-days; a divergent value forks the
// fleet on the first fee-bearing LTC/DOGE action after the earlier timestamp.
const NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME = 1786060800;

// Mainnet arm for UNCAPPED_MAX_SUPPLY_ZERO. 9999999999 (year 2286) is the
// house UNARMED sentinel, the same one price_pair_activation.js uses: the operator
// ratified the PRODUCT direction (MAX_SUPPLY=0 stays the uncapped sentinel) on
// 2026-08-11 but has NOT yet minted the mainnet flag-day the rule switches on, and a
// loosening cannot be armed at a guessed value. Arming it is a one-line edit of this
// constant; until then the rule is inert on mainnet and live from genesis on
// testnet/regtest. Do NOT arm it at the 2026-08-07 contract-era anchor: that date is
// already past, and a loosening with a retroactive boundary makes a from-genesis
// replay accept mints the live fleet rejected.
//
// This is the ONE gate the 2026-09-09 genesis-arm ruling deliberately keeps on a future
// instant. Its siblings arm at 0 because the action types they touch have no mainnet
// history at all; this rule touches MAX_SUPPLY=0, which about 168,000 mainnet ISSUEs
// carry (124,158 of BTC's 124,160 and all 43,934 of DOGE's, measured 2026-09-09), so a
// genesis arm would reinterpret every one of them. The instant is T, the mainnet launch
// instant, and only the operator names it.
const UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME = 9999999999;

// Mainnet arm for CROSS_SETTLE_PER_BLOCK_CAP. ARMED AT GENESIS (0) by the operator's
// 2026-09-09 ruling. The cap can only move a verdict where the CROSS_SETTLE pass has a
// finalized match to defer, and the indexed mainnet history has none: mainnet holds
// 124,160 BTC ISSUEs, 43,934 DOGE ISSUEs and 56 DOGE ANCHORs, with no LTC actions and
// zero of every other action type (measured read-only on the mainnet replicas
// 2026-09-09). The 2026-08-11 ruling read mainnet as carrying settled cross-chain
// history; that reading was wrong, which is why a flag day was reserved for it, and the
// measurement is what supersedes it. A genesis arm is therefore identity on every block
// a from-genesis replay can reach, and the OLD-vs-ON replay witness per chain is the
// proof rather than the argument: a divergence there returns this constant to a future
// instant. testnet/regtest were already genesis-active.
const CROSS_SETTLE_CAP_MAINNET_TIME = 0;

// Mainnet arm for BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR, the per-subcommand root
// discriminator that stops two same-contract EXECUTE subcommands of one BATCH from
// deriving the IDENTICAL ATTEST request_id (see the registration below). ARMED AT
// GENESIS (0) by the operator's 2026-09-09 ruling. The composite discriminator differs
// from the bare TX_VOUT only for a root action that is a BATCH sub-command, and mainnet
// has never carried a BATCH: its whole indexed history is 124,160 BTC ISSUEs, 43,934
// DOGE ISSUEs and 56 DOGE ANCHORs, with zero BATCHes, zero EXECUTEs and zero
// attestations (measured read-only on the mainnet replicas 2026-09-09). No request_id a
// from-genesis replay derives can move, so there is no preimage history to preserve and
// no flag day to coordinate. The OLD-vs-ON replay witness per chain is the proof.
// testnet/regtest were already genesis-active.
const BATCH_ROOT_SUB_INDEX_MAINNET_TIME = 0;

// Arms for ISSUE_INHERITED_MINT_WINDOW, the re-parameterization fix that scopes the ISSUE
// mint-window recency checks (MINT_START_BLOCK / MINT_STOP_BLOCK must be >= the current
// block) to values the ISSUE EXPLICITLY carries on the wire. Below the flag day those
// checks also run against values INHERITED from the existing token record by the
// populate-empty-params merge, which makes every re-parameterizing ISSUE on a token
// permanently invalid the moment its mint window opens: the inherited MINT_START_BLOCK is
// by then necessarily in the past, so an owner ISSUE that raises MAX_MINT while leaving
// the window untouched is rejected with 'MINT_START_BLOCK < BLOCK_INDEX' (and, once the
// window closes, the same again via MINT_STOP_BLOCK). Remedy ruled by the operator on
// 2026-08-22: exempt inherited values, keep the recency check on explicit ones, so the
// anti-backdating purpose is untouched (see actions/issue.js).
//
// Mainnet: ARMED AT GENESIS (0) by the operator's 2026-09-09 ruling. The loosening bites
// only on a re-parameterizing ISSUE that the inherited window rejected, and mainnet's
// indexed history is ISSUE plus 56 DOGE ANCHORs with no MINT at all (124,160 BTC ISSUEs,
// 43,934 DOGE ISSUEs, no LTC actions, measured read-only on the mainnet replicas
// 2026-09-09), so no stored mint window has ever opened for an inherited value to fall
// behind. The from-genesis OLD-vs-ON replay witness per chain is what settles that
// rather than this reasoning: if it turns up an ISSUE whose verdict moves, this constant
// goes back to a future instant beside UNCAPPED_MAX_SUPPLY_ZERO.
const ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME = 0;

// Testnet: ARMED (operator remedy ruling 2026-08-22, pre-launch) at 1787961600 =
// 2026-08-29T00:00:00Z. RE-PINNED FORWARD on 2026-08-25 for the v0.11.0 train, per the
// standing rule below: the original 1787529600 (2026-08-24T00:00:00Z) had lapsed before
// this code shipped, so the live fleet would have applied the legacy rule past it while a
// from-genesis replay applied the new one. The remedy is unchanged and needs no re-ruling;
// only the instant moves, and the fresh 2026-08-24 testnet genesis makes the original
// reason for a future instant (BTC testnet4's recorded rejection at block 149546) moot,
// since that block is now below every chain's first indexed block.
// The instant must still be in the FUTURE when this ships: an
// activation already past is not a flag day at all, because the fleet applies the
// legacy rule beyond it while a from-genesis replay applies the new one, and the two
// diverge at the first comparison. Re-pin this constant forward if it lapses.
// This is the FIRST nonzero testnet threshold in this file, and
// deliberately so: unlike the sibling gates (registered while testnet carried no history
// the rule reinterprets), BTC testnet4 already holds a recorded rejection of exactly this
// shape (the XCHAIN faucet correction ISSUE, block 149546), so a genesis-active testnet
// arm would fork every already-synced testnet node against a fresh reindex. A FUTURE
// instant preserves the recorded history and lets the correction be rebroadcast once the
// boundary passes. Every testnet indexer (all three chains) must be running this code
// before the instant; testnet4 tips may carry timestamps up to ~2h ahead of wall clock,
// so the deploy needs to land with that margin. Regtest stays genesis-active (0): suites
// and regtest venues exercise the corrected rule from block 0.
const ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME = 1787961600;

// Arms for DEPLOY_DEFERRED_ASSEMBLY, order-independent assembly of a chunked DEPLOY
// group. A chunked contract is N format-4 carriers plus one assembling DEPLOY, each its
// own transaction with no on-chain ordering between them; below the flag day the
// assembler must land after every carrier or it is permanently
// 'invalid: CODE_HASH (no chunks)' / '(missing chunk i)', and a reorg can hand a
// correctly sequenced group back to the mempool in any order (measured on Bitcoin
// testnet4 at block 150679 and by the regtest reorg drill). At/above it an early
// assembler lands 'pending: CODE_HASH (awaiting chunks)' with its base fee paid, and
// the first action that completes the group runs the deployment at its own index with
// the assembler's wire parameters; a second pending assembler for the same group is
// 'invalid: CODE_HASH (duplicate pending)'. The fee and sleeping checks move ahead of
// the chunk verdict, and the pending rows enter the block's contract_hash through the
// existing classes, so the rule is a consensus change (see actions/deploy.js and
// actions/deploy_chunk.js).
//
// Mainnet: genesis-active (0). Every mainnet chain holds zero contracts and zero
// deploy_chunks (measured 2026-09-01 and to be re-measured at the mainnet cut), so
// there is no history the rule reinterprets and a from-genesis replay is unaffected.
const DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME = 0;

// Testnet: house UNARMED sentinel (9999999999, year 2286) at this build rung. Bitcoin
// testnet4 already holds a group of exactly the shape this rule reinterprets (action 70
// assembler, carriers 71 and 75, blocks 150679-150681): an instant at or below block
// 150679's time would turn action 70 into a pending assembler on a fresh replay and fork
// it from every running node. The testnet instant is pinned by the release that ships
// the rule, at 00:00:00Z of the second day after the indexer release lands, strictly
// above the tip at repin; all three testnet indexers must run this code before it, and
// the constant is re-pinned forward if the repin slips (an activation already past is
// not a flag day). Regtest stays genesis-active (0) so the suites and regtest venues
// exercise the rule from block 0.
// Pinned by the v0.15.3 release at 2026-09-10T00:00:00Z (1788998400), the second day
// after the release landed, above TBTC 150681 (block time 1788303761) and the repin tip
// (151433 at 1788824545). Re-pinned EARLIER by v0.15.5 to 2026-09-08T12:00:00Z: every
// testnet indexer already ran v0.15.3 by 2026-09-08T03:14Z and a fresh replay under it
// reproduced the fleet's hashes block for block, so the two-day repin buffer bought
// nothing; the new instant is still above TBTC 150681 and above the tip's median time
// past at the re-pin (151460 at 1788843745) with hours to spare, so no block any node
// has parsed is reinterpreted.
const DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME = 1788868800;

// Arms for CONTRACT_META_REQUIRED, the rule that makes a contract's human-readable
// identity a consensus-required export. At/above the flag day a DEPLOY whose contract
// does not export meta.name and meta.description (see src/contract_meta.js for the
// seven verdict rows and the text grammar) is rejected with an
// 'invalid: CONTRACT_MANIFEST (...)' status instead of deploying nameless. The verdict
// is evaluated OUTSIDE the manifest success guard, so a contract whose module top level
// throws - which deploys 'valid' today and fails on its first execute - is rejected too;
// that is the reason this cannot ride the ungated manifest block.
//
// Mainnet: genesis-active (0). Every mainnet chain holds zero contracts (measured
// 2026-09-08 through the public explorer, the same state DEPLOY_DEFERRED_ASSEMBLY
// recorded on 2026-09-01), so there is no history the rule reinterprets and a
// from-genesis replay is unaffected.
const CONTRACT_META_REQUIRED_MAINNET_TIME = 0;

// Testnet: ARMED 2026-09-10 (operator, at the cut of the carrying release) at
// 1789257600 = 2026-09-13T00:00:00Z. It was the house UNARMED sentinel (9999999999,
// year 2286) up to this build rung, because TBTC already holds contracts that export no
// meta-shaped object (measured 2026-09-08), so a genesis-active testnet arm would flip
// every one of them from its recorded verdict and fork a fresh replay from every running
// node. The instant is pinned by the RELEASE that ships the rule, at 00:00:00Z of the
// second day after the carrying indexer release lands: the release cuts 2026-09-10 and
// the fleet roll may land as late as 09-11, so the second day after the latest plausible
// landing is 09-13. That sits more than a day above the tip's median-time-past at the
// cut, which is the property that matters, because protocol time off mainnet is
// median-time-past and not the block's own stamp. It is moved forward if the roll slips
// (an activation already past is not a flag day), and re-pinnable earlier once every
// testnet indexer is proven on the code and a fresh replay reproduces the fleet's
// hashes. Regtest stays genesis-active (0) so the suites and the regtest venues
// exercise the rule from block 0.
const CONTRACT_META_REQUIRED_TESTNET_TIME = 1789257600;

module.exports = {
    VM_BANNED_ASYNC_MAINNET_TIME,
    NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME,
    UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME,
    CROSS_SETTLE_CAP_MAINNET_TIME,
    BATCH_ROOT_SUB_INDEX_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME,
    DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME,
    DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME,
    CONTRACT_META_REQUIRED_MAINNET_TIME,
    CONTRACT_META_REQUIRED_TESTNET_TIME,
};
