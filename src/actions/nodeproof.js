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

const ed25519  = require('../consensus/ed25519.js');
const eq       = require('../equivocation_header.js');
const srb      = require('../snapshot_reorg_buffer.js');
const validate = require('./nodeproof/validate.js');
const settle   = require('./nodeproof/settle.js');

const { getLogger } = require('../observability/index.js');
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

    fnConfig(){
        return this.config['FULLNODE'] || {};
    }

    // Dispatch on VERSION (only v0 = verdict today)
    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';
        if(format === 0) return await this.parseVerdict(params, data, error);
    }

    // NODEPROOF v0: quorum-signed verdict over who answered the epoch's challenge.
    async parseVerdict(params, data, error){

        // Header, accept window and the re-derived challenge id (validate.js).
        let head = await validate.validateVerdictHeader(this, params, data, error);
        let { challengeId, epochHeight, blockIndex, targetHeight } = head;
        error = head.error;

        let pass = validate.parsePassList(params, data, error);
        let passList = pass.passList;
        error = pass.error;

        let verifiers = validate.parseVerifierSigs(params, data, error);
        let sigs = verifiers.sigs;
        error = verifiers.error;

        // Determine the eligible verifier universe at the epoch block: already-
        // verified full nodes plus the configured genesis verifiers (the bootstrap
        // trust anchor). Quorum = floor(2V/3)+1. V==0 → nobody can vouch yet.
        // The two heights that universe and the attribution resolve at: verdictPlanes.
        let { snapshotBlock, setBlock } = this.verdictPlanes(epochHeight);
        let validSigners  = 0;
        if(!error){
            let verdict = await this.verifyVerdictQuorum(challengeId, epochHeight, passList, sigs, snapshotBlock);
            validSigners = verdict.validSigners;
            error = verdict.error;
        }

        data['STATUS'] = (error) ? error : 'valid';

        getLogger().info("\t NODEPROOF v0 : challenge=" + challengeId.substring(0, 16) + '...' +
                    ' : epoch=' + epochHeight +
                    ' : pass=' + passList.length +
                    ' : sigs=' + validSigners +
                    ' : ' + data['STATUS']);

        // A valid verdict writes its verification rows (settle.js).
        if(!error)
            await settle.recordVerifications(this, {
                passList, challengeId, epochHeight, targetHeight,
                actionIndex: data['ACTION_INDEX'], blockIndex, setBlock
            });

        await this.mapper.createMappings(data);
    }

    // The declared height a verdict is judged at and the buried height its
    // participation is credited at, both from the carried epoch.
    verdictPlanes(epochHeight){
        // TWO PLANES, and only the attribution plane buries. `snapshotBlock` is the
        // DECLARED height: it sizes the quorum divisor and drives the EQUIV flag-day
        // gate below, and it stays RAW because the producing hub also resolves its
        // eligible-verifier set at the raw epoch (FullNodeChallengeRound
        // `_eligibleVerifiers`). Burying it here alone would make an upgraded verifier
        // accept bytes the rest of the fleet rejects, so that half moves only with the
        // hub, in its own flag day.
        let snapshotBlock = epochHeight;
        // `setBlock` is where PARTICIPATION ATTRIBUTION resolves, and it buries, because
        // the hub locked the CLAIMANT universe there: every CapabilitySnapshot read
        // subtracts the canonical reorg buffer (`_buriedBlockIndex`), so the nodes the
        // hub challenges for this epoch are the full_node set at
        // epochHeight - CANONICAL_REORG_BUFFER. Crediting at the raw epoch dropped the
        // verification row for a node whose stake deactivated inside
        // (epochHeight - buffer, epochHeight]: the hub challenged it, it answered, a
        // quorum attested it, and the staking source silently lost the epoch anyway.
        // Row existence feeds getVerifiedFullNodeSet, which the eligible-verifier set
        // (eligibleVerifierSet) and the hub's getfullnodeverifiers RPC both read at RAW heights a proof
        // window later, so a burial-only credit becomes an eligible verifier and moves
        // the quorum divisor: upgraded and un-upgraded indexers diverge on acceptance
        // there, not just on attribution. Safe only because the flag day arms at genesis
        // on every network with no quorum-signed history to reinterpret, which is what
        // makes this gate load-bearing rather than decorative.
        let setBlock      = srb.buriedSnapshotBlock(epochHeight, this.config['NETWORK']);
        return { snapshotBlock, setBlock };
    }

    // Verify the verifier signatures over the verdict canonical against the eligible
    // set at the declared snapshotBlock. Returns the error (null once quorum is met)
    // and the count of distinct eligible verifiers whose signature verified.
    async verifyVerdictQuorum(challengeId, epochHeight, passList, sigs, snapshotBlock){
        let error = null, validSigners = 0;
        let eligible = await this.eligibleVerifierSet(snapshotBlock);
        if(eligible.size === 0){
            error = 'invalid: no eligible verifiers at epoch (feature dormant)';
        } else {
            // Byte comparator, not a bare .sort(): this order is joined into the
            // ed25519 preimage, so it is consensus, and the default sort is a total
            // order here only because every element happens to be lowercase 64-hex.
            // Pinned in lockstep with the hub PRODUCER's four PASS sorts
            // (xchain-hub consensus/full_node_challenge_round.js PASS_CMP); pinning one side alone
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
        return { error, validSigners };
    }

    // Eligible verifier universe at `blockIndex`: previously-verified full nodes
    // (passed proof in window AND live full_node stake) ∪ configured genesis
    // verifiers. Deterministic: depends only on earlier on-chain verdicts + config.
    async eligibleVerifierSet(blockIndex){
        let set = new Set();
        let genesis = this.fnConfig()['GENESIS_VERIFIERS'] || [];
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
