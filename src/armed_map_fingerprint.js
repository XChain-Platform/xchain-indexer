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
 * Deployed-process armed-map fingerprint.
 *
 * Services install from release tarballs with no .git and stale package
 * versions, so nothing a process reports says WHICH consensus-gate build it
 * actually runs; before a flag-day height the operator must confirm every
 * deployed process carries the same armed map or a straggler forks/halts at
 * the boundary (this exact mode has previously halted a testnet chain at a
 * flag-day height). This module hashes the byte content of the consensus-gate
 * source files in the RUNNING build, the same byte-identity standard the
 * twin-parity CI gates use, and the health endpoint exposes it, so a fleet
 * sweep can compare one string per process instead of copying files around
 * (bin/check-flagday-deploy.sh remains the deep/manual variant).
 *
 * Exposes per-file sha256 hashes too: gate files that are byte-identical
 * twins across repos (stateHash.js and the *_activation.js set exist in both
 * xchain-indexer and xchain-sync) can be cross-compared service-to-service,
 * while the combined fingerprint compares like-for-like processes of the
 * SAME service. This module is itself a byte-identical twin in both repos
 * (the FIXED_GATE_FILES filter simply matches whichever carriers exist in
 * each repo's src/); keep the two copies in sync.
 *
 ********************************************************************/

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// The gate set is a naming convention PLUS an explicit list, and the list is
// the part that carries the weight. The convention is every *_activation.js in
// this directory, enumerated at call time so a new per-gate arming twin joins
// the set the moment it lands. That alone is not the invariant it reads as:
// several of the highest-consequence armed maps in the tree live in files the
// convention does not match (EQUIV_HEADER_ACTIVATION in equivocation_header.js,
// STAKE_WEIGHTED_QUORUM_ACTIVATION in stake_weighted_quorum.js,
// MIN_STAKE_ACTIVATIONS in capability_min_stake_history.js,
// SNAPSHOT_BURIAL_ACTIVATION in snapshot_reorg_buffer.js), and two more sit one
// directory down where a flat listing cannot see them at all. A process running
// a stale copy of any of those published a fingerprint byte-identical to a
// correctly-armed peer, which is exactly the straggler this module exists to
// expose.
//
// Entries are posix-separated paths relative to this directory; a top-level
// carrier keeps its bare filename as its key, so per-file cross-service
// comparisons of the existing entries are unchanged. ONE list serves both
// repos: an entry naming a carrier this repo does not have drops out of its
// set, which is what lets the two copies stay byte-identical twins. Nothing
// here is self-policing, so the enforcement is a test, not this comment:
// test/unit/armedMapFingerprint.test.js scans src/ for activation-map
// DECLARATIONS and fails on any carrier the set does not cover.
const FIXED_GATE_FILES = [
    'protocol_changes.js',
    'stateHash.js',
    'equivocation_header.js',
    'stake_weighted_quorum.js',
    'capability_min_stake_history.js',
    'snapshot_reorg_buffer.js',
    'consensus-constants.js',
    'protocol/constants.js',
    'attestation/providerMinStakeHistory.js'
];

let cached = null;

function computeArmedMapFingerprint(){
    if(cached) return cached;
    const dir = __dirname;
    const names = Array.from(new Set(
        fs.readdirSync(dir).filter(f => f.endsWith('_activation.js')).concat(FIXED_GATE_FILES)
    )).sort();
    const files = {};
    const outer = crypto.createHash('sha256');
    for(const name of names){
        let fileHash;
        try {
            fileHash = crypto.createHash('sha256')
                .update(fs.readFileSync(path.join(dir, ...name.split('/')))).digest('hex');
        } catch(e){
            // Absent is not unreadable, and the difference is the shared list: a
            // carrier only the OTHER repo has drops out here instead of poisoning
            // this repo's fingerprint. Any other read failure is a file we claim
            // to hash and could not, which must poison it visibly rather than
            // silently matching a healthy process.
            if(e && e.code === 'ENOENT') continue;
            fileHash = 'UNREADABLE';
        }
        files[name] = fileHash;
        outer.update(name).update('\0').update(fileHash).update('\0');
    }
    cached = { fingerprint: outer.digest('hex'), files: files };
    return cached;
}

module.exports = { computeArmedMapFingerprint };
