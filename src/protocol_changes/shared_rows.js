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
 * The SHARED block: the gate rows every consumer of this platform judges.
 *
 * The region between the two marker lines below is BYTE-TWINNED into the
 * registry file of xchain-sync (src/consensus/gate_registry.js), xchain-hub
 * (src/consensus/gate_registry.js), xchain-explorer (src/consensus/
 * gate_registry.js) and xchain-sdk (src/gate_registry.js). The twin is the
 * block, not this file: each consumer wraps the same bytes in its own
 * minimal `addGate`, and the frozen-twins check compares the block alone.
 *
 * What may live between the markers: `addGate(key, unit, table)` calls with
 * LITERAL tables only, one call per gate, at column zero, and comments. No
 * require, no computed value, no reference to anything outside the block
 * except `addGate`, UNARMED and UNPINNED, which every wrapper provides under
 * those names. A key, its spelling and the order of the calls never change
 * inside a window: hub, sync, explorer and sdk read the same rows in the
 * same order, and a one-sided edit forks what they judge.
 *
 * The block is empty at this rung. The consolidation row that turns the
 * shared map literals into rows fills it; until then this file exists so
 * the assembler, the twin declaration and the consumers' wrappers already
 * agree on where the rows go and what shape they take.
 *
 ********************************************************************/

'use strict';

const { UNARMED, UNPINNED } = require('./core.js');

// The wrapper. The block is written as bare addGate() calls at module level
// (a function body would grow past the readability limit as rows arrive),
// so the calls are queued here and replayed into the registry the assembler
// hands registerShared(). UNARMED and UNPINNED, required above, are the two
// names a block row may use besides addGate.
const queued = [];
function addGate(key, unit, table) { queued.push([key, unit, table]); }

// SHARED-GATES BEGIN
// SHARED-GATES END

/**
 * Registers every SHARED block row into `registry`, in block order.
 * @param {{addGate: Function}} registry
 */
function registerShared(registry) {
    for (const [key, unit, table] of queued) registry.addGate(key, unit, table);
}

module.exports = { registerShared };
