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
 * Platform-train consensus activation gate (release-management section 13).
 *
 * WHAT THIS IS AND WHY IT IS NOT ONE OF THE ~30 FEATURE GATES BESIDE IT.
 * Every other *_activation.js module here is a per-feature flag day: a height
 * chosen by whoever wrote the feature, months before the code ships, evaluated
 * by code that already carries both branches. That machinery is correct and
 * stays. It is not a train gate, for one reason that matters more than the
 * others: it is SILENT FOR THE NODE THAT NEVER UPDATED. A lagging node does not
 * carry the new branch, so it never evaluates the new flag day at all. It keeps
 * applying the old rule past the activation height, derives divergent state, and
 * serves it as if it were canonical. The node furthest behind is the one the
 * feature-gate mechanism warns least.
 *
 * TRAIN_ACTIVATION closes that. It is keyed by PLATFORM VERSION rather than by
 * feature, so a MAJOR train adds exactly ONE row and every consensus change the
 * train carries branches on the rule set that row names: a train's changes cannot
 * half-activate. And it carries the one behavior the feature gates do not, below.
 *
 * HALT, NEVER CONTINUE-OLD. A node whose code carries no entry for the rule set
 * its SIGNED RELEASE MANIFEST requires STOPS advancing at the activation height.
 * It does not apply the first block at or above that height under the old rules.
 * Continue-old is the strictly worse failure and this platform already
 * demonstrates why: the sync followers recompute state roots and halt on
 * divergence, so a lagging node that continued under the old rules would halt
 * anyway, one block later, AFTER it had written forked state and answered queries
 * from it. Halting at the boundary turns a silent fork into a visibly down node.
 * A down node is an operator page; a forked node reaches users through the
 * explorer and the wallet first and is expensive to unwind.
 *
 * THE HALT IS ANNOUNCED BEFORE IT FIRES. From the moment the manifest names a
 * rule-set version this code does not implement, the verdict is `pending` with
 * the height and the version needed, which health reports and the monitor alerts
 * on. An operator who ignores every publication surface and only watches alerts
 * still learns before the boundary rather than at it. A halt that surprises the
 * operator is a publication failure, not a gate failure.
 *
 * THE CLOCK. BTC block height per network, the same clock the cross-cutting
 * feature gates use, never a wall-clock date: protocol time off mainnet is
 * median-time-past, and a date gate on a chain whose difficulty can stall for
 * hours arms at an hour nobody chose. A BTC indexer's own block_index IS that
 * clock. An LTC or DOGE indexer has no BTC height in its pre-apply path, so it
 * passes `height: null`, and a null clock with an unimplemented required rule set
 * is a HALT rather than a pass: a node that cannot prove the boundary is still
 * ahead of it must not advance. This is deliberately stricter than the BTC case
 * and costs nothing in the intended flow, because a node that DOES implement the
 * required rule set is clear at any height, with or without a clock. Only a
 * lagging off-BTC node halts early, which is the outcome the gate wants anyway.
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js,
 * kept value-equal by test/unit/activationConstantsParity.test.js. A byte-identical
 * twin lives at xchain-sync/src/train_activation.js. A one-sided edit of any copy
 * forks the fleet at the train boundary, which is the whole class of failure this
 * file exists to prevent.
 *
 ********************************************************************/

'use strict';

// Keyed by platform version, then network, to a BTC block height. Only MAJOR
// trains and consensus-classified hotfixes get a row; a MINOR or PATCH train adds
// none, and resolveRuleSet then keeps the fleet on the previous entry with no
// ceremony change. Regtest is 0 on every row because regtest stacks are rebuilt
// from genesis and so exercise the new rule set end to end rather than the
// migration. Mainnet is armed ABOVE the tip at cut time on purpose: the fleet runs
// the new binary under the OLD rules until that height, which is the rolling-upgrade
// window. Nothing here is edited outside a train cut.
const TRAIN_ACTIVATION = {
    // The launch rule set and the floor. Zero on every network because there is no
    // earlier rule set to migrate from: the launch binary IS the first rule set, and
    // a floor above genesis would leave the pre-floor range resolving to nothing.
    '1.0.0': { mainnet: 0, testnet: 0, regtest: 0 },
};

// X.Y.Z -> [major, minor, patch], or null for anything that is not a bare
// three-part version. Nothing here accepts a prerelease or build suffix: a
// platform version is the train's own version and the ceremony never cuts one.
function parseRuleSetVersion(v){
    let m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v === null || v === undefined ? '' : v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Ordering over rule-set versions. Throws on an unparseable side rather than
// sorting it to an arbitrary end: a version this code cannot order is a version it
// cannot reason about, and silently ordering it would decide a consensus boundary
// by accident.
function compareRuleSetVersions(a, b){
    let pa = parseRuleSetVersion(a);
    let pb = parseRuleSetVersion(b);
    if(!pa) throw new Error('TRAIN_ACTIVATION: unparseable rule-set version ' + JSON.stringify(a));
    if(!pb) throw new Error('TRAIN_ACTIVATION: unparseable rule-set version ' + JSON.stringify(b));
    for(let i = 0; i < 3; i++){ if(pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; }
    return 0;
}

// The rule-set versions THIS BUILD implements, ascending. "Implements" is read off
// the map rather than declared separately on purpose: the row and the code that
// branches on it ship in the same commit, so the map is the honest record of what
// the binary can apply. A separate declaration is a second copy to forget.
function implementedRuleSets(activation){
    let map = activation || TRAIN_ACTIVATION;
    return Object.keys(map).sort(compareRuleSetVersions);
}

// A network's activation height for one rule set, or null when the row does not
// name that network. Null is NOT zero: a missing network is "undecided", which the
// callers below treat fail-closed, while zero means active from genesis.
function activationHeightFor(version, network, activation){
    let map = activation || TRAIN_ACTIVATION;
    let row = map[version];
    if(!row || typeof row !== 'object') return null;
    return asHeight(row[network]);
}

// The active rule set at BTC height `height` on `network`: the entry with the
// greatest activation height at or below it among the entries THIS CODE CARRIES.
// Consensus code branches on this resolved version, never on the node's own package
// version and never on a per-feature constant when the change ships in a MAJOR
// train, so one train is one branch point. Returns null when the height is below
// every entry this build carries (or the clock is unusable), which is a state the
// launch floor of 0 makes unreachable in practice and is reported rather than
// guessed at.
// Numeric height, or null for anything that is not one. Number(null) is 0 and
// Number('') is 0, so a bare Number() here would silently turn "this service has no
// BTC clock" into "we are at genesis" and read the launch floor as active. That
// coercion is the difference between a fail-closed halt and a silent fork.
function asHeight(v){
    if(v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    let h = Number(v);
    return Number.isFinite(h) ? h : null;
}

function resolveRuleSet(height, network, activation){
    let h = asHeight(height);
    if(h === null) return null;
    let map = activation || TRAIN_ACTIVATION;
    let best = null;
    for(const version of implementedRuleSets(map)){
        let at = activationHeightFor(version, network, map);
        if(at === null || at > h) continue;
        if(best === null || compareRuleSetVersions(version, best) > 0) best = version;
    }
    return best;
}

// Read a manifest's `trainActivation` block into the shape the verdict below wants,
// or null when the manifest carries none (which is every MINOR and PATCH train and
// is not a fault). A block that is present but malformed comes back as a
// `malformed` record rather than null: "the manifest says something this code cannot
// read" must never reach a caller as "the manifest says nothing".
function readManifestTrainActivation(manifest){
    if(!manifest || typeof manifest !== 'object') return null;
    let block = manifest.trainActivation;
    if(block === null || block === undefined) return null;
    if(typeof block !== 'object' || Array.isArray(block))
        return { malformed: 'trainActivation is not an object' };
    let version = block.ruleSetVersion;
    if(!parseRuleSetVersion(version))
        return { malformed: 'trainActivation.ruleSetVersion is not a bare X.Y.Z (' + JSON.stringify(version) + ')' };
    if(!block.heights || typeof block.heights !== 'object' || Array.isArray(block.heights))
        return { malformed: 'trainActivation.heights is not an object' };
    return {
        ruleSetVersion: String(version).trim(),
        heights: block.heights,
        computedFromBtcTip: (block.computedFromBtcTip && typeof block.computedFromBtcTip === 'object')
                                ? block.computedFromBtcTip : null,
        classification: block.classification || null
    };
}

// THE PRE-APPLY VERDICT. Called before a block is applied, and the only thing that
// may stop it. Three outcomes:
//
//   clear   - nothing requires a rule set this build does not implement. Apply.
//   pending - the manifest requires one, and the boundary is still ahead. Apply, and
//             say so loudly on every observability surface until it is resolved.
//   halt    - the boundary is reached, or cannot be proven to be ahead. Do not apply.
//
// `required` is the manifest block from readManifestTrainActivation (or a raw
// manifest, which is read here for convenience). `height` is the BTC height of the
// block about to be applied, or null when this service has no BTC clock.
function evaluateTrainActivation(opts){
    let o = opts || {};
    let network = (o.network === null || o.network === undefined) ? null : String(o.network);
    let activation = o.activation || TRAIN_ACTIVATION;
    let clock = asHeight(o.height);
    let active = resolveRuleSet(clock, network, activation);

    let required = o.required !== undefined ? o.required : readManifestTrainActivation(o.manifest);
    if(required && required.ruleSetVersion === undefined && required.malformed === undefined)
        required = readManifestTrainActivation(required);

    const base = {
        status: 'clear',
        activeRuleSet: active,
        requiredRuleSet: null,
        requiredAtHeight: null,
        network: network,
        height: clock,
        classification: null,
        reason: null
    };

    if(!required) return base;

    // A manifest block this code cannot read is fail-closed. The alternative is
    // treating an unreadable requirement as no requirement, which is the silent
    // fork the whole section exists to prevent.
    if(required.malformed){
        return Object.assign(base, {
            status: 'halt',
            reason: 'train_activation: the release manifest carries a trainActivation block this build ' +
                    'cannot read (' + required.malformed + '), so the required rule set cannot be ' +
                    'determined; refusing to advance'
        });
    }

    const wanted = required.ruleSetVersion;
    base.classification = required.classification || null;

    // The manifest requires a rule set this build implements. Nothing to do, at any
    // height, with or without a clock: this node can apply both sides of the boundary.
    if(implementedRuleSets(activation).indexOf(wanted) !== -1) return base;

    // From here the build does NOT implement the required rule set. Everything below
    // is about whether the boundary has been crossed yet.
    let at = required.heights ? asHeight(required.heights[network]) : null;

    const carries = 'platform version ' + wanted + ' carries it; recover with the node update command, ' +
                    'which installs the pinned component set from the signed manifest';

    if(at === null){
        return Object.assign(base, {
            status: 'halt',
            requiredRuleSet: wanted,
            reason: 'train_activation: the release manifest requires rule set ' + wanted + ', which this ' +
                    'build does not implement, and names no activation height for network ' +
                    JSON.stringify(network) + ', so the boundary cannot be proven to be ahead. ' + carries
        });
    }

    // No clock. Cannot prove the boundary is still ahead, so it is treated as
    // reached. Deliberately stricter than the BTC case; see the header.
    if(clock === null){
        return Object.assign(base, {
            status: 'halt',
            requiredRuleSet: wanted,
            requiredAtHeight: at,
            reason: 'train_activation: the release manifest requires rule set ' + wanted + ' at BTC height ' +
                    at + ' on ' + network + ', which this build does not implement, and this service has no ' +
                    'BTC height to compare against, so the boundary cannot be proven to be ahead. ' + carries
        });
    }

    if(clock >= at){
        return Object.assign(base, {
            status: 'halt',
            requiredRuleSet: wanted,
            requiredAtHeight: at,
            reason: 'train_activation: block at BTC height ' + clock + ' is at or above the ' + wanted +
                    ' activation height ' + at + ' on ' + network + ', and this build does not implement ' +
                    'rule set ' + wanted + '. Applying it under the old rules would fork. ' + carries
        });
    }

    return Object.assign(base, {
        status: 'pending',
        requiredRuleSet: wanted,
        requiredAtHeight: at,
        reason: 'train_activation: the release manifest requires rule set ' + wanted + ' from BTC height ' +
                at + ' on ' + network + ', which this build does not implement. This node will HALT at that ' +
                'height, in ' + (at - clock) + ' block(s). ' + carries
    });
}

module.exports = {
    TRAIN_ACTIVATION,
    parseRuleSetVersion,
    compareRuleSetVersions,
    implementedRuleSets,
    activationHeightFor,
    asHeight,
    resolveRuleSet,
    readManifestTrainActivation,
    evaluateTrainActivation
};
