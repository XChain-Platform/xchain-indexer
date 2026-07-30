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
 * XChain Platform Action - ANCHOR (validator-broadcast, DOGE-only)
 *
 * On-chain commitment of federation state: quorum-signed checkpoints (v0),
 * the cross-chain match archive (v1), archive continuation chunks (v2),
 * SPV light-client roots (v3), and publisher-attestation reward anchors
 * (v4 rootless / v5 root-bearing).
 * Parsed rows land in anchor_actions: the permanent on-chain record that
 * makes every checkpoint + the complete match archive recoverable from a
 * full chain parse alone (src/recovery.js). Live indexers keep settling
 * from the hub mirror. ANCHOR has NO ledger effect (no credits/debits/
 * escrows) and charges NO protocol fee (validator action, like PRICE v0).
 *
 * Verification: each signature must belong to the `oracle_publish`
 * capability snapshot at the payload's SNAPSHOT_BLOCK (a BTC height,
 * resolved on DOGE from the hub-mirrored capability_snapshots (same path
 * cross_settle uses for `cross_chain`) and Ed25519-verify over the
 * XCHECKPOINT canonical. Quorum 2f+1. When no snapshot is mirrored locally
 * (e.g. a from-scratch resync with no hub), the row is stored 'unverified';
 * recovery re-verifies from the ARCHIVED snapshots, so chain-parse
 * recovery never depends on the mirror.
 *
 * Spec: xchain-documentation/protocol/actions/ANCHOR.md
 *
 * FORMATS:
 *   v0 - VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...
 *   v1 - VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|MATCH_BATCH_SEQ|MATCH_COUNT|BATCH_CRC32|TOTAL_CHUNKS|ARCHIVE_B64|SIG_COUNT|PUBKEY|SIG|...
 *   v2 - VERSION|MATCH_BATCH_SEQ|CHUNK_INDEX|TOTAL_CHUNKS|ARCHIVE_B64_CHUNK
 *   v3 - v0 checkpoint + STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION appended before SIG_COUNT (SPV Phase 2)
 *   v4 - v0 checkpoint + PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|... appended after the root signature list (anchor-reward re-derivation)
 *   v5 - v3 checkpoint + PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|... appended after the root signature list (anchor-reward re-derivation)
 *   v6 - v1 archive anchor + PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|... appended after the root signature list (archive-reward re-derivation, )
 *
 ********************************************************************/

const zlib    = require('zlib');
const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');
const ckpt    = require('../checkpoint_commitment_activation.js');
const ar      = require('../anchor_reward_activation.js');

const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];

class Anchor {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Per-version format strings
        this.formats = {};
        this.formats[0] = 'VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...';
        this.formats[1] = 'VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|MATCH_BATCH_SEQ|MATCH_COUNT|BATCH_CRC32|TOTAL_CHUNKS|ARCHIVE_B64|SIG_COUNT|PUBKEY|SIG|...';
        this.formats[2] = 'VERSION|MATCH_BATCH_SEQ|CHUNK_INDEX|TOTAL_CHUNKS|ARCHIVE_B64_CHUNK';
        // v3 (SPV Phase 2, spec §6.3 / D6): v0 checkpoint PLUS the two light-client roots
        // + their version bytes, appended before SIG_COUNT (positional, never inserted
        // mid-string). The signatures cover the post-flag-day checkpoint canonical, which
        // includes the same roots, so they are signed, not just transported.
        this.formats[3] = 'VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION|SIG_COUNT|PUBKEY|SIG|...';
        // v4 / v5 (anchor-reward re-derivation flag-day): the checkpoint anchor PLUS the
        // elected PUBLISHER pubkey and a SECOND 2f+1 oracle_publish attestation (XANCPUB) over
        // the reward tuple, appended AFTER the root signature list (positional, never mid-string).
        // v4 = rootless (v0-shaped) + publisher; v5 = root-bearing (v3-shaped) + publisher. The
        // indexer re-derives the reward from these bytes, so the trusted hub push is retired.
        this.formats[4] = 'VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...';
        this.formats[5] = 'VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...';
        // v6 (archive-reward re-derivation flag-day, ): the v1 archive anchor PLUS the
        // elected archive-leader PUBLISHER pubkey and a 2f+1 oracle_publish attestation over
        // the 'anchor_archive' XANCPUB canonical, appended AFTER the wrapper signature list.
        // The indexer re-derives the anchor_archive reward from these bytes, retiring the
        // last key-authenticated reward push.
        this.formats[6] = 'VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|MATCH_BATCH_SEQ|MATCH_COUNT|BATCH_CRC32|TOTAL_CHUNKS|ARCHIVE_B64|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...';
    }

    // Canonical signing string: MUST byte-match the hub's
    // StateCheckpointEngine.canonicalCheckpoint (+ the archive extension for v1)
    // and the SDK CheckpointVerifier.
    _canonical(d){
        let base = ['XCHECKPOINT', d['CHAIN'], d['NETWORK'], String(d['BLOCK_INDEX_CHECKPOINTED']),
                    d['BLOCK_HASH'], d['LEDGER_HASH'], d['ACTIONS_HASH'], d['CONTRACT_HASH'],
                    String(d['CHECKPOINT_SEQ']), String(d['SNAPSHOT_BLOCK'])].join('|');
        // v0 ROUND_ID = chain|network|block|checkpoint_seq; v1 appends batch_seq so the
        // per-block (v0) and archive (v1) canonicals (which share checkpoint_seq) get
        // DISTINCT equivocation keys (R-4 false-slash fix). Must byte-match the hub.
        let roundId = d['CHAIN'] + '|' + d['NETWORK'] + '|' + d['BLOCK_INDEX_CHECKPOINTED'] + '|' + d['CHECKPOINT_SEQ'];
        if(Number(d['FORMAT']) === 1 || Number(d['FORMAT']) === 6){
            // Archive (v1, and its publisher-bearing v6): rootless checkpoint base + archive
            // extension. Byte-matches the hub's _archiveCanonical, which nests the bare
            // _rawCanonicalCheckpoint; v6's wrapper sigs are produced over the SAME archive
            // canonical (the publisher tail is attested separately via _rewardCanonical).
            base += '|' + String(d['MATCH_BATCH_SEQ']) + '|' + String(d['MATCH_COUNT']) + '|' +
                    d['BATCH_CRC32'] + '|' + String(d['TOTAL_CHUNKS']);
            roundId += '|' + d['MATCH_BATCH_SEQ'];
        } else if(Number(d['FORMAT']) === 3 || Number(d['FORMAT']) === 5){
            // SPV Phase 2 (spec §6.1/§6.3): v3 (and the root-bearing v5) IS the root-carrying
            // checkpoint, so its canonical always appends the root suffix. Byte-matches the hub's
            // post-flag-day canonicalCheckpoint suffix + the SDK/explorer reconstructions. Gating
            // on the VERSION (not the flag-day) keeps a legacy v0/v4 rootless even after the
            // flag-day: those sigs were produced over the rootless canonical. v5 carries roots and
            // is rejected pre-CHECKPOINT_COMMITMENT in parse.
            base += '|' + [String(d['STATE_ROOT'] || '').toLowerCase(), String(d['STATE_ROOT_VERSION']),
                           String(d['BLOCK_MERKLE_ROOT'] || '').toLowerCase(), String(d['BLOCK_MERKLE_VERSION'])].join('|');
        }
        if(eq.isEquivHeaderActive(d['SNAPSHOT_BLOCK'], d['NETWORK']))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        return base;
    }

    // Publisher-attestation canonical (XANCPUB): the string the 2f+1 oracle_publish quorum
    // signs to ATTEST which validator earns the anchor reward. MUST byte-match the hub's
    // StateAnchorPublisher._attestationCanonical. The amount is the FROZEN consensus constant
    // (ar.ANCHOR_REWARD_AMOUNT), NEVER taken from the wire. A distinct 'XANCPUB|...' roundId
    // prefix gives the attestation its OWN equivocation family, so a validator that signs both
    // the checkpoint root canonical and this reward attestation in the same round is never
    // falsely slashable (same R-4 reasoning as the v0/v1 roundId split above).
    _rewardCanonical(d){
        // Archive leg (v6, ): the attested tuple is the anchor_archive reward, keyed on
        // MATCH_BATCH_SEQ (the archive round number) with the frozen ARCHIVE amount. MUST
        // byte-match the hub's StateAnchorPublisher._archiveAttestationCanonical. The
        // 'XANCPUB|archive|...' roundId is disjoint from every per-chain roundId
        // ('XANCPUB|BTC|...' etc.), so the two attestation families can never equivocation-
        // collide (same R-4 reasoning as the v0/v1 checkpoint roundId split).
        if(Number(d['FORMAT']) === 6){
            let base = ['XANCPUB', 'anchor_archive', String(d['MATCH_BATCH_SEQ']),
                        String(d['SNAPSHOT_BLOCK']), String(d['PUBLISHER'] || '').toLowerCase(),
                        ar.ARCHIVE_REWARD_AMOUNT].join('|');
            if(eq.isEquivHeaderActive(d['SNAPSHOT_BLOCK'], d['NETWORK'])){
                let roundId = 'XANCPUB|archive|' + d['NETWORK'] + '|' + d['MATCH_BATCH_SEQ'] + '|' + d['SNAPSHOT_BLOCK'];
                return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
            }
            return base;
        }
        let base = ['XANCPUB', 'anchor_' + d['CHAIN'], String(d['CHECKPOINT_SEQ']),
                    String(d['SNAPSHOT_BLOCK']), String(d['PUBLISHER'] || '').toLowerCase(),
                    ar.ANCHOR_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(d['SNAPSHOT_BLOCK'], d['NETWORK'])){
            let roundId = 'XANCPUB|' + d['CHAIN'] + '|' + d['NETWORK'] + '|' + d['CHECKPOINT_SEQ'] + '|' + d['SNAPSHOT_BLOCK'];
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    }

    // Dispatch on VERSION
    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // ANCHOR is valid only on the anchor chain: DOGE (all networks).
        if(!error && String(this.config['COIN']) !== 'DOGE')
            error = 'invalid: ANCHOR only valid on DOGE';

        if(format === 2) return await this._parseContinuation(params, data, error);
        return await this._parseCheckpoint(params, data, error, format);
    }

    // ANCHOR v0/v1: checkpoint (+ optional archive segment)
    async _parseCheckpoint(params, data, error, format){

        data['CHAIN']                   = String(params[1] || '').toUpperCase();
        data['NETWORK']                 = String(params[2] || '');
        data['BLOCK_INDEX_CHECKPOINTED']= params[3];
        data['BLOCK_HASH']              = String(params[4] || '').toLowerCase();
        data['LEDGER_HASH']             = String(params[5] || '').toLowerCase();
        data['ACTIONS_HASH']            = String(params[6] || '').toLowerCase();
        data['CONTRACT_HASH']           = String(params[7] || '').toLowerCase();
        data['CHECKPOINT_SEQ']          = params[8];
        data['SNAPSHOT_BLOCK']          = params[9];

        let sigBase = 10;
        if(format === 1 || format === 6){
            data['MATCH_BATCH_SEQ'] = params[10];
            data['MATCH_COUNT']     = params[11];
            data['BATCH_CRC32']     = String(params[12] || '').toLowerCase();
            data['TOTAL_CHUNKS']    = params[13];
            data['ARCHIVE_B64']     = String(params[14] || '');
            sigBase = 15;
        } else if(format === 3 || format === 5){
            // SPV Phase 2: the two light-client roots + version bytes, before SIG_COUNT.
            // v5 is the root-bearing publisher anchor (v3 shape + publisher tail).
            data['STATE_ROOT']           = String(params[10] || '').toLowerCase();
            data['STATE_ROOT_VERSION']   = params[11];
            data['BLOCK_MERKLE_ROOT']    = String(params[12] || '').toLowerCase();
            data['BLOCK_MERKLE_VERSION'] = params[13];
            sigBase = 14;
        }

        // ── Structural validation ─────────────────────────────────────────────
        if(!error && ALLOWED_CHAINS.indexOf(data['CHAIN']) === -1)
            error = 'invalid: CHAIN (unknown)';
        if(!error && String(data['NETWORK']) !== String(this.config['NETWORK'] || ''))
            error = 'invalid: NETWORK (not this network)';
        if(!error && (!/^[0-9]+$/.test(String(data['BLOCK_INDEX_CHECKPOINTED'])) ||
                      !/^[0-9]+$/.test(String(data['CHECKPOINT_SEQ'])) ||
                      !/^[0-9]+$/.test(String(data['SNAPSHOT_BLOCK']))))
            error = 'invalid: BLOCK_INDEX / CHECKPOINT_SEQ / SNAPSHOT_BLOCK (format)';
        for(let f of ['BLOCK_HASH', 'LEDGER_HASH', 'ACTIONS_HASH', 'CONTRACT_HASH']){
            if(!error && !/^[0-9a-f]{64}$/.test(String(data[f])))
                error = 'invalid: ' + f + ' (format)';
        }
        if(!error && (format === 1 || format === 6)){
            if(!/^[0-9]+$/.test(String(data['MATCH_BATCH_SEQ'])) ||
               !/^[0-9]+$/.test(String(data['MATCH_COUNT'])) ||
               !/^[0-9]+$/.test(String(data['TOTAL_CHUNKS'])) || Number(data['TOTAL_CHUNKS']) < 1)
                error = 'invalid: MATCH_BATCH_SEQ / MATCH_COUNT / TOTAL_CHUNKS (format)';
            else if(!/^[0-9a-f]{8}$/.test(String(data['BATCH_CRC32'])))
                error = 'invalid: BATCH_CRC32 (format)';
            else if(!data['ARCHIVE_B64'] || !/^[0-9a-zA-Z_-]+$/.test(String(data['ARCHIVE_B64'])))
                error = 'invalid: ARCHIVE_B64 (format)';
        }
        // v4/v5 (publisher-bearing anchors) may only appear at/above the ANCHOR_REWARD
        // flag-day; below it the legacy push path stands and these versions do not exist.
        if(!error && (format === 4 || format === 5)){
            if(!ar.isAnchorRewardActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK']))
                error = 'invalid: ANCHOR v' + format + ' before ANCHOR_REWARD flag-day';
        }
        // v6 (publisher-bearing archive anchor) may only appear at/above the ARCHIVE_REWARD
        // flag-day; below it the legacy v1 + push path stands and this version does not exist.
        if(!error && format === 6){
            if(!ar.isArchiveRewardActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK']))
                error = 'invalid: ANCHOR v6 before ARCHIVE_REWARD flag-day';
        }
        // v3 and the root-bearing v5 may only appear at/above the CHECKPOINT_COMMITMENT
        // flag-day (else their signed canonical would have no root suffix, so the sigs could
        // never verify).
        if(!error && (format === 3 || format === 5)){
            if(!ckpt.isCheckpointCommitmentActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK']))
                error = 'invalid: ANCHOR v' + format + ' before CHECKPOINT_COMMITMENT flag-day';
            else if(!/^[0-9a-f]{64}$/.test(String(data['STATE_ROOT'])))
                error = 'invalid: STATE_ROOT (format)';
            else if(!/^[0-9a-f]{64}$/.test(String(data['BLOCK_MERKLE_ROOT'])))
                error = 'invalid: BLOCK_MERKLE_ROOT (format)';
            else if(!/^[0-9]+$/.test(String(data['STATE_ROOT_VERSION'])) ||
                    !/^[0-9]+$/.test(String(data['BLOCK_MERKLE_VERSION'])))
                error = 'invalid: STATE_ROOT_VERSION / BLOCK_MERKLE_VERSION (format)';
        }

        // ── Parse the signature list ──────────────────────────────────────────
        let sigs = [];
        let sigCount = 0;
        if(!error){
            try {
                sigCount = parseInt(params[sigBase]);
                if(!Number.isFinite(sigCount) || sigCount < 1) throw new Error('SIG_COUNT');
                for(let i = 0; i < sigCount; i++){
                    let pubkey = params[sigBase + 1 + 2 * i];
                    let sig    = params[sigBase + 1 + 2 * i + 1];
                    if(!pubkey || !sig)                       throw new Error('missing sig data at index ' + i);
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey))     throw new Error('pubkey format at index ' + i);
                    if(!/^[0-9a-fA-F]{128}$/.test(sig))       throw new Error('sig format at index ' + i);
                    sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
            } catch(e){
                error = 'invalid: ' + e.message;
            }
        }

        // ── v4/v5: PUBLISHER pubkey + the publisher-attestation sig list, appended AFTER
        //    the root sig list (located by sigBase + 1 + 2*sigCount). ────────────────────
        let publisherSigs = [];
        if(!error && (format === 4 || format === 5 || format === 6)){
            try {
                let pubBase = sigBase + 1 + 2 * sigCount;
                data['PUBLISHER'] = String(params[pubBase] || '').toLowerCase();
                if(!/^[0-9a-f]{64}$/.test(data['PUBLISHER'])) throw new Error('PUBLISHER format');
                let attestCount = parseInt(params[pubBase + 1]);
                if(!Number.isFinite(attestCount) || attestCount < 1) throw new Error('ATTEST_SIG_COUNT');
                for(let i = 0; i < attestCount; i++){
                    let pubkey = params[pubBase + 2 + 2 * i];
                    let sig    = params[pubBase + 2 + 2 * i + 1];
                    if(!pubkey || !sig)                       throw new Error('missing attestation sig at index ' + i);
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey))     throw new Error('attestation pubkey format at index ' + i);
                    if(!/^[0-9a-fA-F]{128}$/.test(sig))       throw new Error('attestation sig format at index ' + i);
                    publisherSigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
            } catch(e){
                error = 'invalid: ' + e.message;
            }
        }

        // ── Replay guards: never accept a seq BELOW the recorded max. Equal is
        // allowed: a v0 and its v1 share the same checkpoint_seq by design
        // (same wrapper), and an exact replay is signature-bound to identical
        // content, so it can only produce a harmless duplicate row. ──────────
        if(!error){
            let maxSeq = await this.indexerDb.getMaxAnchorCheckpointSeq(data['CHAIN'], data['NETWORK']);
            if(maxSeq !== null && Number(data['CHECKPOINT_SEQ']) < maxSeq)
                error = 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)';
        }
        // The archive half of the guard needs a second condition, and  is why:
        // MATCH_BATCH_SEQ is a DENSE counter the hub allocates from its own tables
        // (StateAnchorPublisher._getNextBatchSeq: MAX(batch_seq)+1 over
        // cross_chain_matches / cross_chain_calls / validator_rewards), and those
        // tables are reset by a wipe-and-replay rebase while THIS watermark, read
        // from replayed anchor_actions, returns to the pre-rebase maximum. Seq alone
        // therefore cannot tell "the hub's counter restarted" from "someone is
        // replaying an old archive", and reading it alone fails the first case
        // closed: every post-rebase archive indexes invalid, the invalid row does not
        // advance the watermark, and the rail stays down for as many batches as
        // history had while paying real DOGE for each attempt.
        //
        // The wrapper checkpoint seq settles it, because CHECKPOINT_SEQ is NOT dense:
        //  made it = snapshot_block, a chain value that keeps advancing across
        // any wipe. A genuine replay is signature-bound to its original canonical and
        // so carries the OLD checkpoint seq; a post-rebase archive carries a strictly
        // higher one. So a low batch seq is stale only when the checkpoint is ALSO
        // behind the newest archive's.
        //
        // Deliberately "behind", not "not ahead": two archives can legitimately ride
        // ONE checkpoint (a second batch draining leftover rows in the same cadence),
        // and the equal case is already the tolerated one everywhere else in this
        // guard - an exact re-broadcast is signature-bound to identical content, so it
        // can only produce a duplicate row, which the archive-head pick is already
        // required to handle deterministically.
        if(!error && (format === 1 || format === 6)){
            let wm = await this.indexerDb.getArchiveReplayWatermarks();
            let batchStale      = (wm.batchSeq !== null && Number(data['MATCH_BATCH_SEQ']) < wm.batchSeq);
            let checkpointStale = (wm.checkpointSeq !== null && Number(data['CHECKPOINT_SEQ']) < wm.checkpointSeq);
            if(batchStale && checkpointStale)
                error = 'invalid: MATCH_BATCH_SEQ (stale; replay of an older archive batch)';
        }

        // ── v1 archive integrity (single-chunk batches verify inline; chunked
        //    batches verify at reassembly when the last v2 arrives) ────────────
        if(!error && (format === 1 || format === 6) && Number(data['TOTAL_CHUNKS']) === 1){
            let crc = this._archiveCrc(data['ARCHIVE_B64']);
            if(crc === null)                          error = 'invalid: ARCHIVE_B64 (not gzip)';
            else if(crc !== data['BATCH_CRC32'])      error = 'invalid: BATCH_CRC32 (archive mismatch)';
        }

        // ── Verify 2f+1 oracle_publish signatures over the canonical ─────────
        // SNAPSHOT_BLOCK comes from the wire payload (a BTC height), NOT from
        // the DOGE block this ANCHOR landed in.
        // Hoisted so the v4/v5 publisher-attestation check below can REUSE the same
        // oracle_publish set + weighting (no second query, no chance of a divergent set).
        let weighted = false, validators = null, snapPubkeys = null, oracleN = 0;
        if(!error){
            let snapshotBlock = Number(data['SNAPSHOT_BLOCK']);
            // Stake-weighted (source-deduped) at/above STAKE_WEIGHTED_QUORUM (keyed on
            // the BTC snapshot_block + the checkpoint's network), else legacy 2f+1 count.
            weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, data['NETWORK']);
            validators = weighted
                ? await this.indexerDb.getStakeWeightsByCapability('oracle_publish', snapshotBlock)
                : await this.indexerDb.getValidatorsByCapability('oracle_publish', snapshotBlock);
            oracleN = (validators && validators.length) ? validators.length : 0;
            if(oracleN === 0){
                // No oracle_publish snapshot mirrored locally (offline resync / no hub).
                // Store as 'unverified'; recovery re-verifies from archived snapshots.
                data['STATUS'] = 'unverified';
            } else {
                let canonical = this._canonical(data);
                snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
                let validSigners = [], seen = new Set();
                for(let s of sigs){
                    let pk = String(s.pubkey || '').toLowerCase();
                    if(!pk || seen.has(pk)) continue;
                    if(!snapPubkeys.has(pk)) continue;
                    if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
                    // Mark seen only AFTER the signature verifies, matching the hub
                    // finalizer (StateCheckpointEngine) and the SDK/explorer/sync
                    // verifiers. Marking on first encounter lets a garbage-then-valid
                    // pair for one qualified validator suppress the real signature
                    // (order-dependent quorum under-count), failing a legitimately
                    // quorate anchor closed and disagreeing with the hub on the same bytes.
                    seen.add(pk);
                    validSigners.push(pk);
                }
                let quorumMet = weighted
                    ? swq.meetsStakeThreshold(validators, validSigners)
                    : (validSigners.length >= ((oracleN <= 1) ? 1 : Math.max(2 * Math.floor((oracleN - 1) / 3) + 1, Math.ceil((oracleN + 1) / 2))));
                if(!quorumMet)
                    error = 'invalid: insufficient ' + (weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + oracleN + ')');
            }
        }

        // ── v4/v5: verify the PUBLISHER-attestation quorum (a SECOND 2f+1 over the XANCPUB
        //    canonical) and DERIVE the anchor reward from chain, retiring the trusted hub push.
        //    The attestation reuses the SAME oracle_publish set + weighting resolved for the root
        //    quorum. The reward is credited only when the root quorum passed (error still null,
        //    snapshot present), the attestation quorum is met, and PUBLISHER is in the snapshot
        //    set. A degraded or forged attestation NEVER fails the anchor: the checkpoint still
        //    records as 'valid'; only the reward is skipped, and every indexer reaches the same
        //    verdict deterministically. amount is the FROZEN consensus constant; reconcile keeps
        //    the smallest-pubkey winner on a failover double-publish, identical to the retired
        //    push path + recovery, so the COLLECT rail stays single-winner fleet-wide. ─────────
        //    v6  rides the identical rails for the ARCHIVE leg: reward type
        //    anchor_archive, round = MATCH_BATCH_SEQ, frozen ARCHIVE_REWARD_AMOUNT.
        if(!error && (format === 4 || format === 5 || format === 6) && snapPubkeys && oracleN > 0){
            let rewardCanonical = this._rewardCanonical(data);
            let attSigners = [], attSeen = new Set();
            for(let s of publisherSigs){
                let pk = String(s.pubkey || '').toLowerCase();
                if(!pk || attSeen.has(pk)) continue;
                if(!snapPubkeys.has(pk)) continue;
                if(!ed25519.verify(rewardCanonical, s.sig, s.pubkey)) continue;
                // Mark seen only AFTER the signature verifies, matching the root-sig
                // loop above (and the hub/SDK verifiers): marking on first encounter
                // lets a garbage-then-valid pair for one qualified validator suppress
                // the real attestation (order-dependent quorum under-count).
                attSeen.add(pk);
                attSigners.push(pk);
            }
            let attQuorumMet = weighted
                ? swq.meetsStakeThreshold(validators, attSigners)
                : (attSigners.length >= ((oracleN <= 1) ? 1 : Math.max(2 * Math.floor((oracleN - 1) / 3) + 1, Math.ceil((oracleN + 1) / 2))));
            if(ar.isAnchorRewardDeriveActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK'])){
                //  Option C: at/above the derive-relocation flag-day the reward is
                // materialized by the BTC indexer from the mirrored anchor_reward_attestations
                // row (where the stake source resolves; ANCHOR is DOGE-only, capability staking
                // is BTC-only). This DOGE-side write always silently dropped (no local stake), so
                // stopping it is byte-neutral to the DOGE ledger and removes the wasted lookup.
                // The attestation-quorum verification above still runs (anchor validity is
                // unaffected); only the createValidatorReward/reconcile write is relocated.
            } else if(attQuorumMet && snapPubkeys.has(String(data['PUBLISHER']))){
                let rewardType  = (format === 6) ? 'anchor_archive' : 'anchor_' + data['CHAIN'];
                let rewardRound = (format === 6) ? Number(data['MATCH_BATCH_SEQ']) : Number(data['CHECKPOINT_SEQ']);
                let rewardAmt   = (format === 6) ? ar.ARCHIVE_REWARD_AMOUNT : ar.ANCHOR_REWARD_AMOUNT;
                let ok = await this.indexerDb.createValidatorReward(
                    data['PUBLISHER'], rewardRound, rewardType,
                    rewardAmt, Number(data['SNAPSHOT_BLOCK']), true);
                if(ok)
                    await this.indexerDb.reconcileAnchorRewardWinner(
                        rewardRound, rewardType,
                        Number(data['BLOCK_INDEX']), Number(data['ACTION_INDEX']));
            } else {
                console.warn('\t ANCHOR v' + format + ' : publisher-attestation quorum not met or PUBLISHER not in oracle_publish set; reward skipped (anchor still valid)');
            }
        }

        data['VALIDATOR_SIGNATURES'] = JSON.stringify(sigs);
        // v4/v5/v6 publisher-attestation tail (#2486): persist the RAW wire publisher
        // signature list (publisherSigs, hex-shape-checked only at parse time) so
        // createAnchorAction can store it in anchor_actions.publisher_attestations.
        // NOTE (#3076): this is UNVERIFIED transport, NOT the quorum-verified subset.
        // The Ed25519/oracle_publish-snapshot verification above builds a separate
        // attSigners array that is not persisted; the reward-skipped path still lands
        // here, so the stored JSON can include sigs that failed verification, signers
        // absent from the snapshot, or the tail of an anchor whose attestation quorum
        // was not met. Any consumer MUST re-verify (as anchor_reward_derive.js does
        // from anchor_reward_attestations) and never treat this column as pre-verified.
        // Empty (null) for v0-v3, which carry no publisher tail. data['PUBLISHER'] is
        // already set above for v4+.
        data['PUBLISHER_ATTESTATIONS'] = (publisherSigs.length > 0) ? JSON.stringify(publisherSigs) : null;
        if(!data['STATUS']) data['STATUS'] = (error) ? error : 'valid';

        console.log("\t ANCHOR v" + format + " : " + data['CHAIN'] + '/' + data['NETWORK'] +
                    ' @ ' + data['BLOCK_INDEX_CHECKPOINTED'] + ' seq ' + data['CHECKPOINT_SEQ'] +
                    ((format === 1 || format === 6) ? ' batch ' + data['MATCH_BATCH_SEQ'] + ' (' + data['MATCH_COUNT'] + ' matches, ' + data['TOTAL_CHUNKS'] + ' chunk(s))' : '') +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createAnchorAction(data);

        // ── Head-side archive reassembly gate : the chunk-side gate in
        //    _parseContinuation only fires when the parent v1/v6 head already
        //    exists, so when the completing continuation chunk is broadcast
        //    BEFORE its head every stored chunk is 'orphan' and the reassembly
        //    CRC is never checked. Re-run the completeness + CRC check here when
        //    the head lands last, so the signed BATCH_CRC32 is verified for that
        //    arrival order too. Byte-identical to the chunk-side reassembly
        //    (head blob + chunks sorted by index), hence deterministic across
        //    nodes. Safe without a flag-day: in this ordering the stamped head
        //    has no 'valid' v2 child (all completing chunks are 'orphan'), so
        //    the invalid_archive stamp is invisible to the block state hash
        //    (stateHash.js §6 requires a v2 child with status 'valid'). ─────────
        if(!error && (format === 1 || format === 6) && data['STATUS'] === 'valid' &&
           Number(data['TOTAL_CHUNKS']) > 1){
            let chunks = await this.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']));
            if(chunks.length === Number(data['TOTAL_CHUNKS']) - 1){
                let b64 = String(data['ARCHIVE_B64'] || '');
                for(let c of chunks.sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index))) b64 += c.archive_b64;
                let crc = this._archiveCrc(b64);
                if(crc === null || crc !== String(data['BATCH_CRC32'])){
                    console.warn("\t ANCHOR v" + format + " : batch " + data['MATCH_BATCH_SEQ'] + ' head-side reassembly CRC mismatch, flagging invalid_archive');
                    await this.indexerDb.setAnchorArchiveStatus(Number(data['ACTION_INDEX']), 'invalid_archive');
                }
            }
        }

        await this.mapper.createMappings(data);
    }

    // ANCHOR v2: archive continuation chunk (authenticated by its parent v1)
    async _parseContinuation(params, data, error){

        data['MATCH_BATCH_SEQ'] = params[1];
        data['CHUNK_INDEX']     = params[2];
        data['TOTAL_CHUNKS']    = params[3];
        data['ARCHIVE_B64']     = String(params[4] || '');

        if(!error && (!/^[0-9]+$/.test(String(data['MATCH_BATCH_SEQ'])) ||
                      !/^[0-9]+$/.test(String(data['CHUNK_INDEX'])) ||
                      !/^[0-9]+$/.test(String(data['TOTAL_CHUNKS']))))
            error = 'invalid: MATCH_BATCH_SEQ / CHUNK_INDEX / TOTAL_CHUNKS (format)';
        if(!error && (Number(data['CHUNK_INDEX']) < 1 || Number(data['CHUNK_INDEX']) >= Number(data['TOTAL_CHUNKS'])))
            error = 'invalid: CHUNK_INDEX (out of range)';
        if(!error && (!data['ARCHIVE_B64'] || !/^[0-9a-zA-Z_-]+$/.test(String(data['ARCHIVE_B64']))))
            error = 'invalid: ARCHIVE_B64_CHUNK (format)';

        // The parent v1 must exist with matching chunk geometry; its absence makes
        // this an orphan (stored, but recovery ignores batches that never assemble).
        let parent = null;
        if(!error){
            parent = await this.indexerDb.getAnchorV1ByBatchSeq(Number(data['MATCH_BATCH_SEQ']));
            if(!parent)
                data['STATUS'] = 'orphan';
            else if(Number(parent.total_chunks) !== Number(data['TOTAL_CHUNKS']))
                error = 'invalid: TOTAL_CHUNKS (does not match parent v1)';
            // Authorship (#3075): "authenticated by its parent v1" now MEANS it. A chunk
            // is valid only when its author is the canonical archive head's author, so a
            // slot can only be occupied by the publisher whose batch it is. Without this,
            // the duplicate guard below turned first-broadcast-wins into permanent denial:
            // anyone could fill a slot with junk and the real chunk was rejected as a
            // duplicate. parent.source comes from actions.source_id (authoritative for
            // auth); a null one means the head's author cannot be resolved at all, which
            // fails closed rather than waving the chunk through unauthenticated.
            else if(!parent.source)
                error = 'invalid: SOURCE (archive head author unresolvable)';
            else if(String(data['SOURCE'] || '') !== String(parent.source))
                error = 'invalid: SOURCE (not the archive head publisher)';
        }

        // Duplicate chunk guard (same batch + index already stored). Since #3075 the
        // occupancy set getAnchorChunks returns is author-bound, so a junk chunk that
        // landed BEFORE the head (status 'orphan', no verdict of its own) no longer
        // counts as occupying the slot and can no longer get the real chunk rejected here.
        if(!error && parent){
            let existing = await this.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']));
            if(existing.some(c => Number(c.chunk_index) === Number(data['CHUNK_INDEX'])))
                error = 'invalid: CHUNK_INDEX (duplicate)';
        }

        if(!data['STATUS']) data['STATUS'] = (error) ? error : 'valid';

        console.log("\t ANCHOR v2 : batch " + data['MATCH_BATCH_SEQ'] + ' chunk ' + data['CHUNK_INDEX'] +
                    '/' + data['TOTAL_CHUNKS'] + ' : ' + data['STATUS']);

        await this.indexerDb.createAnchorAction(data);

        // When the last chunk lands, verify the reassembled archive against the
        // parent v1's signed CRC and flag the parent if the blob doesn't bind.
        if(!error && parent && data['STATUS'] === 'valid'){
            let chunks = await this.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']));
            if(chunks.length === Number(data['TOTAL_CHUNKS']) - 1){
                let b64 = String(parent.archive_b64 || '');
                for(let c of chunks.sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index))) b64 += c.archive_b64;
                let crc = this._archiveCrc(b64);
                if(crc === null || crc !== String(parent.batch_crc32)){
                    console.warn("\t ANCHOR v2 : batch " + data['MATCH_BATCH_SEQ'] + ' reassembly CRC mismatch, flagging invalid_archive');
                    await this.indexerDb.setAnchorArchiveStatus(Number(parent.action_index), 'invalid_archive');
                }
            }
        }

        await this.mapper.createMappings(data);
    }

    // CRC32 (hex) of the decompressed archive; null when the blob isn't valid gzip.
    _archiveCrc(b64){
        let json;
        // Bound the decompressed output: ARCHIVE_B64 is attacker-supplied, freely
        // broadcastable on-chain data decompressed here BEFORE any signature/quorum
        // check, so an unbounded gunzip is a gzip-bomb memory-DoS vector. zlib throws
        // RangeError past the cap and the catch below rejects the archive as invalid.
        try { json = zlib.gunzipSync(Buffer.from(String(b64), 'base64url'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'); }
        catch(e){ return null; }
        let n = zlib.crc32 ? zlib.crc32(Buffer.from(json, 'utf8')) : this._crc32Fallback(Buffer.from(json, 'utf8'));
        return (n >>> 0).toString(16).padStart(8, '0');
    }
    _crc32Fallback(buf){
        let c, crc = 0xFFFFFFFF;
        for(let i = 0; i < buf.length; i++){
            c = (crc ^ buf[i]) & 0xFF;
            for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
}

module.exports = Anchor;
