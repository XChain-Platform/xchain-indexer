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
 * Consensus-rules digest: what activation rules is THIS process running?
 *
 * WHY THIS EXISTS. A flag-day change to a consensus rule splits the network
 * into processes that apply it and processes that do not, and today that split
 * is INVISIBLE until it has already produced divergent state. A replica behind
 * xchain-sync at least halts on the state-hash compare; a standalone indexer
 * simply carries a different ledger and says nothing, and a hub running older
 * rules quietly stops agreeing with the federation it thinks it is part of. The
 * operator finds out from a stuck explorer hours later, which is exactly how
 * the 2026-09-02 TDOGE replica halt was found.
 *
 * WHAT IT IS. A digest over the VALUES of every activation map that BOTH the
 * hub and the indexer evaluate. Value-based, not file-based, and that
 * distinction is the whole design:
 *
 *   - armedMapFingerprint.js (indexer, xchain-sync) hashes FILE BYTES of that
 *     repo's own src/. It answers "is this process running the build I think
 *     it is", and two different repos can never share an answer, because they
 *     do not share files. It is the right tool for comparing two indexers.
 *   - This digest hashes the DECIDED HEIGHTS. It answers "do you and I apply
 *     the same rules to the same chain", which is the question that actually
 *     predicts divergence, and it is comparable ACROSS repos: a hub and an
 *     indexer running the same flag days produce the same digest even though
 *     they share no source file.
 *
 * A comment reformat therefore changes the fingerprint and not the digest,
 * which is correct: prose cannot fork a chain, a height can.
 *
 * SHARED_GATES is deliberately a hardcoded intersection rather than a
 * directory scan. Each repo carries activation maps the other does not (the
 * indexer alone has ~20 that no hub evaluates), so a scan would make the two
 * sides disagree by construction and the digest would be useless for exactly
 * the comparison it exists to serve. A gate this repo does not carry
 * contributes the ABSENT sentinel rather than being skipped, so a build that
 * LOSES a gate is a mismatch rather than an invisible shortening of the list.
 *
 * BYTE-TWIN of xchain-hub/src/consensus_rules_digest.js. The two copies
 * must agree or every cross-process comparison reports a false mismatch and
 * the alarm trains its operators to ignore it, which is worse than no alarm.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// The activation maps BOTH repos evaluate, as [module basename, [export names]].
// Order is fixed and part of the digest preimage; append new gates at the END so
// an added gate is a visible mismatch against older builds rather than a silent
// reordering of everything after it.
const SHARED_GATES = [
    ['anchor_reward_activation',                ['ANCHOR_REWARD_ACTIVATION', 'ARCHIVE_REWARD_ACTIVATION', 'ANCHOR_REWARD_DERIVE_ACTIVATION']],
    ['attest_relay_activation',                 ['ATTEST_RELAY_ACTIVATION']],
    ['checkpoint_commitment_activation',        ['CHECKPOINT_COMMITMENT_ACTIVATION']],
    ['cross_chain_royalty_activation',          ['CROSS_CHAIN_ROYALTY_ACTIVATION']],
    ['equivocation_header',                     ['EQUIV_HEADER_ACTIVATION']],
    ['price_pair_activation',                   ['PRICE_PAIR_WIDEN_ACTIVATION']],
    ['price_sig_tally_activation',              ['PRICE_SIG_TALLY_ACTIVATION']],
    ['retraction_signing_activation',           ['RETRACTION_SIGNING_ACTIVATION']],
    ['rollcall_activation',                     ['ROLLCALL_ACTIVATION']],
    ['snapshot_reorg_buffer',                   ['SNAPSHOT_BURIAL_ACTIVATION']],
    ['stake_weighted_quorum',                   ['STAKE_WEIGHTED_QUORUM_ACTIVATION']],
    ['attest_responsible_widening_activation',  ['ATTEST_RESPONSIBLE_WIDENING_ACTIVATION', 'ATTEST_RESPONSIBLE_WIDENING']],
    // Unratified on mainnet and testnet (both null): this row moves the digest for a
    // gate that decides nothing yet, so an upgraded hub reports a rules mismatch
    // against un-upgraded peers during the deploy wave, not a divergent ledger.
    ['attest_response_mirror_activation',       ['ATTEST_RESPONSE_MIRROR_ACTIVATION']],
    // The zero-confirmation flip (one height for serve-at-tip, the stage-2 ladder and the
    // applier fall-through) and the stage-2 ladder constants it selects. The V2 constants
    // are a second entry for the widening module rather than an edit of its entry above,
    // because an insertion mid-list would reorder the preimage of everything after it.
    ['attest_zero_conf_activation',             ['ATTEST_ZERO_CONF_ACTIVATION']],
    ['attest_responsible_widening_activation',  ['ATTEST_RESPONSIBLE_WIDENING_V2']],
    // Epoch-keyed: ROLLCALL v1 with the GATES field, and the rules-aware capability set.
    ['rollcall_gates_activation',               ['ROLLCALL_GATES_ACTIVATION']],
    // COIN-KEYED ('<COIN>:<network>' with the bare network key as fallback), the first
    // shared gate of that shape: XBRIDGE arms one height per chain because TBTC, TLTC and
    // TDOGE tips differ by orders of magnitude. activeGatesAt resolves both forms below.
    ['xchain_bridge_activation',                ['XCHAIN_BRIDGE_ACTIVATION']],
    // The time-keyed mirror barrier family. Registered here where the parent spec's own
    // anchor-attest gate declined to be, and the reason is the hub's side of the rule: that
    // gate was indexer-only, so the hub evaluated neither of its constants and a shared entry
    // would have been dead weight. The hub evaluates all three of THIS family's rules (the
    // follower admission bound, the producer era gate and the admission stamp it signs), so an
    // upgraded hub MUST report a rules mismatch against un-upgraded peers during the deploy
    // wave rather than silently signing rows their consumers bind at a different block.
    // Appended at the END: an insertion mid-list reorders the preimage of everything after it.
    ['mirror_admission_activation',             ['MIRROR_ADMISSION_ACTIVATION', 'MIRROR_ADMISSION_CONSUMER_ACTIVATION', 'ADMIT_MARGIN_BLOCKS', 'ADMIT_MIN_FUTURE_BLOCKS', 'ADMIT_MAX_FUTURE_BLOCKS']],
    // The family's anchor-attest member: the maturity-horizon height and the arrival margin it
    // reads. A second entry for anchor_reward_activation rather than an edit of its entry
    // above, for the same preimage-ordering reason.
    ['anchor_reward_activation',                ['ANCHOR_ATTEST_BARRIER_ACTIVATION', 'ANCHOR_ATTEST_ARRIVAL_MARGIN_S']],
    // The admission canonical ENCODER and its era gate, which moved into that module when the
    // price rail joined the family: the hub signs the admission field and every indexer
    // rebuilds it, so two builds spelling one map differently is a fork rather than a stall.
    // Registered because the BYTES a price round is signed over move at the activation, so an
    // upgraded build must report a rules mismatch against un-upgraded peers during the deploy
    // wave. What these rows can and cannot see: a function canonicalizes to `undefined` and a
    // regex to '{}', so they alarm on PRESENCE and never on a changed function BODY; the body
    // is held by the byte compare of the two copies of the module, which is a test rather than
    // a digest row. A SECOND entry for the module at the END rather than names added to its
    // entry above, because an insertion mid-list shifts the preimage of every gate after it.
    ['mirror_admission_activation',             ['CHAIN_CODE_RE', 'CANONICAL_HEIGHT_RE', 'encodeAdmitBlocks',
                                                 'decodeAdmitBlocks', 'isAdmissionEra', 'admissionCanonicalField']]
];

// A per-network height at or above this value is a far-future placeholder, not an
// activation (PRICE_PAIR_WIDEN_ACTIVATION.mainnet is the live example), and activeGatesAt
// must never report such a gate as active however high the chain climbs.
const FAR_FUTURE_HEIGHT_SENTINEL = 9999999999;

const ABSENT = '<absent>';

// Canonical JSON with object keys sorted, so two builds that spell the same map
// with its networks in a different order still digest alike. JSON.stringify's
// insertion order is not a property either repo should be forced to preserve.
function canonical(value){
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (typeof value === 'object') {
        return '{' + Object.keys(value).sort()
            .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value);
}

let cached = null;
let cachedValues = null;

// The activation registry, reachable at this one path in every repo that carries this
// module. Every shared gate VALUE is a row of it, keyed exactly as SHARED_GATES spells it.
const registry = require('./consensus/gate_registry');

// One shared gate's value: the registry row under '<module>.<EXPORT>', which THROWS a
// RegistryMissError naming the key rather than reading null. A row a build lacks is a
// build defect and never a network state; a null returned here instead let a MOVED
// carrier read as ABSENT while the signed GATES field stayed byte for byte what every
// peer publishes, a rules fork no wire field named.
//
// The one legitimate miss is a name that is a FUNCTION on the carrier (the admission
// encoder and era gate: a registry holds values, and a function's entry alarms on
// presence alone, see SHARED_GATES). Those are read from the carrier at src/<mod>.js,
// and anything but a function there rethrows the miss. A carrier that is not there is
// a build defect too, never ABSENT, and a carrier that IS there and fails to load throws
// for the reason it always did: swallowing that yields 87637dfa instead of 26ba9cce in
// a checkout without node_modules, since stake_weighted_quorum.js requires mathjs, and
// two revisions measured that way FALSELY MATCH.
function loadGateValue(mod, name){
    const key = mod + '.' + name;
    try {
        return registry.get(key);
    } catch (miss) {
        if (!miss || miss.name !== 'RegistryMissError') throw miss;
        const file = path.join(__dirname, mod + '.js');
        if (!fs.existsSync(file)) {
            throw new Error('consensus-rules gate ' + key + ' has no registry row and no carrier at src/'
                + mod + '.js, so no digest can be computed');
        }
        let carrier;
        try {
            carrier = require(file);
        } catch (e) {
            throw new Error('consensus-rules gate ' + mod + ' is present at src/' + mod
                + '.js but failed to load, so no digest can be computed: '
                + ((e && e.message) ? e.message : String(e)));
        }
        if (typeof carrier[name] === 'function') return carrier[name];
        throw miss;
    }
}

// The RAW value of every shared gate, keyed '<module>.<EXPORT>'. Read once: the digest
// and the active-set derivation below must see the same values, and neither the
// registry nor a gate module is re-read after boot. ABSENT is no longer produced here;
// it remains the sentinel diffGates uses for a key a PEER's map lacks.
function loadGateValues(){
    if (cachedValues) return cachedValues;
    const values = {};
    for (const [mod, names] of SHARED_GATES) {
        for (const name of names) values[mod + '.' + name] = loadGateValue(mod, name);
    }
    cachedValues = values;
    return cachedValues;
}

// { digest, gates: { '<module>.<EXPORT>': '<canonical value>' } }.
// `gates` is returned so a mismatch can be explained gate by gate instead of as
// two opaque hashes; nothing about a bare digest tells an operator what to fix.
function computeConsensusRulesDigest(){
    if (cached) return cached;
    const values = loadGateValues();
    const gates = {};
    for (const key of Object.keys(values)) {
        gates[key] = values[key] === ABSENT ? ABSENT : canonical(values[key]);
    }
    const preimage = Object.keys(gates).map(k => k + '=' + gates[k]).join('\n');
    cached = { digest: crypto.createHash('sha256').update(preimage).digest('hex'), gates: gates };
    return cached;
}

// Every shared gate this build knows, '<module>.<EXPORT>', sorted. This is the list a
// ROLLCALL v1 publisher puts on the wire (the GATES field): what the build KNOWS, active
// or not, so a subset comparison against activeGatesAt at any later height stays true.
function knownGateKeys(){
    return Object.keys(loadGateValues()).sort();
}

// The activation height a gate MAP declares for `network`, or undefined when it declares
// none. Two key forms are legal: the plain network key every gate but one uses, and the
// coin-keyed '<COIN>:<network>' form XCHAIN_BRIDGE_ACTIVATION uses with the bare network
// key as its fallback.
//
// With `coin` named the resolution matches the gate module's own resolver exactly: the
// coin's key when the map declares one, otherwise the bare network key.
//
// With no coin named the EARLIEST armed key for the network decides. A GATES list states
// what a BUILD applies and one build serves every chain on a network, so the first chain
// to arm is the block from which a build lacking the gate is running different rules.
// Reading the bare key alone would report such a gate inactive forever, because an arming
// train sizes one height per chain and leaves the bare fallback on the far-future sentinel.
function networkActivationHeight(map, network, coin){
    if (coin != null) {
        const keyed = map[String(coin) + ':' + network];
        if (keyed !== undefined) return keyed;
        return Object.prototype.hasOwnProperty.call(map, network) ? map[network] : undefined;
    }
    const suffix = ':' + network;
    let earliest = undefined;
    let declared = false;
    for (const k of Object.keys(map)) {
        if (k !== network && !(k.length > suffix.length && k.endsWith(suffix))) continue;
        declared = true;
        const at = map[k];
        if (!Number.isFinite(at) || at >= FAR_FUTURE_HEIGHT_SENTINEL) continue;
        if (earliest === undefined || at < earliest) earliest = at;
    }
    if (earliest !== undefined) return earliest;
    // Nothing armed for this network: hand back the bare value so the caller's own
    // sentinel and null checks report it inactive for the reason it is inactive.
    return declared ? map[network] : undefined;
}

// The shared gates ACTIVE at `height` on `network`, '<module>.<EXPORT>', sorted: every
// per-network activation MAP whose entry for the network is a finite height, below the
// far-future sentinel, and <= height. Non-map exports (frozen ladder constants such as
// ATTEST_RESPONSIBLE_WIDENING) are never active in this sense and are never listed; a
// null entry is the unratified sentinel and reads as inactive. This is the comparand the
// rules-aware capability set filters on: a validator whose last rolled call did not name
// every key returned here is dropped for a request at this height.
//
// `coin` is optional and only changes the answer for a coin-keyed gate: pass the chain
// being judged to get that chain's own activation, omit it to get the network-wide answer
// (active from the first chain that arms), which is what a caller holding only a height
// and a network needs.
function activeGatesAt(height, network, coin){
    let h = Number(height);
    if (!Number.isFinite(h)) return [];
    const values = loadGateValues();
    const out = [];
    for (const key of Object.keys(values)) {
        const v = values[key];
        if (v === ABSENT || v === null || typeof v !== 'object' || Array.isArray(v)) continue;
        const at = networkActivationHeight(v, network, coin);
        if (at === undefined) continue;
        if (!Number.isFinite(at) || at >= FAR_FUTURE_HEIGHT_SENTINEL) continue;
        if (at <= h) out.push(key);
    }
    return out.sort();
}

// The gate names whose values differ between two `gates` maps, sorted. A gate
// missing from EITHER side counts as differing: comparing only shared keys would
// hide precisely the build that dropped a gate.
function diffGates(a, b){
    const out = [];
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        const av = (a && a[k] !== undefined) ? a[k] : ABSENT;
        const bv = (b && b[k] !== undefined) ? b[k] : ABSENT;
        if (av !== bv) out.push(k);
    }
    return out.sort();
}

module.exports = {
    SHARED_GATES,
    ABSENT,
    FAR_FUTURE_HEIGHT_SENTINEL,
    canonical,
    computeConsensusRulesDigest,
    knownGateKeys,
    activeGatesAt,
    diffGates
};
