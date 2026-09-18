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
 * XChain Platform Action - XEXEC : dispatch quorum
 *
 * The cross_chain signature check over a mirrored dispatch row, against the
 * capability snapshot pinned at its snapshot_block. Called with the XEXEC
 * handler as `this` (see ../xexec.js), whose canonical() it verifies over.
 *
 ********************************************************************/

'use strict';

const ed25519 = require('../../consensus/ed25519.js');
const swq     = require('../../consensus/stake_weighted_quorum.js');

// Verify the cross_chain quorum over the dispatch canonical.
// Stake-weighted (source-deduped 3·Σ>2·S) at/above STAKE_WEIGHTED_QUORUM
// (BTC snapshot_block + network), else legacy 2f+1 signer count. Returns
//   { synced:false }                            - capability snapshot not mirrored yet (defer)
//   { synced:true, quorumMet, N, validSigners } - snapshot present; quorum verdict
// The caller owns what a verdict means for the block (defer, record a refusal,
// or run the call), so this reads no state and writes none.
async function verifyDispatchQuorum(c){
    let snapshotBlock = Number(c.snapshot_block);
    let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, c.network);
    let validators = weighted
        ? await this.indexerDb.getStakeWeightsByCapability('cross_chain', snapshotBlock)
        : await this.indexerDb.getValidatorsByCapability('cross_chain', snapshotBlock);
    let N = (validators && validators.length) ? validators.length : 0;
    if(N === 0) return { synced: false, quorumMet: false, N: 0, validSigners: [], weighted };

    let sigs;
    try { sigs = JSON.parse(c.validator_signatures || '[]'); }
    catch(_) { sigs = []; }

    let canonical = this.canonical(c);
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
        // quorum under-count, failing a quorate injection closed).
        seen.add(pk);
        validSigners.push(pk);
    }
    let quorumMet = weighted
        ? swq.meetsStakeThreshold(validators, validSigners)
        : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
    return { synced: true, quorumMet, N, validSigners, weighted };
}

module.exports = { verifyDispatchQuorum };
