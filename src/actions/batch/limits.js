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
 * XChain Platform Action - BATCH: per-batch caps and cost weights
 *
 * The consensus tables a BATCH is admitted against: the per-ACTION usage caps, the
 * flag-day caps held beside them, the global command cap, the weight budget and the
 * per-action cost weights. The Batch constructor runs each installer once with the
 * instance as `this`, so every table is still an own field of the instance, written
 * as `this.<name> = <value>`: sibling suites (xchain-decoder, xchain-documentation,
 * xchain-e2e-test) read these literals from source in exactly that shape.
 *
 ********************************************************************/

// The per-ACTION usage caps, the caps that arrive with BATCH_ISSUANCE_LIMITS, the distinctness
// bucket for an unresolved MINT TICK and the global command cap, created in that order.
function installCountCaps(){
    // Cap each action per BATCH; count MINT per distinct token
    // after BATCH_ISSUANCE_LIMITS.
    this.actionLimits = {};
    this.actionLimits['BATCH'] = 0;
    this.actionLimits['MINT']  = 1;
    this.actionLimits['ISSUE'] = 1;

    // Add caps only after BATCH_ISSUANCE_LIMITS to preserve replay below it.
    // Keep DEPLOY at one for constructor cost, independently of payload size.
    this.gatedActionLimits = {};
    this.gatedActionLimits['DEPLOY'] = 1;

    // Distinctness bucket for a MINT TICK that resolves to NO ticker id, under the per-token
    // MINT cap. A Symbol, so it can never collide with a real id key however a wire tick is
    // spelled.
    this.unresolvedTickKey = Symbol('BATCH_UNRESOLVED_TICK');

    // Global command cap (BATCH_ISSUANCE_LIMITS): the only bound on the O(N)
    // scans in validate.js, so it is checked first.
    this.commandLimit = 250;
}

// The weight budget and the per-ACTION cost-weight table (BATCH_COST_WEIGHTING), with the
// fan-out and VM weight classes entered by their own installers below, in that order.
function installCostWeights(){
    // Weight budget: equals commandLimit so unweighted batches keep their
    // verdicts; keep the two constants separate even while equal.
    this.weightBudget = 250;

    // Give absent actions the default weight of one, including ISSUE children.
    // Match normalized keys case-sensitively to preserve verdict ordering.
    this.commandWeights = {};
    installFanOutWeights.call(this);
    installVmWeights.call(this);
}

// Keep fan-out weighting free of database reads so the scan can run first.
// Charge AIRDROP per wire leg after BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION.
function installFanOutWeights(){
    this.commandWeights['AIRDROP']  = 25;
    this.commandWeights['DIVIDEND'] = 25;
}

// Retune consensus weights only behind a flag day and a fresh measurement.
// Weight XEXEC like EXECUTE; cap DEPLOY at one and give format 4 weight one.
function installVmWeights(){
    this.commandWeights['DEPLOY']  = 30;
    this.commandWeights['EXECUTE'] = 30;
    this.commandWeights['XEXEC']   = 30;
}

module.exports = { installCountCaps, installCostWeights };
