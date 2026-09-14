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
 * XChain Indexer - Health response: stall attribution fields
 *
 * The stallReason, decoderReorgHalted and train_activation fields of the
 * `health` payload. buildHealthResponse (src/api/health.js) spreads the
 * returned object at the position these fields always held, so the payload
 * keeps its key order.
 *
 ********************************************************************/

// The train activation verdict as health reports it: the gate's own fields
// when a block has been evaluated, an explicit 'unevaluated' shape before.
function trainActivationReport(indexer){
    return indexer.trainActivation
        ? {
            status:             indexer.trainActivation.status,
            active_rule_set:    indexer.trainActivation.activeRuleSet || null,
            required_rule_set:  indexer.trainActivation.requiredRuleSet || null,
            required_at_height: (indexer.trainActivation.requiredAtHeight === undefined)
                                    ? null : indexer.trainActivation.requiredAtHeight,
            classification:     indexer.trainActivation.classification || null,
            reason:             indexer.trainActivation.reason || null
          }
        // Before the first block is evaluated there is no verdict yet, which
        // is not the same as a clear one. Say so rather than inventing 'clear'.
        : { status: 'unevaluated', active_rule_set: null, required_rule_set: null,
            required_at_height: null, classification: null,
            reason: 'no block has been evaluated against the train activation gate yet' };
}

// Why this node is not advancing, and whether it is still on the fleet's rule
// set, in the health payload's key order.
function stallFields(indexer){
    return {
        // Why the block counter is not advancing, or null when advancing
        // normally: a hub-sync barrier timeout (price/oracle/match/call/snapshot)
        // or a VM executor host fault. Lets an operator tell these stalls apart
        // from a tripped DB circuit breaker (decoderDbCircuit/indexerDbCircuit
        // === 'open') and a healthy catch-up, all of which otherwise present
        // identically as a growing lag.
        // When the decoder has halted (durable REORG_HALT marker), attribute the stall to that
        // rather than reporting ordinary lag/null. A halted decoder cannot advance, so the
        // indexer's lag is a downstream symptom, not an indexer-side stall.
        stallReason:      indexer.decoderReorgHalted
                            ? (indexer.stallReason || 'decoder_reorg_halt: decoder wrote a REORG_HALT marker; full decoder resync required')
                            : (indexer.stallReason || null),
        decoderReorgHalted: !!indexer.decoderReorgHalted,
        // PLATFORM-TRAIN ACTIVATION. The one field here
        // that reports a fault BEFORE it happens: `pending` means the signed release
        // manifest names a rule-set version this build does not implement and the boundary
        // is still ahead, so the monitor can alert while there is still a rolling-upgrade
        // window left to use. `halt` means the boundary is reached and this node has stopped
        // advancing rather than apply the block under the old rules.
        //
        // Reported as its own object rather than folded into stallReason/status because the
        // two answer different questions and an operator needs both: status says whether
        // this node is serving, this says whether it is still on the fleet's rule set. A
        // build that predates the gate omits the field entirely, which every reader must
        // treat as "told us nothing" rather than as clear; the monitor rule does.
        train_activation: trainActivationReport(indexer)
    };
}

module.exports = { stallFields };
