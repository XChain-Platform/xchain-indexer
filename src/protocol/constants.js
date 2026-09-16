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
 * XChain Protocol: Canonical Size Limits
 *
 * Single documented source of truth for the protocol-level size caps
 * that more than one service enforces independently. These values had
 * drifted apart before (services each re-declared their own copy and
 * applied it to subtly different quantities), which produced a class of
 * silent-failure bugs where one service accepted data another rejected.
 *
 * Plain CommonJS, zero dependencies; require()-able from any service,
 * tool, or test. Each service keeps its own local copy of these values
 * so it stays self-contained for deployment (the services ship as
 * independent containers and do not share a node_modules tree); the
 * cross-service regression suite asserts every local copy equals the
 * value declared here, so the limits can never silently diverge again.
 *
 ********************************************************************/

const { get, copy, activeAt } = require('../consensus/gate_registry');

const MAX_ACTION_DATA_LENGTH = copy('protocol/constants.MAX_ACTION_DATA_LENGTH');

const OP_RETURN_PUSH_OVERHEAD = copy('protocol/constants.OP_RETURN_PUSH_OVERHEAD');

const MAX_CODE_SIZE = copy('protocol/constants.MAX_CODE_SIZE');

const VM_MAX_CALL_DEPTH = copy('protocol/constants.VM_MAX_CALL_DEPTH');

const VM_MIN_CALL_GAS = copy('protocol/constants.VM_MIN_CALL_GAS');

// ── Cross-CHAIN contract calls (emit.crossExecute / XCALL) ──────────────────
// Enforced by the VM at emit time and re-validated host-side by the indexer
// (processEmission + actions/xcall.js); the target chain re-validates the
// signed dispatch row before injecting. See protocol/Cross_Chain_Calls.md.

const XCALL_MIN_GAS = copy('protocol/constants.XCALL_MIN_GAS');
const XCALL_MAX_GAS = copy('protocol/constants.XCALL_MAX_GAS');

const XCALL_MAX_HOPS = copy('protocol/constants.XCALL_MAX_HOPS');

const XCALL_MIN_DEADLINE_BLOCKS = copy('protocol/constants.XCALL_MIN_DEADLINE_BLOCKS');
const XCALL_MAX_DEADLINE_BLOCKS = copy('protocol/constants.XCALL_MAX_DEADLINE_BLOCKS');

const XCALL_MAX_RETURN_BYTES = copy('protocol/constants.XCALL_MAX_RETURN_BYTES');

const XCALL_MAX_CALLS_PER_BLOCK = copy('protocol/constants.XCALL_MAX_CALLS_PER_BLOCK');

const XCALL_RESULT_ORPHAN_GRACE_SECONDS = copy('protocol/constants.XCALL_RESULT_ORPHAN_GRACE_SECONDS');

const ATTEST_MAX_EXPIRIES_PER_BLOCK = copy('protocol/constants.ATTEST_MAX_EXPIRIES_PER_BLOCK');

const CROSS_SETTLE_MAX_PER_BLOCK = copy('protocol/constants.CROSS_SETTLE_MAX_PER_BLOCK');

const XBRIDGE_MAX_PER_BLOCK = copy('protocol/constants.XBRIDGE_MAX_PER_BLOCK');

const XPOLICY_MAX_PER_BLOCK = copy('protocol/constants.XPOLICY_MAX_PER_BLOCK');

const XPOLICY_MAX_MEMBERS = copy('protocol/constants.XPOLICY_MAX_MEMBERS');

const THRESHOLD_SCALE = copy('protocol/constants.THRESHOLD_SCALE');

// ── Chunked DEPLOY (DEPLOY v4 carriers + DEPLOY v2/v3 assemble) ─────────────
// A contract whose base64(code) exceeds the single-tx budget is split across
// ordered DEPLOY v4 carrier actions and reassembled by a DEPLOY v2/v3 keyed on
// the CODE_HASH. Enforced by the indexer (deploy_chunk + deploy assembly) and
// the SDK (chunkHelper splitter) in lockstep.

const MAX_DEPLOY_CHUNKS = copy('protocol/constants.MAX_DEPLOY_CHUNKS');

const MAX_DEPLOYCHUNK_PART_BYTES = copy('protocol/constants.MAX_DEPLOYCHUNK_PART_BYTES');

const STAKE_WEIGHTED_QUORUM_ACTIVATION = copy('protocol/constants.STAKE_WEIGHTED_QUORUM_ACTIVATION');

const EQUIV_HEADER_ACTIVATION = copy('protocol/constants.EQUIV_HEADER_ACTIVATION');

const STATE_COMMITMENT_ACTIVATION = copy('protocol/constants.STATE_COMMITMENT_ACTIVATION');

const CHECKPOINT_COMMITMENT_ACTIVATION = copy('protocol/constants.CHECKPOINT_COMMITMENT_ACTIVATION');

const ANCHOR_REWARD_ACTIVATION = copy('protocol/constants.ANCHOR_REWARD_ACTIVATION');

const ANCHOR_REWARD_AMOUNT = copy('protocol/constants.ANCHOR_REWARD_AMOUNT');

const ARCHIVE_REWARD_ACTIVATION = copy('protocol/constants.ARCHIVE_REWARD_ACTIVATION');

const ARCHIVE_REWARD_AMOUNT = copy('protocol/constants.ARCHIVE_REWARD_AMOUNT');

const CROSS_CHAIN_ROYALTY_ACTIVATION = copy('protocol/constants.CROSS_CHAIN_ROYALTY_ACTIVATION');

const VALID_FIAT_CODES = copy('protocol/constants.VALID_FIAT_CODES');

const GAS_TICK = copy('protocol/constants.GAS_TICK');

// ── Oracle federation (xchain-hub) ───────────────────────────────────────────
// Canonical source: xchain-hub/src/constants.js. UNLIKE XCALL_MAX_HOPS above, these
// two are NOT in the GOLDEN/GATED set of this repo's
// test/unit/xcall-constants-cross-repo.test.js, which pins only MAX_CODE_SIZE,
// XCALL_MAX_GAS, XCALL_MAX_HOPS and XCALL_MIN_DEADLINE_BLOCKS; the guard that diffs
// this copy against the canonical lives in xchain-hub/test/unit, so a drift
// reddens hub CI rather than this repo's. Nothing in this repo reads either
// one; they are re-exports for consumers.

const PRICE_MAX = copy('protocol/constants.PRICE_MAX');

const ORACLE_DEVIATION_THRESHOLD = copy('protocol/constants.ORACLE_DEVIATION_THRESHOLD');

const ORACLE_VM_ROUND_WINDOW = copy('protocol/constants.ORACLE_VM_ROUND_WINDOW');

const ORACLE_VM_MAX_ROWS = copy('protocol/constants.ORACLE_VM_MAX_ROWS');

module.exports = {
    MAX_ACTION_DATA_LENGTH,
    OP_RETURN_PUSH_OVERHEAD,
    MAX_CODE_SIZE,
    MAX_DEPLOY_CHUNKS,
    MAX_DEPLOYCHUNK_PART_BYTES,
    VM_MAX_CALL_DEPTH,
    VM_MIN_CALL_GAS,
    XCALL_MIN_GAS,
    XCALL_MAX_GAS,
    XCALL_MAX_HOPS,
    XCALL_MIN_DEADLINE_BLOCKS,
    XCALL_MAX_DEADLINE_BLOCKS,
    XCALL_MAX_RETURN_BYTES,
    XCALL_MAX_CALLS_PER_BLOCK,
    XCALL_RESULT_ORPHAN_GRACE_SECONDS,
    ATTEST_MAX_EXPIRIES_PER_BLOCK,
    CROSS_SETTLE_MAX_PER_BLOCK,
    XBRIDGE_MAX_PER_BLOCK,
    XPOLICY_MAX_PER_BLOCK,
    XPOLICY_MAX_MEMBERS,
    THRESHOLD_SCALE,
    STAKE_WEIGHTED_QUORUM_ACTIVATION,
    EQUIV_HEADER_ACTIVATION,
    STATE_COMMITMENT_ACTIVATION,
    CHECKPOINT_COMMITMENT_ACTIVATION,
    ANCHOR_REWARD_ACTIVATION,
    ANCHOR_REWARD_AMOUNT,
    ARCHIVE_REWARD_ACTIVATION,
    ARCHIVE_REWARD_AMOUNT,
    CROSS_CHAIN_ROYALTY_ACTIVATION,
    VALID_FIAT_CODES,
    GAS_TICK,
    PRICE_MAX,
    ORACLE_DEVIATION_THRESHOLD,
    ORACLE_VM_ROUND_WINDOW,
    ORACLE_VM_MAX_ROWS,
};
