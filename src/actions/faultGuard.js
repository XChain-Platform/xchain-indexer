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
 * a healthy peer records the opposite outcome. Two fault classes must instead
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
 * A genuine deterministic contract failure (a reverted emission, an
 * insufficient-balance emit.send) carries no errno and is NOT re-thrown, so
 * verdict semantics for non-fault inputs are unchanged.
 *
 * @param {*} e caught error
 */
function rethrowIfInfraFault(e){
    if(e && e.code === 'EXECUTOR_UNAVAILABLE') throw e;
    if(e && typeof e.errno === 'number' && e.errno !== 1146 && e.errno !== 1054) throw e;
}

module.exports = { rethrowIfInfraFault };
