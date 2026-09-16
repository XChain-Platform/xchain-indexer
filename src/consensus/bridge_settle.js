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
 * XChain Platform - bridge settle pass (system-injected, mirror-driven)
 *
 * BUILT. This module's shape, function names, parameter sets, return shapes and the escrow
 * check hook are stable; the bodies are here. verifyEscrowAgainstCheckpoint is the one door into
 * bridge_checkpoint_check.js, whose proof this pass fetches through bridge_proof_client.js
 * before calling it. The pass driver processBridgeSettlePass is what XChainIndexer.js calls.
 *
 * WHAT THIS FILE IS. The hub federation signs a transfer record (bridge_transfers) or a
 * token policy snapshot (policy_snapshots) and delivers it through the hub-DB mirror.
 * This module applies THIS chain's leg of an effective row: it verifies the quorum
 * locally, injects the XBRIDGE v2/v5 settle action (or the XPOLICY leg set), and records
 * the application in bridge_settlements for idempotency and rollback. There is NO on-chain
 * transaction for a settle leg; it is an internal action, like CROSS_SETTLE and SWAP_MATCH.
 *
 * WHY IT IS A SEPARATE FILE FROM actions/xbridge.js. The same split cross_settle.js has
 * from the handlers whose escrow it releases: the wire handler is driven by a transaction
 * mined on this chain, the settle pass by an end-of-block sweep over mirrored rows. Keeping
 * them apart is also what lets the wire lane and the settle lane build in parallel.
 *
 * HOW IT IS DRIVEN. XChainIndexer.js's ordered pass list calls this immediately AFTER
 * util.processCrossChainSettlements and BEFORE util.processCrossChainCalls. THE POSITION IS
 * PINNED AND IS NOT A STYLE CHOICE: it assigns action indexes, so it is consensus-visible,
 * and it is what makes a credit bound at block B spendable at B+1 on every node and never
 * at B. That call site is made, in that position, and it passes this module's own ctx.
 *
 * ORDER, CAP AND BARRIER. Finalized rows apply in (snapshot_block, transfer_id) order at
 * the first block whose protocol block_time is at or past effective_time, at most
 * XBRIDGE_MAX_PER_BLOCK = 25 per destination chain per block, overflow carrying forward in
 * order and never dropped. Policy snapshots run at the HEAD of the pass, at most
 * XPOLICY_MAX_PER_BLOCK = 5 per block per chain, in (snapshot_block, snapshot_id) order
 * across ticks and by policy_seq within one tick. The pass runs behind waitForBridgeSync
 * (and waitForPolicySync), which run behind waitForSnapshotSync, so the capability rows the
 * quorum is verified against are already present.
 *
 * TRUST, STATED PLAINLY. In the hub-trusted mint a compromised hub supplies BOTH the record and the
 * roster that verifies it: off the origin chain the validator set itself is resolved from
 * the mirrored capability_snapshots. That is why verifyEscrowAgainstCheckpoint exists and
 * why nothing arms on mainnet before it is built.
 *
 * RETRACTION. A mirror deletion for a row that has not been applied means it is never
 * applied. A row already applied STAYS applied: the destination chain did not reorg, so
 * there is nothing there to roll back, and a forward un-mint would change that chain's
 * hashes forward rather than back. The invariant read reports the deficit and the watch
 * raises CRIT.
 *
 * Scope: the transfer settle legs, the quorum check and the escrow cross-check;
 * the bridged token rows an in leg creates; the token policy
 * snapshot legs and their apply order.
 *
 ********************************************************************/

'use strict';


// The activation twins this pass reads, required HERE and nowhere below. The mirror-admission
// and equivocation maps freeze from the environment at require time, and the suites that drive
// an arming purge this file together with the activation module and re-require both
// (test/unit/admission_binding.test.js, test/unit/bridge_settle.test.js requireDisarmed). So the
// parts that read an activation are BUILT by this file from the modules this file holds, rather
// than requiring them for themselves: a part file is not purged with the entry, and one that had
// captured the activation itself would keep answering from the pre-arming map. The parts that
// read no activation are plain requires.
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');
const ah      = require('../mirror_admission_activation.js');
const cpCheck = require('./bridge_checkpoint_check.js');

const { SETTLE_REASON, POLICY_LEG_ORDINAL,
        POLICY_TX_PREFIX, BRIDGE_TX_PREFIX } = require('./bridge_settle/reasons.js');
const { policyHash, verifyMembershipOrder, parseMembership } = require('./bridge_settle/policy_membership.js');
const { isSettled, isSourceLegSettled, recordSettlement }    = require('./bridge_settle/settlements.js');
const createCanonicals = require('./bridge_settle/canonicals.js');
const createQuorum     = require('./bridge_settle/quorum.js');
const createRefusalLog = require('./bridge_settle/refusal_log.js');
const createTransfer   = require('./bridge_settle/transfer.js');
const createPolicy     = require('./bridge_settle/policy.js');
const createPass       = require('./bridge_settle/pass.js');

// One build per instance of this module, in dependency order. The refusal memo belongs to the
// build and not to a part's module scope, so its lifetime stays what it was: an entry that is
// purged and re-required gets a fresh memo, and two instances in one process never share one.
const canonicals = createCanonicals({ ah: ah, eq: eq });
const quorum     = createQuorum({ swq: swq });
const refusalLog = createRefusalLog();
const transfer   = createTransfer({ canonicals: canonicals, quorum: quorum, refusalLog: refusalLog,
                                    verifyEscrowAgainstCheckpoint: verifyEscrowAgainstCheckpoint });
const policy     = createPolicy({ canonicals: canonicals, quorum: quorum, refusalLog: refusalLog });
const pass       = createPass({ canonicals: canonicals, transfer: transfer, policy: policy });

/**
 * THE ESCROW CHECK HOOK: prove the source-chain escrow behind a transfer against the anchored BTC
 * state checkpoint before the destination mints.
 *
 * WHY IT EXISTS. Without it a mint is hub-trusted: off the origin chain the hub supplies
 * both the transfer record and the capability roster that verifies it, so a compromised hub
 * can mint on the destination with nothing held on the origin. This check reduces the
 * assumption to "the cross_chain quorum AND the checkpoint quorum both lied", which is the
 * assumption the cross-chain DEX and every validator action already rest on. Nothing arms
 * on mainnet before it is built.
 *
 * THE PROOF IS TRANSPORT, NEVER A CANONICAL FIELD. It is fetched beside the row or by the
 * indexer itself (the anchor proof client), and is NOT part of the signed content canonical.
 * That is what lets the escrow check arm without changing one canonical or invalidating one
 * signature: every canonical field is a byte-match obligation forever.
 *
 * WHAT IT PROVES. The escrow balance at row.snapshot_block, proven against the balances_root
 * the anchored BTC checkpoint carries at that height. The escrow is an ordinary balance at
 * ADDRESS.BRIDGE_<dest_chain>, so it rides that root with no new subtree.
 *
 * ONE NAMED DOOR. The settle pass calls this hook on every leg, so the hook stays called
 * unconditionally while the real check lives in its own module; this delegates, and the
 * delegation is the whole body on purpose. Keeping one named door here means the settle pass
 * has exactly one call site to audit and the check keeps its own file, its own suite and its
 * own falsification drill. ctx.proof is populated by fetchProofForTransfer below BEFORE this
 * runs; a caller that supplies none gets the check's own PROOF_MISSING refusal, which is the
 * fail-closed direction.
 *
 * @param {Object} row - the bridge_transfers row about to be applied, as applyBridgeTransfer
 * @param {Object} ctx - pass context, plus { proof } when the caller fetched one beside the
 *                       row; the pass driver always fetches one for a leg that needs it
 * @returns {{ok: boolean, reason: string}} ok false refuses the row with one log line naming
 *          the transfer_id and applies nothing
 */
function verifyEscrowAgainstCheckpoint(row, ctx){
    // BUILT. The permissive stub is gone: the real check lives in bridge_checkpoint_check.js
    // and this is the one door into it, so the settle pass calls one name and the
    // check keeps its own file, its own tests and its own falsification drill.
    return cpCheck.verifyEscrowAgainstCheckpoint(row, ctx);
}

module.exports = {
    applyBridgeTransfer:     transfer.applyBridgeTransfer,
    applyPolicySnapshot:     policy.applyPolicySnapshot,
    verifyEscrowAgainstCheckpoint,
    processBridgeSettlePass: pass.processBridgeSettlePass,
    fetchProofForTransfer:   pass.fetchProofForTransfer,
    dueBridgeTransfers:      pass.dueBridgeTransfers,
    duePolicySnapshots:      pass.duePolicySnapshots,
    transferCanonical:       canonicals.transferCanonical,
    policyCanonical:         canonicals.policyCanonical,
    mirrorBindClause:        canonicals.mirrorBindClause,
    policyHash,
    verifyMembershipOrder,
    parseMembership,
    verifyQuorum:            quorum.verifyQuorum,
    isSettled,
    isSourceLegSettled,
    recordSettlement,
    resetRefusalMemo:        refusalLog.resetRefusalMemo,
    // Test-only access to the refusal memo, so the bound and the dedupe rule can be driven
    // directly rather than by forcing 5000 real quorum verifications through applyBridgeTransfer.
    _shouldLogRefusalForTest: refusalLog.shouldLogRefusal,
    _refusalMemoSizeForTest:  refusalLog.memoSize,
    SETTLE_REASON,
    POLICY_LEG_ORDINAL,
    POLICY_TX_PREFIX,
    BRIDGE_TX_PREFIX,
};
