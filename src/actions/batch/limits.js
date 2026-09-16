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
    // Per-BATCH usage cap for each ACTION (0 = disallowed inside a BATCH).
    // MINT's 1 is re-read at/after BATCH_ISSUANCE_LIMITS as "1 per DISTINCT token"
    // rather than "1 per batch" (the per-distinct-token MINT rule); the number itself does not move,
    // only what it is counted over. See maxMintsPerDistinctTick.
    this.actionLimits = {};
    this.actionLimits['BATCH'] = 0;
    this.actionLimits['MINT']  = 1;
    this.actionLimits['ISSUE'] = 1;

    // Per-ACTION caps that arrive WITH the BATCH_ISSUANCE_LIMITS flag-day, held in their
    // own table so the pre-flag one above stays byte-identical below the flag: adding a
    // row to actionLimits would apply it retroactively and fork a replay.
    //
    // DEPLOY = 1 (at most one DEPLOY per batch). Below the flag the chain does not cap DEPLOY at
    // all; only the SDK builder and the wallet refuse it, which is a client-side line and
    // not a protocol rule, while deploy.js (~536-541) DELIBERATELY supports a DEPLOY inside
    // a BATCH, carrying the sub-command position into the constructor's root discriminator.
    // THE CAP IS NOT ABOUT SIZE. "Too large for BATCH" was a legacy-lane fact (8192 bytes)
    // and the envelope lane carries ~390000, with oversize self-enforcing at the encoder.
    // The reason for the cap is COST: every DEPLOY runs a CONSTRUCTOR IN THE VM, by far the
    // most expensive per-command work in the system, and the 250-command cap below was
    // sized for cheap commands, so 250 constructors is a wholly different unit of work from
    // 250 SENDs. Do not fold this into that cap or drop it because the payload fits.
    // One is the deliberate starting point because the asymmetry is one-way: raising a
    // limit later is a loosening and cheap, lowering one later is a tightening that risks
    // forking a replay.
    this.gatedActionLimits = {};
    this.gatedActionLimits['DEPLOY'] = 1;

    // Distinctness bucket for a MINT TICK that resolves to NO ticker id, under the per-token
    // MINT cap. A Symbol, so it can never collide with a real id key however a wire tick is
    // spelled.
    this.unresolvedTickKey = Symbol('BATCH_UNRESOLVED_TICK');

    // Global per-BATCH command cap (BATCH_ISSUANCE_LIMITS). Every parse-valid
    // sub-command costs an ACTION_INDEX, mappings and (when it fails) an invalid
    // row, so per-command indexer cost dwarfs per-command on-chain cost: the data
    // lanes admit ~744 minimal sub-commands and the envelope lane ~35,000. This is
    // the only bound on the O(N) scans in validate.js, which is why it is checked first.
    this.commandLimit = 250;
}

// The weight budget and the per-ACTION cost-weight table (BATCH_COST_WEIGHTING), with the
// fan-out and VM weight classes entered by their own installers below, in that order.
function installCostWeights(){
    // Weighted cost budget (BATCH_COST_WEIGHTING). The cap above counts sub-commands and
    // charges every one of them 1, which is a proxy for indexer work and a bad one in both
    // directions: EXECUTE runs VM code and is capped at nothing, while 250 minimal SENDs
    // cost far less than 10 DEPLOYs and the count cannot say so. At/after the flag the
    // batch is bounded by the SUM of per-sub-command WEIGHTS instead.
    //
    // THE BUDGET IS DELIBERATELY THE SAME NUMBER AS THE COUNT CAP, and that is the
    // compatibility property rather than a coincidence: with the default weight at 1, the
    // sum over an ordinary batch IS its command count, so every batch carrying no weighted
    // action is admitted or refused exactly as it is today, including the error string. The
    // rule only bites where the flat cap was already wrong. Do not "tidy" these two into one
    // constant: they are equal today and they are separately meaningful, and collapsing them
    // would silently move the pre-flag cap if the budget is ever retuned.
    this.weightBudget = 250;

    // Per-ACTION cost weights (BATCH_COST_WEIGHTING). An action absent from this table
    // weighs the DEFAULT of 1, which is every ordinary action: one ACTION_INDEX, its
    // mappings and at most one invalid-record row, roughly constant whatever the action.
    // ISSUE and its dotted children are deliberately in that class - a child issuance is one
    // row like any other - which is what stops a weighting from repealing bulk child
    // issuance on its first day.
    //
    // EMPTY at this flag's introduction, and that is the whole point of landing it empty:
    // with every weight at the default, the budget check is ARITHMETICALLY IDENTICAL to the
    // count check it replaces, so the machinery can be proven a no-op before any weight is
    // assigned to it. Entries arrive one class at a time, each separately measurable.
    //
    // Keys are canonical post-normalization ACTION names and are matched CASE-SENSITIVELY,
    // exactly like the sibling scans in this handler. That is deliberate: the activation scan
    // in validate.js rejects a mis-cased action as 'invalid: ACTION (unknown)', and upper-casing
    // here would let a weighted spelling reach the budget check first and change which consensus
    // string wins.
    this.commandWeights = {};
    installFanOutWeights.call(this);
    installVmWeights.call(this);
}

// FAN-OUT actions (operator decision 2026-08-14). AIRDROP and DIVIDEND write a row PER
// RECIPIENT, so one sub-command really is worth many. They take a FLAT weight rather
// than the spec's original '1 + recipients', and the reason is that the exact recipient
// count is not knowable here at any acceptable price:
//
//   - it is not on the wire. AIRDROP carries a LIST_ACTION_INDEX, not a list, and
//     DIVIDEND carries only a TICK whose holders are the recipients;
//   - the number that matters is the FILTERED count, not the raw one. airdrop.js
//     resolves the list and then filters it through the token's ALLOW_LIST and
//     BLOCK_LIST; dividend.js fetches every holder, filters the same two ways, and then
//     drops holders whose share rounds to zero at the dividend token's decimals;
//   - so an exact count means re-running each handler's own resolution inside this
//     pre-check. That duplicates consensus logic into a second place it can drift from,
//     and it performs precisely the O(commands x recipients) work the budget exists to
//     prevent, before the batch is even known to be valid.
//
// A flat weight keeps the weight scan free of database reads, which is what lets it stay
// cheap enough to run FIRST, ahead of every other check.
//
// THE NUMBER IS A DELIBERATE STARTING POINT, NOT A MEASUREMENT, and it is chosen HIGH
// for the asymmetry this handler already applies to DEPLOY: for a weight the directions are
// reversed from a limit, so LOWERING one later is a loosening and cheap, while RAISING
// one later is a tightening that risks forking a replay. 25 admits 10 fan-out
// sub-commands per batch. Retune it before the mainnet instant is armed, never after.
function installFanOutWeights(){
    this.commandWeights['AIRDROP']  = 25;
    this.commandWeights['DIVIDEND'] = 25;
}

// VM actions (EXECUTE and XEXEC, and the cost half of the DEPLOY cap). RATIFIED AT 30 BY THE
// OPERATOR ON 2026-08-15, on the measurement in bin/measure-batch-execute-cost.js and
// the 2026-08-14 batch-execute cost-measurement report in the platform tree. This is a consensus
// constant: it decides verdicts, so it may only move behind a flag day.
//
// WHY 30, stated so a future retune can re-derive it rather than guess. A worst-case
// EXECUTE measured 10.7x to 27.4x an ordinary sub-command (pooled 17.9x / 14.9x /
// 18.7x), and a worst-case DEPLOY 13.0x to 29.5x. 30 is the SMALLEST ROUND WEIGHT at
// which a full batch of worst-case VM sub-commands stays under the status-quo bound of
// 250 ordinary ones AT EVERY RATIO OBSERVED: it admits 8 per batch, and 8 x 27.4 is 219
// ordinary-equivalents. Weight 25 admits 10, which is 274 at the same ratio, over by 10%.
// The pooled parity floor is 19, so 30 is above every ratio measured and far below the
// 250 the first proposed weight table gave DEPLOY.
//
// TWO PROPERTIES OF THE MEASUREMENT THAT MUST TRAVEL WITH THE NUMBER:
//  - the cost curve is LINEAR from N=1 to N=50 (r^2 0.9987 / 0.9994), because
//    ProcessExecutor forks one worker and dispatches sequentially and beginBlock/endBlock
//    scope the compile cache per block. So a per-sub-command constant is the right shape
//    and there is no unamortized setup a weight would have to absorb;
//  - WALL TIME IS NOT BOUNDED BY GAS (xchain-vm/src/index.js ~304-306 records a shape
//    burning ~13.5s at ~540k gas), so the architectural worst case is well above the
//    measured one. It IS bounded, identically on every node, by the consensus constant
//    CONSENSUS_MAX_WALL_MS (xchain-vm, 30000 ms), which is the ceiling this weight is
//    measured against: 30 s is ~40x the measured worst case, so any future widening of
//    VM metering coverage still moves this number's grounding and it must be
//    re-derived, never inherited.
//
// XEXEC RIDES WITH EXECUTE HERE, which is the OPPOSITE of its treatment in
// vmBaseFeeActions (fees.js), and the difference is not an inconsistency - the two tables
// measure different things. That one is about what a sub-command COSTS ITS SOURCE, and
// XEXEC is fee-less on this chain, so pricing it there would be an over-estimate and
// wrong. This one is about what a sub-command COSTS THE INDEXER, and an XEXEC runs the
// same contract code an EXECUTE does; leaving it at the default 1 would leave the VM
// class bounded for one spelling and unbounded for the other.
//
// DEPLOY IS WEIGHED, AND IT ALSO KEEPS ITS CAP OF 1 (gatedActionLimits above). Weighing DEPLOY
// at the whole budget looks as if it would reproduce that cap with IDENTICAL behavior; it
// does not, and the proof is short enough to keep here. Today's rule
// is a CONJUNCTION of two independent caps (count <= 250 AND deploys <= 1). For a DEPLOY
// weight w, refusing two DEPLOYs needs 2w > 250, i.e. w >= 126, while keeping the
// valid-today "1 DEPLOY + 249 SENDs" valid needs w + 249 <= 250, i.e. w <= 1. The two are
// contradictory, so NO weight reproduces today's DEPLOY behaviour: a weighted SUM cannot
// express a conjunction of caps. The cap therefore stays exactly where it is - which is
// also what keeps 'invalid: DEPLOY (limit)' being reported from its own loop - and the
// weight expresses only the COST half, i.e. how many companions one DEPLOY may carry
// (220 at weight 30, against 249 today).
//
// CHUNKED DEPLOY (deploy.js format 4) IS DISCOUNTED TO THE DEFAULT WEIGHT OF 1
// (operator ruling 2026-08-20; subCommandWeight in sub_command.js). Before DEPLOY_DEFERRED_ASSEMBLY
// a chunk carrier never runs a constructor (deploy.js short-circuits format 4 into
// DeployChunk.parse() before the VM path), so it is really a row write and 30 would charge
// VM cost for work that has none. At/after that activation the carrier that completes a
// group DOES run the constructor (deploy_chunk.js assembles and deploys it), and
// the discount's real bound is the per-name cap of ONE DEPLOY per batch (the
// 'invalid: DEPLOY (limit)' loop in validate.js): a batch can buy at most the one constructor its
// weight-30 seat already permits, whichever piece completes the group, and a
// non-completing carrier is not over-charged for work it never does.
// A format-drift objection to the discount does not hold up: the format is
// read with the SAME util.getFormatVersion(params[0]) call the dispatcher (actions/index.js)
// uses to set data['FORMAT'], one shared derivation rather than a second one, and
// DEPLOY is outside normalizeSubAction's legacy VERSION injection so params[0] is
// always the explicit version field. The asymmetry still binds for the change itself:
// lowering a weight is a loosening (it can only accept more), and mainnet is ARMED
// at genesis by the 2026-09-09 ruling, so it applies there from block 0.
function installVmWeights(){
    this.commandWeights['DEPLOY']  = 30;
    this.commandWeights['EXECUTE'] = 30;
    this.commandWeights['XEXEC']   = 30;
}

module.exports = { installCountCaps, installCostWeights };
