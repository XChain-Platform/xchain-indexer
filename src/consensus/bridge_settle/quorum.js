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
 * XChain Platform - bridge settle pass: the cross_chain quorum check both applies share.
 *
 * BUILT BY THE ENTRY like canonicals.js, and for the same reason: the stake-weighted quorum
 * activation is an activation module, so the entry owns the capture and this part answers from
 * whatever the entry holds.
 *
 ********************************************************************/

'use strict';

const ed25519 = require('../ed25519.js');

/**
 * @param {Object} deps - { swq: stake_weighted_quorum }, as the ENTRY required it
 */
module.exports = function createQuorum(deps){
    const swq = deps.swq;

    /**
     * The CROSS_SETTLE quorum rule, verbatim (cross_settle.js:144-195), over an already-built
     * canonical. Shared by the transfer and the policy apply so the two can never drift.
     *
     * A signature counts only if its pubkey is in the `cross_chain` set at snapshot_block AND
     * verifies, and a pubkey enters the seen-set only AFTER its signature verifies: marking on
     * first encounter lets a garbage-then-valid pair for one qualified validator suppress the real
     * signature, which fails a quorate row CLOSED. Stake-weighted source-deduped two-thirds at or
     * above STAKE_WEIGHTED_QUORUM_ACTIVATION, else 2f+1.
     *
     * @param {string} canonical
     * @param {*} signaturesJson - the row's validator_signatures column
     * @param {number} snapshotBlock
     * @param {string} network
     * @param {Object} indexerDb
     * @returns {Promise<{met: boolean, snapshotAbsent: boolean, valid: number, total: number}>}
     *          snapshotAbsent true means the capability rows are not mirrored yet, which is a
     *          RETRY and never a refusal
     */
    async function verifyQuorum(canonical, signaturesJson, snapshotBlock, network, indexerDb){
        const weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, network);
        const validators = weighted
            ? await indexerDb.getStakeWeightsByCapability('cross_chain', snapshotBlock)
            : await indexerDb.getValidatorsByCapability('cross_chain', snapshotBlock);
        const N = (validators && validators.length) ? validators.length : 0;
        if(N === 0) return { met: false, snapshotAbsent: true, valid: 0, total: 0 };

        let sigs;
        try { sigs = JSON.parse(signaturesJson || '[]'); } catch(_){ sigs = []; }
        if(!Array.isArray(sigs)) sigs = [];

        const snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        const validSigners = [], seen = new Set();
        for(const s of sigs){
            const pk  = String((s && s.pubkey) || '').toLowerCase();
            const sig = String((s && s.sig) || '').toLowerCase();
            if(seen.has(pk)) continue;
            if(!/^[0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{128}$/.test(sig)) continue;
            if(!snapPubkeys.has(pk)) continue;
            if(!ed25519.verify(canonical, sig, pk)) continue;
            seen.add(pk);
            validSigners.push(pk);
        }
        const met = weighted
            ? swq.meetsStakeThreshold(validators, validSigners)
            : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
        return { met: met, snapshotAbsent: false, valid: validSigners.length, total: N };
    }

    return { verifyQuorum };
};
