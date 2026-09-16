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
 * ISSUE limits on NEW names: the tick-namespace flag day (a four-character floor and
 * the reserved future chain roots) and the per-transaction top-level issuance budget.
 *
 * Each function runs with `this` bound to the Issue handler (./index.js calls each as
 * fn.call(this, ctx)) and reads and writes the shared context.
 *
 ********************************************************************/

'use strict';

// Chain tickers held for roots XChain has not integrated yet. The membership test is
// taken from the module rather than re-derived here, so the case folding it applies
// lives with the list it folds. A name leaves the list only by moving into COINS, and both
// refuse identically, so nothing re-verdicts on the move.
const { isReservedFutureRoot } = require('../../consensus/reserved_roots.js');

// The floor on a NEW top-level name at/above TICK_NAMESPACE_ACTIVATION. Measured
// on the FULL tick, so a child such as ABCD.X passes on its own length. Creation only:
// every one-to-three character row issued before the flag keeps its owner, its supply and
// its admin surface, which is why the guard below probes for an existing row first.
const MIN_NEW_TOP_LEVEL_TICK_LENGTH = 4;

// TICK NAMESPACE (ruled 2026-09-11). Two rules, one activation.
//
// WHY THEY EXIST: a chain XChain integrates later needs its root free on every
// ledger that exists by then, and today a squatter can take it for one issuance
// fee. Surveyed 2026-09-11 over 720 explorer probes on the six live chains: every
// ticker of three characters or fewer is free everywhere (the prior ledgers
// enforced a four-letter minimum), so the short namespace can be reserved whole.
//
//  1. A FOUR-CHARACTER FLOOR on a new top-level name, refused with the EXISTING
//     'invalid: TICK (length)' string so nothing new appears in the verdict set.
//  2. RESERVED_FUTURE_ROOTS joined to the guard's COINS + GAS, case-folded like RESERVED_TICKS,
//     verdict 'invalid: TICK (reserved)' reused. It matters the day the floor is
//     lowered, and for the four-plus-letter chain codes the floor does not cover.
//
// CREATION ONLY. An edit of a row that already exists is untouched:
// every one-to-three character token and each of the six reclaimed four-letter rows
// keeps its owner, its supply and its admin surface, and the six leave through the
// genesis manifest edit, not through a guard that would strand them. That
// is what the existence probe below is for, and it uses the interning-suppressed
// reader so a refused name never mints a dense ticker id (the economy
// gatedGetTokenInfo exists for); the probe runs only for a name that is short or
// listed, never on the common path.
//
// RESERVED WINS OVER SHORT when a name is both (ETH is three characters AND a
// listed chain code): the reserved verdict says WHY the name is held, and a test pins
// 'ISSUE ETH' to 'invalid: TICK (reserved)'.
//
// ACTIVATION-KEYED, unlike the RESERVED_TICKS case folding, and the difference is not a
// preference: the reserved and length checks run BEFORE the fee and budget checks,
// so a mined ISSUE of a short or listed name that was refused on fee would flip its
// STATUS string on replay, and no explorer probe can rule that out because only
// valid rows are served. Below the flag this whole block is inert and the
// handler is byte-for-byte today's.
//
// Reserving a root reserves its whole ROOT.* subtree through the parent gate
// (`invalid: TICK (parent unknown)`), so one entry per chain is the entire cost.
async function validateTickNamespace(ctx){
    let { data, namespaceActive, str, tickUpper, len } = ctx;
    let error = ctx.error;

    if(!error && namespaceActive && !data['IS_GENESIS']){
        let caretRef  = (str.substring(0,1)=='^');
        // `tickUpper` rather than the raw field: the membership test fails closed on a
        // non-string, and every other tick guard here judges the stringified form.
        let isFuture  = isReservedFutureRoot(tickUpper);
        let tooShort  = !caretRef && this.isTopLevelIssuance(data['TICK']) && len < MIN_NEW_TOP_LEVEL_TICK_LENGTH;
        if(isFuture || tooShort){
            let existing = await this.resolveOnlyGetTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!existing)
                error = (isFuture) ? 'invalid: TICK (reserved)' : 'invalid: TICK (length)';
        }
    }

    ctx.error = error;
}

// Per-TRANSACTION top-level issuance budget (EMISSION_ISSUANCE_LIMITS).
//
// THIS is the choke point the rule needs and the pre-dispatch BATCH scan is not: every
// ISSUE arrives here, whether it came off the wire as a sub-command or was emitted by
// a contract (execute.js processEmission routes an emission straight to this handler,
// past that scan), and VM-emitted issuances are fee-exempt under
// ISSUANCE_FEE_EMISSION_EXEMPT, so before this check one EXECUTE could register up to
// maxEmissions (50) top-level names for nothing and a 250-command BATCH of EXECUTEs
// up to 12,450. Operator decision 2026-08-15 (option a): count them.
//
// NO WIRE VERDICT MOVES. batch.js caps top-level ISSUE sub-commands at 1 per BATCH
// (actionLimits['ISSUE'], in force below the BATCH_ISSUANCE_LIMITS flag as well) and a
// non-BATCH transaction carries exactly one action, so at most ONE wire ISSUE ever
// reaches this counter and it can only ever consume the first slot.
//
// Placed BEFORE the token-info read below so a refused issuance reaches
// gatedGetTokenInfo with `error` already set and therefore interns no ticker id for a
// name it never registers - the same free-consumption-of-dense-id-space economy that
// wrapper exists for. Below it, the read has already happened.
//
// Counted on ARRIVAL rather than on success, matching the BATCH scan, which counts
// sub-commands without regard to their validity. An ISSUE that consumes the slot and
// then fails a later check has still spent it - deterministically, on every node, so
// the ledger is a consensus value like any other.
//
// GENESIS IS EXEMPT: the bootstrap registers ~240k names from one synthetic source and
// is not a spam surface (genesis.js is the only caller that can set IS_GENESIS). A
// missing ledger is likewise inert: any caller that never came through a transaction
// or an injected-execution context enforces nothing, which is the pre-flag behaviour.
async function countTopLevelIssuance(ctx){
    let { data } = ctx;
    let error = ctx.error;

    let issuanceLedger = data['ISSUANCE_LIMIT_LEDGER'];
    if(!error && !data['IS_GENESIS'] && issuanceLedger && this.isTopLevelIssuance(data['TICK']) &&
       await this.actions.protocolChanges.isEnabled('EMISSION_ISSUANCE_LIMITS', data['BLOCK_INDEX'])){
        issuanceLedger.topLevel = (Number(issuanceLedger.topLevel) || 0) + 1;
        if(issuanceLedger.topLevel > this.topLevelIssuanceLimit)
            error = 'invalid: ISSUE (limit)';
    }

    ctx.error = error;
}

module.exports = { validateTickNamespace, countTopLevelIssuance };
