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
    ['attest_response_mirror_activation',       ['ATTEST_RESPONSE_MIRROR_ACTIVATION']]
];

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

// { digest, gates: { '<module>.<EXPORT>': '<canonical value>' } }.
// `gates` is returned so a mismatch can be explained gate by gate instead of as
// two opaque hashes; nothing about a bare digest tells an operator what to fix.
function computeConsensusRulesDigest(){
    if (cached) return cached;
    const gates = {};
    for (const [mod, names] of SHARED_GATES) {
        let m = null;
        try { m = require('./' + mod + '.js'); } catch (e) { m = null; }
        for (const name of names) {
            const key = mod + '.' + name;
            gates[key] = (m && Object.prototype.hasOwnProperty.call(m, name))
                ? canonical(m[name]) : ABSENT;
        }
    }
    const preimage = Object.keys(gates).map(k => k + '=' + gates[k]).join('\n');
    cached = { digest: crypto.createHash('sha256').update(preimage).digest('hex'), gates: gates };
    return cached;
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
    canonical,
    computeConsensusRulesDigest,
    diffGates
};
