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
 * XChain Indexer - ATTEST handler part
 *
 * Cross-chain relay helpers: the two canonicals, the shared signature tail and the cross_chain quorum.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const crypto  = require('crypto');
const ed25519 = require('../../consensus/ed25519.js');
const swq     = require('../../consensus/stake_weighted_quorum.js');
const eq      = require('../../consensus/equivocation_header.js');
const srb     = require('../../consensus/snapshot_reorg_buffer.js');

module.exports = {
    // Cross-chain relay helpers

    // True when `request` is one leg of a relay whose contract lives on ANOTHER
    // chain, i.e. the BTC row a v3 materialized. The callback paths consult this
    // because executing a callback against a foreign contract_index is meaningless
    // locally. A native request has origin_chain NULL; an origin-side relay row has
    // origin_chain equal to this coin, so both answer false.
    isForeignOrigin(request){
        let origin = request && request.origin_chain;
        return Boolean(origin) && String(origin) !== String(this.config['COIN']);
    },

    sha256(s){
        return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
    },

    // Canonical signing string for the relay REQUEST leg (v3). MUST byte-match the
    // hub's relay driver. Same construction rules as the XCALL dispatch canonical
    // (xexec.js::canonical): pipe-joined fixed field order, the free-form payload
    // folded in as a hash rather than inline, and the EQUIV uniform header wrapped
    // around it at/above the flag-day. ROUND_ID folds the phase in so the request
    // and response legs of one request_id can never collide in the equivocation
    // detector's key space.
    relayRequestCanonical(f){
        let raw = [
            'ATTEST', 'RELAY_REQUEST', String(f.requestId), String(f.snapshotBlock), String(f.network),
            String(f.originChain), String(f.originActionIndex), String(f.providerId),
            this.sha256(f.requestPayload == null ? '' : f.requestPayload),
            String(f.redundancy), String(f.deadlineBlocks)
        ].join('|');
        if(eq.isEquivHeaderActive(f.snapshotBlock, f.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST,
                this.sha256('ATTESTRELAY|request|' + String(f.requestId)), 0, raw);
        return raw;
    },

    // Canonical signing string for the relay RESPONSE leg (v4). See the request
    // canonical above; the response body is folded in as its sha256 so the signed
    // bytes stay bounded no matter how large the attested payload is, exactly as
    // the v1 canonical does.
    relayResponseCanonical(f){
        let raw = [
            'ATTEST', 'RELAY_RESPONSE', String(f.requestId), String(f.snapshotBlock), String(f.network),
            String(f.originChain), String(f.homeResponseActionIndex), String(f.providerId),
            String(f.responseHash), String(f.status), String(f.meta == null ? '' : f.meta)
        ].join('|');
        if(eq.isEquivHeaderActive(f.snapshotBlock, f.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST,
                this.sha256('ATTESTRELAY|response|' + String(f.requestId)), 0, raw);
        return raw;
    },

    // Parse the trailing SIG_COUNT|PUBKEY|SIG|... tail both relay legs share.
    // Returns null on any structural fault so the caller can reject the action
    // rather than silently proceed with a short signature list.
    parseRelaySigs(params, offset){
        let count = parseInt(params[offset]);
        if(!Number.isFinite(count) || count < 1) return null;
        let sigs = [];
        for(let i = 0; i < count; i++){
            let pubkey = params[offset + 1 + 2 * i];
            let sig    = params[offset + 1 + 2 * i + 1];
            if(!pubkey || !sig) return null;
            if(!/^[0-9a-fA-F]{64}$/.test(pubkey))  return null;
            if(!/^[0-9a-fA-F]{128}$/.test(sig))    return null;
            sigs.push({ pubkey: String(pubkey).toLowerCase(), sig: String(sig).toLowerCase() });
        }
        return sigs;
    },

    // Verify the `cross_chain` federation quorum over a relay canonical, against the
    // capability snapshot pinned at the BTC-anchored `snapshotBlock`. Deliberately
    // byte-for-byte the same rule xexec.js applies to an XCALL dispatch, because both
    // are the same trust decision on the same rail: stake-weighted (source-deduped)
    // at/above STAKE_WEIGHTED_QUORUM, else the legacy 2f+1 signer count. Duplicate
    // pubkeys are marked seen only AFTER their signature verifies, so a
    // garbage-then-valid pair for one qualified validator cannot suppress the real
    // signature and under-count a quorate relay.
    async verifyRelayQuorum(canonical, sigs, snapshotBlock, network){
        // Same declared-vs-resolved split as the v1 path above. The wire
        // carries the RAW snapshot_block, but AttestationRelay resolved its cross_chain
        // signer set through CapabilitySnapshot, which buries by CANONICAL_REORG_BUFFER,
        // so re-resolving at the raw height admits or drops any validator whose stake
        // moved inside the buried window. The weighted-quorum flag-day still keys on the
        // DECLARED height: shifting a cutover block by the buffer is its own fork.
        let resolveBlock = srb.buriedSnapshotBlock(snapshotBlock, network);
        let weighted   = swq.isStakeWeightedQuorumActive(snapshotBlock, network);
        let validators = weighted
            ? await this.indexerDb.getStakeWeightsByCapability('cross_chain', resolveBlock)
            : await this.indexerDb.getValidatorsByCapability('cross_chain', resolveBlock);
        let N = (validators && validators.length) ? validators.length : 0;
        if(N === 0)
            return { ok: false, detail: 'cross_chain snapshot empty at block ' + snapshotBlock };

        let snapPubkeys  = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            if(seen.has(s.pubkey)) continue;
            if(!snapPubkeys.has(s.pubkey)) continue;
            if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
            seen.add(s.pubkey);
            validSigners.push(s.pubkey);
        }
        let met = weighted
            ? swq.meetsStakeThreshold(validators, validSigners)
            : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
        if(!met){
            return { ok: false, detail: weighted
                ? 'insufficient signer stake (' + validSigners.length + ' valid signers of ' + N + ' snapshot keys)'
                : 'insufficient valid signatures (' + validSigners.length + '/' + N + ')' };
        }
        return { ok: true, validSigners: validSigners };
    }
};
