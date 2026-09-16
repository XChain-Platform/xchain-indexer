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
 * The CROSS_SETTLE trust boundary: does the mirrored match carry a `cross_chain`
 * quorum over its canonical bytes, against the SAME locked capability snapshot the
 * hub tallied? Nothing in this file moves funds or writes a row; a match that does
 * not clear the bar simply never settles.
 *
 * Kept out of the handler entry so the signature work reads on one screen and so
 * the two failure modes stay visibly different: a snapshot that is not mirrored yet
 * DEFERS (retried on a later block), while a genuinely short quorum SKIPS.
 *
 * Called with the handler as `this`, the way execute/slash_emission.js is.
 *
 ********************************************************************/

'use strict';

const ed25519 = require('../../consensus/ed25519.js');
const swq     = require('../../consensus/stake_weighted_quorum.js');

const { getLogger } = require('../../observability/index.js');

/**
 * Verify the cross_chain quorum signatures over the canonical match.
 * At/above STAKE_WEIGHTED_QUORUM (keyed on the BTC snapshot_block + network)
 * the bar is summed signer STAKE > 2/3 of S, deduped by staking source;
 * below it, the legacy 2f+1 signer COUNT. Both verify against the SAME locked
 * snapshot the hub used, so hub and indexer agree without trust.
 *
 * Called with the handler as `this` (it reads this.indexerDb and builds the canonical
 * with this.canonical). The canonical is built only after the snapshot check and the
 * signature parse, as the handler always built it: canonical() can throw on a row
 * whose admission columns disagree with its era, and an unsynced snapshot must defer
 * such a row, not abort the block.
 *
 * @param {Object} m - the mirrored cross_chain_matches row
 * @returns {Promise<boolean>} true only when the match may settle on this chain
 */
async function verifyMatchQuorum(m){

    let snapshotBlock = Number(m.snapshot_block);
    let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, m.network);
    let validators = weighted
        ? await this.indexerDb.getStakeWeightsByCapability('cross_chain', snapshotBlock)
        : await this.indexerDb.getValidatorsByCapability('cross_chain', snapshotBlock);
    let N = (validators && validators.length) ? validators.length : 0;
    if(N === 0){
        // The capability snapshot for this block isn't mirrored yet. In distributed mode
        // the block loop's snapshot-sync barrier (HubDbSync.waitForSnapshotSync) front-stops
        // this by deferring the whole block until the snapshot is present, so every operator
        // settles the match at the same height; this early-return is a defensive guard for
        // the residual race / single-host path. The match stays unsettled + effective and
        // retries on a later block. NOT an error. (Deterministic quorum-N under PARTIAL
        // snapshot arrival is sealed separately by the multi-node design; presence here.)
        getLogger().info("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : capability snapshot not synced : deferring');
        return false;
    }

    let sigs;
    try { sigs = JSON.parse(m.validator_signatures || '[]'); }
    catch(_) { sigs = []; }

    let canonical = this.canonical(m);
    let validSigners = collectValidSigners(validators, sigs, canonical);
    let quorumMet = weighted
        ? swq.meetsStakeThreshold(validators, validSigners)
        : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
    if(!quorumMet){
        // Genuinely insufficient quorum (the snapshot IS present). Do not
        // record a settlement; a malformed/forged match never settles.
        getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : insufficient ' + (weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + N + ')') + ' : skipping');
        return false;
    }

    return true;
}

/**
 * Collect the distinct pubkeys that produced a valid signature AND are in the
 * locked snapshot (presence in the snapshot = qualified, same membership the
 * hub tallied). Used by both the weighted predicate and the count check.
 *
 * @param {Array<Object>} validators - the locked snapshot rows, each carrying a pubkey
 * @param {Array<Object>} sigs       - the row's validator_signatures, already parsed
 * @param {string}        canonical  - the canonical signing string
 * @returns {Array<string>} the qualified signer pubkeys, lower-case and deduped
 */
function collectValidSigners(validators, sigs, canonical){
    let snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
    let validSigners = [], seen = new Set();
    for(let s of sigs){
        let pk  = String(s.pubkey || '').toLowerCase();
        let sig = String(s.sig || '').toLowerCase();
        if(seen.has(pk)) continue;
        if(!/^[0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{128}$/.test(sig)) continue;
        if(!snapPubkeys.has(pk)) continue;
        if(!ed25519.verify(canonical, sig, pk)) continue;
        // Mark seen only AFTER the signature verifies, matching the hub
        // finalizer and the SDK/explorer/sync verifiers (and anchor.js):
        // marking on first encounter lets a garbage-then-valid pair for one
        // qualified validator suppress the real signature (order-dependent
        // quorum under-count, fails quorate settlements closed).
        seen.add(pk);
        validSigners.push(pk);
    }
    return validSigners;
}

module.exports = {
    verifyMatchQuorum
};
