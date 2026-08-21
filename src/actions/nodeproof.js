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
 * XChain Platform Action - NODEPROOF
 *
 * Full-node possession-proof verdict. A quorum of verifying full nodes attests,
 * on-chain, which validators correctly answered a deterministically-DERIVED
 * possession challenge, proving those validators run a real coin full node
 * rather than mirroring the decoder/indexer DBs via xchain-sync. The verified
 * set earns the full-node tranche of the oracle-round reward (see price.js).
 *
 * Only the verdict reaches the wire (the challenge is recomputed from chain
 * data); modeled on ATTEST v1's signature-verification + responsible-set path.
 *
 * Spec: xchain-documentation/protocol/actions/NODEPROOF.md
 *
 * FORMAT:
 *   v0 - VERSION|CHALLENGE_ID|EPOCH_HEIGHT|PASS_COUNT|PASS_PK...|SIG_COUNT|PUBKEY|SIG|...
 *
 ********************************************************************/

const crypto  = require('crypto');
const ed25519 = require('../ed25519.js');
const eq      = require('../equivocation_header.js');
const srb     = require('../snapshot_reorg_buffer.js');

class NodeProof {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|CHALLENGE_ID|EPOCH_HEIGHT|PASS_COUNT|PASS_PK...|SIG_COUNT|PUBKEY|SIG|...';
    }

    _fnConfig(){
        return this.config['FULLNODE'] || {};
    }

    // Dispatch on VERSION (only v0 = verdict today)
    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';
        if(format === 0) return await this._parseVerdict(params, data, error);
    }

    // NODEPROOF v0: quorum-signed verdict over who answered the epoch's challenge.
    async _parseVerdict(params, data, error){

        // BTC-only: capability staking + oracle-round rewards are BTC-only, so the
        // proof and its verified set live on BTC. Other chains receive the rows via
        // xchain-sync replication, never by processing a NODEPROOF tx.
        if(!error && this.config['COIN'] !== 'BTC')
            error = 'invalid: NODEPROOF is BTC-only';

        let fn        = this._fnConfig();
        let interval  = parseInt(fn['CHALLENGE_INTERVAL_BLOCKS'])     || 0;
        let depth     = parseInt(fn['CONFIRM_DEPTH'])                 || 0;
        let acceptWin = parseInt(fn['VERDICT_ACCEPT_WINDOW_BLOCKS'])  || 0;

        let challengeId = String(params[1] || '').toLowerCase();
        let epochHeight = parseInt(params[2]);
        let blockIndex  = parseInt(data['BLOCK_INDEX']);

        if(!error && !/^[0-9a-f]{64}$/.test(challengeId))
            error = 'invalid: CHALLENGE_ID (format)';
        if(!error && interval <= 0)
            error = 'invalid: full-node challenges not configured';
        if(!error && (!Number.isFinite(epochHeight) || epochHeight % interval !== 0))
            error = 'invalid: EPOCH_HEIGHT (not a challenge epoch)';
        if(!error && epochHeight > blockIndex)
            error = 'invalid: EPOCH_HEIGHT (in the future)';
        if(!error && (blockIndex - epochHeight) > acceptWin)
            error = 'invalid: verdict too late (epoch=' + epochHeight + ', block=' + blockIndex + ')';

        let targetHeight = epochHeight - depth;
        if(!error && targetHeight < 0)
            error = 'invalid: target height below genesis';

        // Recompute the derived challenge id from real chain history. Binds the
        // verdict to the epoch's ledger hash, so a verdict can't claim an epoch
        // that never happened (or fabricate a different target).
        if(!error){
            let row = await this.indexerDb.getStoredBlockHashes(epochHeight);
            if(!row || !row.ledger_hash){
                error = 'invalid: EPOCH_HEIGHT (no block / ledger hash)';
            } else {
                let preimage = String(this.config['NETWORK']) + ':' + epochHeight + ':' + String(row.ledger_hash) + ':' + targetHeight;
                let expected = crypto.createHash('sha256').update(preimage).digest('hex');
                if(expected !== challengeId)
                    error = 'invalid: CHALLENGE_ID (does not match derivation)';
            }
        }

        // Parse the PASS list (validators being attested as having answered).
        let passList = [];
        if(!error){
            try {
                let passCount = parseInt(params[3]);
                if(!Number.isFinite(passCount) || passCount < 0)
                    throw new Error('invalid PASS_COUNT');
                let seen = new Set();
                for(let i = 0; i < passCount; i++){
                    let pk = String(params[4 + i] || '').toLowerCase();
                    if(!/^[0-9a-f]{64}$/.test(pk)) throw new Error('invalid PASS_PK at index ' + i);
                    if(seen.has(pk)) continue;
                    seen.add(pk);
                    passList.push(pk);
                }
                // Offset where the signature block begins (after PASS_COUNT + n pubkeys)
                data['_SIG_OFFSET'] = 4 + passCount;
            } catch(e){
                error = 'invalid: ' + e.message;
            }
        }

        // Parse the verifier signature list.
        let sigs = [];
        if(!error){
            try {
                let off      = data['_SIG_OFFSET'];
                let sigCount = parseInt(params[off]);
                if(!Number.isFinite(sigCount) || sigCount < 1)
                    throw new Error('invalid SIG_COUNT');
                for(let i = 0; i < sigCount; i++){
                    let pubkey = params[off + 1 + 2 * i];
                    let sig    = params[off + 1 + 2 * i + 1];
                    if(!pubkey || !sig) throw new Error('missing sig data at index ' + i);
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey))  throw new Error('invalid pubkey format at index ' + i);
                    if(!/^[0-9a-fA-F]{128}$/.test(sig))    throw new Error('invalid sig format at index ' + i);
                    sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
            } catch(e){
                error = 'invalid: ' + e.message;
            }
        }

        // Determine the eligible verifier universe at the epoch block: already-
        // verified full nodes plus the configured genesis verifiers (the bootstrap
        // trust anchor). Quorum = floor(2V/3)+1. V==0 → nobody can vouch yet.
        //
        // TWO PLANES, deliberately. `snapshotBlock` is the DECLARED height and stays
        // raw: it is the flag-day plane for the EQUIV header gate below, exactly as
        // attest.js evaluates its own gate against the declared block_index.
        // `setBlock` is the height every full_node VALIDATOR-SET read resolves at, and
        // it is buried by the canonical reorg buffer, because the producing hub does
        // not resolve these sets at the raw epoch either: CapabilitySnapshot subtracts
        // the buffer from the claimant universe (FullNodeChallengeRound._claimantSet)
        // and _eligibleVerifiers passes the same buried height to getfullnodeverifiers.
        // Re-deriving here at the raw epoch resolved a DIFFERENT set whenever full_node
        // stake activated or deactivated inside (epoch - CANONICAL_REORG_BUFFER, epoch]:
        // a deactivation silently dropped the verification row for a node the hub had
        // already challenged and quorum-signed, an activation left a creditable node
        // unchallenged, and the quorum divisor itself was read from a tip-adjacent,
        // reorg-unstable height. Same Proposal A treatment attest.js / recovery.js /
        // light.js already carry; flag-day gated, so below the gate this is epochHeight
        // verbatim and acceptance is byte-preserved.
        let snapshotBlock = epochHeight;
        let setBlock      = srb.buriedSnapshotBlock(epochHeight, this.config['NETWORK']);
        let validSigners  = 0;
        if(!error){
            let eligible = await this._eligibleVerifierSet(setBlock);
            if(eligible.size === 0){
                error = 'invalid: no eligible verifiers at epoch (feature dormant)';
            } else {
                // Byte comparator, not a bare .sort(): this order is joined into the
                // ed25519 preimage, so it is consensus, and the default sort is a total
                // order here only because every element happens to be lowercase 64-hex.
                // Pinned in lockstep with the hub PRODUCER's four PASS sorts
                // (xchain-hub FullNodeChallengeRound.js PASS_CMP); pinning one side alone
                // would diverge the verifier from the producer on any non-uniform input.
                let sortedPass = passList.slice().sort(
                    (a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'),
                                             Buffer.from(String(b), 'utf8')));
                let canonRaw  = challengeId + '|' + epochHeight + '|' + sortedPass.join(',');
                if(eq.isEquivHeaderActive(snapshotBlock, this.config['NETWORK']))
                    canonRaw = eq.buildEquivCanonical(eq.ENGINE_TAGS.NODEPROOF, challengeId, 0, canonRaw);
                let canonical = Buffer.from(canonRaw, 'utf8');

                let seen = new Set();
                for(let s of sigs){
                    if(seen.has(s.pubkey)) continue;
                    if(!eligible.has(s.pubkey)) continue;
                    if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
                    // Mark seen only AFTER the signature verifies, matching the hub
                    // finalizer and the SDK/explorer/sync verifiers (and anchor.js):
                    // marking on first encounter lets a garbage-then-valid pair for
                    // one eligible verifier suppress the real signature
                    // (order-dependent quorum under-count, fails quorate proofs closed).
                    seen.add(s.pubkey);
                    validSigners++;
                }

                let quorum = Math.floor((2 * eligible.size) / 3) + 1;
                if(validSigners < quorum)
                    error = 'invalid: insufficient verifier signatures (' + validSigners + '/' + quorum + ' of ' + eligible.size + ')';
            }
        }

        data['STATUS'] = (error) ? error : 'valid';

        console.log("\t NODEPROOF v0 : challenge=" + challengeId.substring(0, 16) + '...' +
                    ' : epoch=' + epochHeight +
                    ' : pass=' + passList.length +
                    ' : sigs=' + validSigners +
                    ' : ' + data['STATUS']);

        // Record one verification row per PASS pubkey that actually holds the
        // full_node capability at the epoch block (a verdict can't verify a
        // non-staker). Idempotent on (epoch_height, signing_pubkey).
        if(!error){
            // One batched capability read for the whole PASS list, same fallback rule
            // as _eligibleVerifierSet: a truncated read re-probes per pubkey. Resolves
            // at the buried setBlock, the height the hub locked the claimant universe
            // at; crediting at the raw epoch is what dropped rows for nodes the hub had
            // legitimately challenged (see the two-planes note above).
            let capRows = await this.indexerDb.getValidatorsByCapability('full_node', setBlock);
            let capSet  = (capRows && capRows.truncated === true)
                        ? null
                        : new Set((capRows || []).map(v => String(v.pubkey).toLowerCase()));
            for(let pk of passList){
                if(capSet ? !capSet.has(pk) : !await this.indexerDb.hasCapability(pk, 'full_node', setBlock))
                    continue;
                await this.indexerDb.createNodeProofVerification(
                    pk, challengeId, epochHeight, targetHeight, data['ACTION_INDEX'], blockIndex
                );
            }
        }

        await this.mapper.createMappings(data);
    }

    // Eligible verifier universe at `blockIndex`: previously-verified full nodes
    // (passed proof in window AND live full_node stake) ∪ configured genesis
    // verifiers. Deterministic: depends only on earlier on-chain verdicts + config.
    async _eligibleVerifierSet(blockIndex){
        let set = new Set();
        let genesis = this._fnConfig()['GENESIS_VERIFIERS'] || [];
        for(let pk of genesis){
            if(/^[0-9a-fA-F]{64}$/.test(String(pk)))
                set.add(String(pk).toLowerCase());
        }
        let verified = await this.indexerDb.getVerifiedFullNodeSet(blockIndex);
        // Intersect the proof-window set with the live capability set so an
        // unstaked-since node loses verifier standing. Resolve that set ONCE
        // (hasCapability is ~5 sequential queries per pubkey). eligible.size is the
        // quorum divisor, so a truncated capability read falls back to the per-pubkey
        // probe rather than silently shrinking the divisor.
        let capRows = await this.indexerDb.getValidatorsByCapability('full_node', blockIndex);
        let capSet  = (capRows && capRows.truncated === true)
                    ? null
                    : new Set((capRows || []).map(v => String(v.pubkey).toLowerCase()));
        for(let v of verified){
            let pk = String(v.pubkey).toLowerCase();
            if(capSet ? capSet.has(pk) : await this.indexerDb.hasCapability(v.pubkey, 'full_node', blockIndex))
                set.add(pk);
        }
        return set;
    }
}

module.exports = NodeProof;
