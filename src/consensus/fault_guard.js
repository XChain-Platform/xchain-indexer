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
 *********************************************************************/

'use strict';

/**
 * Re-throw errors that are infrastructure faults, never contract outcomes.
 *
 * Several action handlers wrap their VM/state/emission apply block in a catch
 * that rolls back to a savepoint and records a consensus verdict (a denied
 * guard, a 'failed'/'error' status, a deleted contract, a dropped callback).
 * That is correct ONLY for a deterministic, contract-caused failure. An
 * infrastructure fault handled the same way commits a validator-local,
 * non-deterministic verdict into the block hash and forks the chain, because
 * a healthy peer records the opposite outcome. Three fault classes must instead
 * HALT block processing so the whole block rolls back and retries:
 *
 *   1. A VM host fault (HostFaultError, code 'EXECUTOR_UNAVAILABLE'): the
 *      out-of-process executor cannot run ANY contract on this machine. Its
 *      docstring (xchain-vm/src/errors.js) states it is not a contract outcome
 *      and callers must halt and retry. XChainIndexer.js and the controller-
 *      guard direct VM call already honour this; the emission catches did not.
 *
 *   2. A MariaDB driver-level fault: contract logic never produces a numeric
 *      `errno`, so any errno is an infrastructure error. Missing table (1146)
 *      and missing column (1054) are the only benign older-schema gaps and are
 *      left for the caller to absorb; every other errno (lock-wait timeout
 *      1205, deadlock 1213, killed connection, ...) must propagate. Mirrors the
 *      gate at rollback.js and xchain-sync/src/ClientRollback.js.
 *
 *   3. The price-barrier deferral (code 'PRICE_BARRIER_DEFERRED'): this
 *      block skipped the hub price-mirror barrier and then read the mirror
 *      anyway, so its read is uncovered on THIS node only. The assertion's
 *      contract is a rollback plus a retry with the barrier enforced, which a
 *      swallowing catch cancels.
 *
 * A genuine deterministic contract failure (a reverted emission, an
 * insufficient-balance emit.send) carries no errno and is NOT re-thrown, so
 * verdict semantics for non-fault inputs are unchanged.
 *
 * @param {*} e caught error
 */
function rethrowIfInfraFault(e){
    if(e && e.code === 'EXECUTOR_UNAVAILABLE') throw e;
    // Host assert: an injected execution context missing TX_HASH after the
    // SYNTH_EXEC_TX_HASH flag-day is a regressed injector site (host bug), never a
    // contract outcome; swallowing it as a callback verdict would commit the very
    // stranding the assert exists to prevent. Deterministic on every node running
    // the same code, so halting is loud, not forking.
    if(e && e.code === 'EXEC_CONTEXT_TX_HASH_MISSING') throw e;
    // Price-barrier deferral: db._assertPriceBarrierNotSkipped() fires when this
    // block skipped the hub price-mirror barrier and then read the mirror anyway. It is a
    // node-local coverage verdict, not a contract outcome, and its whole contract is that
    // the block rolls back and retries with the barrier enforced. Swallowing it commits an
    // uncovered-mirror verdict that healthy peers do not reach (a prior incident recorded
    // every XCALL execution injected on a transaction-less block as result_status='error').
    if(e && e.code === 'PRICE_BARRIER_DEFERRED') throw e;
    if(e && typeof e.errno === 'number' && e.errno !== 1146 && e.errno !== 1054) throw e;
}

module.exports = { rethrowIfInfraFault };
