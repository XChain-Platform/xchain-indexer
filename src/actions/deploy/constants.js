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
 * XChain Platform - DEPLOY: the consensus literals its parts share
 *
 * Held in one place so the fee part, the constructor part and the run state
 * in actions/deploy/index.js read the same value rather than three copies.
 *
 ********************************************************************/

// Gas ceiling for the constructor clamp (constructor_run.js). Must stay in lockstep with
// GAS_CEILING in actions/execute/index.js: if the ceiling ever changes, both files
// must move together or validators fork on the first resource-terminated
// constructor (the clamped value flows into contract_executions.gas_used, which
// is consensus-hashed via contract_hash).
const GAS_CEILING = 1000000;

// The status a chunked assembler (v2/v3) lands with when its group is not complete yet
// (DEPLOY_DEFERRED_ASSEMBLY): its rows exist at its own action, but the contract is
// deployed later, by the action that completes the group. Written once and NEVER mutated -
// a status flip would be an in-place mutation needing bespoke rollback and a hash rule.
// db.js repeats this literal in the pending-assembler lookup, the same way the seven
// CODE_HASH verdict strings are repeated across deploy.js and deploy_chunk.js.
const PENDING_ASSEMBLY_STATUS = 'pending: CODE_HASH (awaiting chunks)';

module.exports = { GAS_CEILING, PENDING_ASSEMBLY_STATUS };
