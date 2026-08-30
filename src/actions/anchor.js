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
 * On-chain commitment of federation state: the per-network checkpoint BUNDLE
 * (v0), the publisher-bearing cross-chain match archive head (v1), and archive
 * continuation chunks (v2).
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
 *   v0 - the per-network checkpoint BUNDLE: one header, SECTION_COUNT per-chain
 *        sections, one publisher-attestation tail (see _parseBundle)
 *   v1 - VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|MATCH_BATCH_SEQ|MATCH_COUNT|BATCH_CRC32|TOTAL_CHUNKS|ARCHIVE_B64|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
 *   v2 - VERSION|MATCH_BATCH_SEQ|CHUNK_INDEX|TOTAL_CHUNKS|ARCHIVE_B64_CHUNK
 *
 * ACTIVATION. The version set RESTARTS at 0 at ANCHOR_ACTIVATION (see
 * ../anchor_activation.js), so the first check in parse() is the anchor's own
 * DOGE mined height: below the threshold EVERY ANCHOR of EVERY version is
 * 'invalid: ANCHOR before activation', because the same byte meant something
 * else on the pre-restart wire and no parser can tell the two apart from the
 * bytes alone. At/above it this table is the whole wire set, so any other
 * version byte falls out of the unknown-version check below.
 *
 * The pre-restart versions (the per-chain anchors, the tail-less archive head
 * and the old bundle/archive-head bytes) are RETIRED, not deprecated: their
 * parsers are deleted rather than kept behind a height, because pre-launch a
 * superseded wire is deleted (operator ruling 2026-08-26) and the activation
 * height already makes every row that used them invalid. Those rows keep their
 * version byte on chain and stay readable through the txid-keyed reads; the
 * rewards they already earned are recorded, not re-derived.
 *
 ********************************************************************/

const zlib    = require('zlib');
const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');
const ar      = require('../anchor_reward_activation.js');
const arKey   = require('../anchor_reward_key.js');
const abas    = require('../archive_batch_author_activation.js');
const ahug    = require('../archive_head_unverified_gate_activation.js');
const aact    = require('../anchor_activation.js');
const aaq     = require('../anchor-action-query.js');

const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];

class Anchor {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // The whole ANCHOR wire set. Membership here is what makes a version byte
        // parseable at all (the unknown-version check in parse() reads this object), so
        // adding a key is a consensus change and deleting one retires a wire.
        this.formats = {};
        // v0 (checkpoint bundle): ONE anchor per network per cycle carrying every
        // checkpointed chain as a section. The section body runs from CHAIN through the
        // root signature list MINUS NETWORK (the header carries it once and the parser
        // rebuilds every section canonical with it), and the single publisher tail
        // attests the whole bundle.
        // The template grammar has no repeating-group syntax; the bare `...` after
        // SECTION_COUNT stands for SECTION_COUNT sections, each
        // CHAIN|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ
        // |SECTION_SNAPSHOT_BLOCK|STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT
        // |BLOCK_MERKLE_VERSION|SIG_COUNT|(PUBKEY|SIG)..., walked positionally by _parseBundle.
        this.formats[0] = 'VERSION|NETWORK|SNAPSHOT_BLOCK|SECTION_COUNT|...|PUBLISHER|ATTEST_SIG_COUNT|...';
        // v1 (archive head): the checkpoint wrapper carrying the match-archive segment,
        // PLUS the elected archive-leader PUBLISHER pubkey and an oracle_publish
        // attestation over the 'anchor_archive' XANCPUB canonical, appended AFTER the
        // wrapper signature list. The tail is ALWAYS present; ATTEST_SIG_COUNT may be 0
        // when the attestation round degrades, so one shape covers both the attested and
        // the degraded round and a tail-less archive wire is not a legal encoding.
        this.formats[1] = 'VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|MATCH_BATCH_SEQ|MATCH_COUNT|BATCH_CRC32|TOTAL_CHUNKS|ARCHIVE_B64|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...';
        this.formats[2] = 'VERSION|MATCH_BATCH_SEQ|CHUNK_INDEX|TOTAL_CHUNKS|ARCHIVE_B64_CHUNK';
    }

    // Canonical signing string: MUST byte-match the hub's
    // StateCheckpointEngine.canonicalCheckpoint (+ the archive extension for v1)
    // and the SDK CheckpointVerifier.
    _canonical(d){
        let base = ['XCHECKPOINT', d['CHAIN'], d['NETWORK'], String(d['BLOCK_INDEX_CHECKPOINTED']),
                    d['BLOCK_HASH'], d['LEDGER_HASH'], d['ACTIONS_HASH'], d['CONTRACT_HASH'],
                    String(d['CHECKPOINT_SEQ']), String(d['SNAPSHOT_BLOCK'])].join('|');
        // A checkpoint ROUND_ID is chain|network|block|checkpoint_seq; the archive head
        // appends batch_seq so the checkpoint and archive canonicals (which share
        // checkpoint_seq) get DISTINCT equivocation keys (R-4 false-slash fix). Must
        // byte-match the hub.
        let roundId = d['CHAIN'] + '|' + d['NETWORK'] + '|' + d['BLOCK_INDEX_CHECKPOINTED'] + '|' + d['CHECKPOINT_SEQ'];
        if(Number(d['FORMAT']) === 1){
            // Archive head: rootless checkpoint base + archive extension. Byte-matches the
            // hub's _archiveCanonical, which nests the bare _rawCanonicalCheckpoint; the
            // wrapper sigs are produced over the SAME archive canonical (the publisher tail
            // is attested separately via _rewardCanonical).
            base += '|' + String(d['MATCH_BATCH_SEQ']) + '|' + String(d['MATCH_COUNT']) + '|' +
                    d['BATCH_CRC32'] + '|' + String(d['TOTAL_CHUNKS']);
            roundId += '|' + d['MATCH_BATCH_SEQ'];
        } else if(Number(d['FORMAT']) === 0){
            // A v0 SECTION is root-bearing by construction (the bundle is only ever cut from
            // rows that carry both light-client roots), so its canonical always appends the
            // root suffix. Byte-matches the hub's post-flag-day canonicalCheckpoint suffix +
            // the SDK/explorer reconstructions. `d` here is ONE section, already rebuilt with
            // the header NETWORK and with SNAPSHOT_BLOCK = that section's own
            // SECTION_SNAPSHOT_BLOCK: the signatures were produced over the section's block,
            // never over the bundle's MAX.
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
    // falsely slashable (same R-4 reasoning as the checkpoint/archive roundId split above).
    _rewardCanonical(d){
        // Archive leg (v1): the attested tuple is the anchor_archive reward, keyed on
        // MATCH_BATCH_SEQ (the archive round number) with the frozen ARCHIVE amount. MUST
        // byte-match the hub's StateAnchorPublisher._archiveAttestationCanonical. The
        // 'XANCPUB|archive|...' roundId is disjoint from the bundle's ('XANCPUB|bundle|...')
        // and from the retired per-chain family ('XANCPUB|BTC|...'), so the attestation
        // families can never equivocation-collide (same R-4 reasoning as the checkpoint
        // roundId splits above).
        if(Number(d['FORMAT']) === 1){
            let base = ['XANCPUB', 'anchor_archive', String(d['MATCH_BATCH_SEQ']),
                        String(d['SNAPSHOT_BLOCK']), String(d['PUBLISHER'] || '').toLowerCase(),
                        ar.ARCHIVE_REWARD_AMOUNT].join('|');
            if(eq.isEquivHeaderActive(d['SNAPSHOT_BLOCK'], d['NETWORK'])){
                let roundId = 'XANCPUB|archive|' + d['NETWORK'] + '|' + d['MATCH_BATCH_SEQ'] + '|' + d['SNAPSHOT_BLOCK'];
                return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
            }
            return base;
        }
        // Bundle leg (v0): ONE attested reward per bundle, type 'anchor_bundle', round
        // SNAPSHOT_BLOCK. The layout keeps the shipped SIX positional fields so
        // slash.js's XANCPUB family (which reads snapshot_block at field index 3 for
        // every member) judges a bundle equivocation without a third branch; field 2 is
        // round_reference, which for a bundle IS the snapshot block, hence the repeat.
        // The 'XANCPUB|bundle|...' roundId is disjoint from the per-chain
        // ('XANCPUB|CHAIN|...') and archive ('XANCPUB|archive|...') families, so no
        // publisher becomes falsely slashable for signing in two of them.
        let base = ['XANCPUB', 'anchor_bundle', String(d['SNAPSHOT_BLOCK']),
                    String(d['SNAPSHOT_BLOCK']), String(d['PUBLISHER'] || '').toLowerCase(),
                    ar.ANCHOR_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(d['SNAPSHOT_BLOCK'], d['NETWORK'])){
            let roundId = 'XANCPUB|bundle|' + d['NETWORK'] + '|' + d['SNAPSHOT_BLOCK'];
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    }

    async parse(params, data, error){
        let format = data['FORMAT'];

        // Activation FIRST, ahead of the version table: below ANCHOR_ACTIVATION the same
        // version bytes belonged to the pre-restart wire set, so no shape check on these
        // bytes means anything and every ANCHOR down there is invalid whatever it decodes
        // to. Keyed on the anchor's OWN DOGE mined height (data['BLOCK_INDEX'], the same
        // key the unverified-head gate below reads), never on SNAPSHOT_BLOCK or the
        // checkpointed height, which belong to other chains. isAnchorActive fails closed on
        // a non-numeric height or an unknown network.
        if(!error && !aact.isAnchorActive(Number(data['BLOCK_INDEX']), this.config['NETWORK']))
            error = 'invalid: ANCHOR before activation';

        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // ANCHOR is valid only on the anchor chain: DOGE (all networks).
        if(!error && String(this.config['COIN']) !== 'DOGE')
            error = 'invalid: ANCHOR only valid on DOGE';

        // Dispatch by family. An unparseable version still lands on a body parser (carrying
        // the error), and the archive-head parser is the fall-through, so a rejected action
        // is recorded rather than dropped.
        if(format === 2) return await this._parseContinuation(params, data, error);
        if(format === 0) return await this._parseBundle(params, data, error);
        return await this._parseCheckpoint(params, data, error, format);
    }

    // ANCHOR v1: the archive head (a checkpoint wrapper carrying the match archive plus
    // the publisher-attestation tail).
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

        // Archive head only: the archive segment sits between SNAPSHOT_BLOCK and SIG_COUNT.
        data['MATCH_BATCH_SEQ'] = params[10];
        data['MATCH_COUNT']     = params[11];
        data['BATCH_CRC32']     = String(params[12] || '').toLowerCase();
        data['TOTAL_CHUNKS']    = params[13];
        data['ARCHIVE_B64']     = String(params[14] || '');
        let sigBase = 15;

        // Structural validation
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
        if(!error){
            if(!/^[0-9]+$/.test(String(data['MATCH_BATCH_SEQ'])) ||
               !/^[0-9]+$/.test(String(data['MATCH_COUNT'])) ||
               !/^[0-9]+$/.test(String(data['TOTAL_CHUNKS'])) || Number(data['TOTAL_CHUNKS']) < 1)
                error = 'invalid: MATCH_BATCH_SEQ / MATCH_COUNT / TOTAL_CHUNKS (format)';
            else if(!/^[0-9a-f]{8}$/.test(String(data['BATCH_CRC32'])))
                error = 'invalid: BATCH_CRC32 (format)';
            else if(!data['ARCHIVE_B64'] || !/^[0-9a-zA-Z_-]+$/.test(String(data['ARCHIVE_B64'])))
                error = 'invalid: ARCHIVE_B64 (format)';
        }
        // Parse the signature list
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

        // The publisher tail: PUBLISHER pubkey + the publisher-attestation sig list,
        // appended AFTER the wrapper sig list (located by sigBase + 1 + 2*sigCount). It is
        // ALWAYS present on an archive head, so a wire carrying version 1 without one fails
        // here on 'PUBLISHER format' rather than parsing as some tail-less shape.
        //
        // ATTEST_SIG_COUNT 0 is LEGAL: it is what the hub emits when the attestation round
        // did not reach quorum, and it is the same degraded shape the bundle leg already
        // uses. A degraded round must not cost the federation its checkpoint, so the count
        // rides at 0, publisher_attestations stores NULL, and the reward derivation below
        // simply finds no attestation to meet quorum with. Negative is still rejected: it
        // is not a shape any signer produces.
        let publisherSigs = [];
        if(!error && format === 1){
            try {
                let pubBase = sigBase + 1 + 2 * sigCount;
                data['PUBLISHER'] = String(params[pubBase] || '').toLowerCase();
                if(!/^[0-9a-f]{64}$/.test(data['PUBLISHER'])) throw new Error('PUBLISHER format');
                let attestCount = parseInt(params[pubBase + 1]);
                if(!Number.isFinite(attestCount) || attestCount < 0) throw new Error('ATTEST_SIG_COUNT');
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

        // Replay guards: never accept a seq BELOW the recorded max. Equal is allowed: a v0
        // and its v1 share the same checkpoint_seq by design (same wrapper), and an exact
        // replay is signature-bound to identical content, so it can only produce a harmless
        // duplicate row.
        if(!error){
            let maxSeq = await this.indexerDb.getMaxAnchorCheckpointSeq(data['CHAIN'], data['NETWORK']);
            if(maxSeq !== null && Number(data['CHECKPOINT_SEQ']) < maxSeq)
                error = 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)';
        }
        // The archive half of the guard needs a second condition: MATCH_BATCH_SEQ is a dense
        // counter the hub allocates from its own tables, and those tables are reset by a
        // wipe-and-replay rebase while this watermark (read from replayed anchor_actions)
        // returns to the pre-rebase maximum. Seq alone cannot tell "the hub's counter
        // restarted" from "someone is replaying an old archive", and reading it alone fails
        // closed: every post-rebase archive indexes invalid and the rail stays down for as
        // many batches as history had, while paying real DOGE for each attempt.
        //
        // The wrapper checkpoint seq settles it: CHECKPOINT_SEQ is NOT dense, it equals
        // snapshot_block, a chain value that keeps advancing across any wipe. A genuine
        // replay is signature-bound to its original canonical and so carries the OLD
        // checkpoint seq; a post-rebase archive carries a strictly higher one. So a low
        // batch seq is stale only when the checkpoint is ALSO behind the newest archive's.
        //
        // Deliberately "behind", not "not ahead": two archives can legitimately ride ONE
        // checkpoint, and the equal case is already tolerated elsewhere in this guard since
        // an exact re-broadcast is signature-bound to identical content and can only produce
        // a duplicate row.
        if(!error){
            let wm = await this.indexerDb.getArchiveReplayWatermarks();
            let batchStale      = (wm.batchSeq !== null && Number(data['MATCH_BATCH_SEQ']) < wm.batchSeq);
            let checkpointStale = (wm.checkpointSeq !== null && Number(data['CHECKPOINT_SEQ']) < wm.checkpointSeq);
            if(batchStale && checkpointStale)
                error = 'invalid: MATCH_BATCH_SEQ (stale; replay of an older archive batch)';
        }

        // v1 archive integrity (single-chunk batches verify inline; chunked batches verify
        // at reassembly when the last v2 arrives)
        if(!error && Number(data['TOTAL_CHUNKS']) === 1){
            let crc = this._archiveCrc(data['ARCHIVE_B64']);
            if(crc === null)                          error = 'invalid: ARCHIVE_B64 (not gzip)';
            else if(crc !== data['BATCH_CRC32'])      error = 'invalid: BATCH_CRC32 (archive mismatch)';
        }

        // Verify 2f+1 oracle_publish signatures over the canonical.
        // SNAPSHOT_BLOCK comes from the wire payload (a BTC height), NOT from
        // the DOGE block this ANCHOR landed in.
        // Hoisted so the publisher-attestation check below can REUSE the same
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

        // Verify the PUBLISHER-attestation quorum (a SECOND 2f+1 over the XANCPUB
        // canonical) and DERIVE the archive reward from chain, retiring the trusted hub push.
        // The attestation reuses the SAME oracle_publish set + weighting resolved for the root
        // quorum. The reward is credited only when the root quorum passed (error still null,
        // snapshot present), the attestation quorum is met, and PUBLISHER is in the snapshot
        // set. A degraded or forged attestation NEVER fails the anchor: the checkpoint still
        // records as 'valid'; only the reward is skipped, and every indexer reaches the same
        // verdict deterministically. This is also the whole path a degraded ATTEST_SIG_COUNT 0
        // tail takes: no attestation, no quorum, no reward, checkpoint intact. amount is the
        // FROZEN consensus constant; reconcile keeps the smallest-pubkey winner on a failover
        // double-publish, so the COLLECT rail stays single-winner fleet-wide. Reward type
        // anchor_archive, round = MATCH_BATCH_SEQ.
        if(!error && format === 1 && snapPubkeys && oracleN > 0){
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
                // At/above the derive-relocation flag-day, the reward is materialized by the
                // BTC indexer from the mirrored anchor_reward_attestations row (where the stake
                // source resolves; ANCHOR is DOGE-only, capability staking is BTC-only). This
                // DOGE-side write always silently dropped (no local stake), so stopping it is
                // byte-neutral to the DOGE ledger. The attestation-quorum check above still
                // runs; only the createValidatorReward/reconcile write is relocated.
            } else if(attQuorumMet && snapPubkeys.has(String(data['PUBLISHER']))){
                let rewardType  = 'anchor_archive';
                let rewardRound = Number(data['MATCH_BATCH_SEQ']);
                let rewardAmt   = ar.ARCHIVE_REWARD_AMOUNT;
                // The archive leg's rewardRound is MATCH_BATCH_SEQ, the dense hub counter the
                // replay-guard comment above describes as restarting across a wipe-and-replay
                // rebase, so it alone does not identify the reward: two genuinely distinct
                // archive anchors can carry a reissued seq. The qualifier is the snapshot
                // block that already distinguishes them in the SIGNED tuple (_rewardCanonical
                // puts SNAPSHOT_BLOCK in the archive XANCPUB canonical), carried into the
                // ledger key so both real publishes survive the upsert and the reconcile.
                let rewardQual  = arKey.rewardRoundQualifier(rewardType, data['SNAPSHOT_BLOCK']);
                let ok = await this.indexerDb.createValidatorReward(
                    data['PUBLISHER'], rewardRound, rewardType,
                    rewardAmt, Number(data['SNAPSHOT_BLOCK']), true, null, rewardQual);
                if(ok)
                    await this.indexerDb.reconcileAnchorRewardWinner(
                        rewardRound, rewardType,
                        Number(data['BLOCK_INDEX']), Number(data['ACTION_INDEX']), rewardQual);
            } else {
                console.warn('\t ANCHOR v' + format + ' : publisher-attestation quorum not met or PUBLISHER not in oracle_publish set; reward skipped (anchor still valid)');
            }
        }

        data['VALIDATOR_SIGNATURES'] = JSON.stringify(sigs);
        // The publisher-attestation tail: persist the RAW wire publisher signature list
        // (publisherSigs, hex-shape-checked only at parse time) so createAnchorAction can
        // store it in anchor_actions.publisher_attestations.
        // NOTE: this is UNVERIFIED transport, NOT the quorum-verified subset.
        // The Ed25519/oracle_publish-snapshot verification above builds a separate
        // attSigners array that is not persisted; the reward-skipped path still lands
        // here, so the stored JSON can include sigs that failed verification, signers
        // absent from the snapshot, or the tail of an anchor whose attestation quorum
        // was not met. Any consumer MUST re-verify (as anchor_reward_derive.js does
        // from anchor_reward_attestations) and never treat this column as pre-verified.
        // NULL on a degraded ATTEST_SIG_COUNT 0 tail, which carries no signatures at all.
        data['PUBLISHER_ATTESTATIONS'] = (publisherSigs.length > 0) ? JSON.stringify(publisherSigs) : null;
        if(!data['STATUS']) data['STATUS'] = (error) ? error : 'valid';

        console.log("\t ANCHOR v" + format + " : " + data['CHAIN'] + '/' + data['NETWORK'] +
                    ' @ ' + data['BLOCK_INDEX_CHECKPOINTED'] + ' seq ' + data['CHECKPOINT_SEQ'] +
                    ' batch ' + data['MATCH_BATCH_SEQ'] + ' (' + data['MATCH_COUNT'] + ' matches, ' + data['TOTAL_CHUNKS'] + ' chunk(s))' +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createAnchorAction(data);

        // Head-side archive reassembly gate: the chunk-side gate in _parseContinuation only
        // fires when the parent archive head already exists, so when the completing
        // continuation chunk is broadcast BEFORE its head every stored chunk is 'orphan' and
        // the reassembly CRC is never checked. Re-run the completeness + CRC check here when
        // the head lands last, applying the SAME status handling and index-coverage rule as
        // the chunk-side path (via aaq.archiveChunkCoverage) so results stay deterministic
        // across nodes.
        //
        // The head's own status may be 'valid' OR, at/after the flag day below,
        // 'unverified': a node with no mirrored oracle_publish snapshot stores every archive
        // head 'unverified', yet the head still carries the same signed BATCH_CRC32 and the
        // chunk-side path verifies regardless of the parent head's status, so 'valid' alone
        // leaves the ordering nondeterminism open on exactly those nodes.
        //
        // That widening is GATED, and must never be re-landed ungated (operator ruling
        // 2026-08-16). It is preimage-moving and it does not move the two node classes
        // together: a MIRRORED node holding the snapshot has a THIRD outcome on the same
        // head (the quorum branch above sets error = 'invalid: insufficient signer stake' /
        // 'insufficient valid signatures'), on which this gate never runs and no stamp
        // lands, while a snapshot-less node's same head is 'unverified' with error null and
        // DOES stamp. invalid_archive is projected by stateHash.js class 6, so ungated the
        // two classes silently fork wherever ARCHIVE_INVALID_STATE_HASH_ACTIVATION is armed.
        // Rationale and the pinning train live in archive_head_unverified_gate_activation.js;
        // do not re-argue it here.
        let admitUnverifiedHead = ahug.isArchiveHeadUnverifiedGateActive(
            Number(data['BLOCK_INDEX']), this.config['NETWORK']);
        if(!error &&
           (data['STATUS'] === 'valid' || (admitUnverifiedHead && data['STATUS'] === 'unverified')) &&
           Number(data['TOTAL_CHUNKS']) > 1){
            // At/after the publisher-scoped-archive flag day, the head reassembles its OWN
            // publisher's chunks. Below it, the canonical-head rule (whatever it selects) is kept.
            let scope = await this._archiveAuthorScope(data['MATCH_BATCH_SEQ'], data['SOURCE']);
            let chunks = await this.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']), scope);
            let ordered = aaq.archiveChunkCoverage(chunks, Number(data['TOTAL_CHUNKS']));
            if(ordered){
                let b64 = String(data['ARCHIVE_B64'] || '');
                for(let c of ordered) b64 += c.archive_b64;
                let crc = this._archiveCrc(b64);
                if(crc === null || crc !== String(data['BATCH_CRC32'])){
                    console.warn("\t ANCHOR v" + format + " : batch " + data['MATCH_BATCH_SEQ'] + ' head-side reassembly CRC mismatch, flagging invalid_archive');
                    await this.indexerDb.setAnchorArchiveStatus(Number(data['ACTION_INDEX']), 'invalid_archive');
                }
            }
        }

        await this.mapper.createMappings(data);
    }

    // ANCHOR v0: the per-network checkpoint BUNDLE.
    //
    // ONE action carries every chain checkpointed this cycle. The wire is a header
    // (NETWORK, the bundle SNAPSHOT_BLOCK, SECTION_COUNT), SECTION_COUNT positional
    // sections, and ONE publisher-attestation tail for the whole bundle. Each section is
    // the checkpoint field order from CHAIN through its own signature list MINUS NETWORK:
    // the header carries the network once, and this parser REBUILDS every section's
    // XCHECKPOINT canonical with it, then WRITES it onto every section row so
    // idx_anchor_checkpoint and getMaxAnchorCheckpointSeq(chain, network) keep working
    // with no query change.
    //
    // Verdict is ALL-OR-NOTHING (spec D15). The publisher signed for every section, and
    // the stale-seq guard is strictly-less, so the only stale section is a replay or a
    // forgery rather than an ordinary cadence gap. One bad section therefore invalidates
    // the whole action ('invalid: SECTION n <reason>') and writes NO reward; a partially
    // credited bundle would let a forger pick which chains a real publisher gets paid for.
    //
    // Rows: one per section, section_index in WIRE order (0..SECTION_COUNT-1), each row
    // carrying its own chain/block_index/checkpoint_seq/roots/signatures plus the
    // denormalized network, publisher and publisher_attestations. The PK is
    // (action_index, section_index), so rollback's generic `action_index >= ?` delete
    // still drops a bundle's rows together.
    async _parseBundle(params, data, error){

        data['NETWORK']        = String(params[1] || '');
        data['SNAPSHOT_BLOCK'] = params[2];
        data['SECTION_COUNT']  = params[3];

        if(!error && String(data['NETWORK']) !== String(this.config['NETWORK'] || ''))
            error = 'invalid: NETWORK (not this network)';
        if(!error && !/^[0-9]+$/.test(String(data['SNAPSHOT_BLOCK'])))
            error = 'invalid: SNAPSHOT_BLOCK (format)';
        if(!error && (!/^[0-9]+$/.test(String(data['SECTION_COUNT'])) || Number(data['SECTION_COUNT']) < 1))
            error = 'invalid: SECTION_COUNT (format)';

        // Positional extraction. A section is 13 fixed slots (CHAIN .. SIG_COUNT) plus
        // 2*SIG_COUNT signature slots, so the cursor walks the sections and lands on the
        // publisher tail. No length cap on SECTION_COUNT is needed: a forged count runs
        // out of params on the first section it cannot fill, which fails the shape checks
        // below and stops the walk.
        const SECTION_FIXED_FIELDS = 13;
        let sections = [];
        let cursor   = 4;
        // Chains already claimed by an earlier section of THIS bundle, for the D39
        // duplicate guard below. Scoped to the walk so it cannot leak across actions.
        let seenChains = new Set();
        if(!error){
            for(let i = 0; i < Number(data['SECTION_COUNT']); i++){
                let s = {
                    FORMAT:                    0,
                    SECTION_INDEX:             i,
                    NETWORK:                   data['NETWORK'],
                    CHAIN:                     String(params[cursor]     || '').toUpperCase(),
                    BLOCK_INDEX_CHECKPOINTED:  params[cursor + 1],
                    BLOCK_HASH:                String(params[cursor + 2] || '').toLowerCase(),
                    LEDGER_HASH:               String(params[cursor + 3] || '').toLowerCase(),
                    ACTIONS_HASH:              String(params[cursor + 4] || '').toLowerCase(),
                    CONTRACT_HASH:             String(params[cursor + 5] || '').toLowerCase(),
                    CHECKPOINT_SEQ:            params[cursor + 6],
                    // The section's OWN snapshot block. The bundle header's is the MAX over
                    // sections (D6), and a lagging chain rides at its own; signatures were
                    // produced over this one, so the canonical and the oracle_publish set
                    // both resolve here rather than at the header's.
                    SNAPSHOT_BLOCK:            params[cursor + 7],
                    STATE_ROOT:                String(params[cursor + 8] || '').toLowerCase(),
                    STATE_ROOT_VERSION:        params[cursor + 9],
                    BLOCK_MERKLE_ROOT:         String(params[cursor + 10] || '').toLowerCase(),
                    BLOCK_MERKLE_VERSION:      params[cursor + 11]
                };
                let reason = this._validateSectionShape(s, seenChains);
                if(reason){ error = 'invalid: SECTION ' + i + ' ' + reason; break; }
                seenChains.add(s.CHAIN);

                let sigCount = parseInt(params[cursor + 12]);
                if(!Number.isFinite(sigCount) || sigCount < 1){
                    error = 'invalid: SECTION ' + i + ' SIG_COUNT'; break;
                }
                let sigs = [], sigReason = null;
                for(let k = 0; k < sigCount; k++){
                    let pubkey = params[cursor + SECTION_FIXED_FIELDS + 2 * k];
                    let sig    = params[cursor + SECTION_FIXED_FIELDS + 2 * k + 1];
                    if(!pubkey || !sig)                   { sigReason = 'missing sig data at index ' + k; break; }
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey)) { sigReason = 'pubkey format at index ' + k;    break; }
                    if(!/^[0-9a-fA-F]{128}$/.test(sig))   { sigReason = 'sig format at index ' + k;       break; }
                    sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
                if(sigReason){ error = 'invalid: SECTION ' + i + ' ' + sigReason; break; }
                s.SIGS = sigs;
                sections.push(s);
                cursor += SECTION_FIXED_FIELDS + 2 * sigCount;
            }
        }

        // The header block is the election and attestation block, and §2.1 fixes it as the
        // MAX over the sections. Checked rather than assumed: a header block higher than
        // every section's would move the attestation round (and the reward's earn block)
        // onto an oracle_publish set no section's signatures were ever bound to.
        if(!error && sections.length > 0){
            let maxSection = sections.reduce((m, s) => Math.max(m, Number(s.SNAPSHOT_BLOCK)), 0);
            if(Number(data['SNAPSHOT_BLOCK']) !== maxSection)
                error = 'invalid: SNAPSHOT_BLOCK (not the section maximum)';
        }

        // The bundle publisher tail, at the cursor the section walk left behind.
        let publisherSigs = [];
        if(!error){
            try {
                data['PUBLISHER'] = String(params[cursor] || '').toLowerCase();
                if(!/^[0-9a-f]{64}$/.test(data['PUBLISHER'])) throw new Error('PUBLISHER format');
                let attestCount = parseInt(params[cursor + 1]);
                if(!Number.isFinite(attestCount) || attestCount < 1) throw new Error('ATTEST_SIG_COUNT');
                for(let i = 0; i < attestCount; i++){
                    let pubkey = params[cursor + 2 + 2 * i];
                    let sig    = params[cursor + 2 + 2 * i + 1];
                    if(!pubkey || !sig)                       throw new Error('missing attestation sig at index ' + i);
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey))     throw new Error('attestation pubkey format at index ' + i);
                    if(!/^[0-9a-fA-F]{128}$/.test(sig))       throw new Error('attestation sig format at index ' + i);
                    publisherSigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
            } catch(e){
                error = 'invalid: ' + e.message;
            }
        }

        // Stale-seq replay guard, per section, against that chain's own watermark. Strictly
        // less, exactly as the archive leg reads it: an equal seq is a signature-bound
        // re-broadcast that can only produce a duplicate row, while a genuinely lower seq
        // is something the hub's selector cannot emit (its MAX subquery only ever climbs),
        // so it is a replay or a forgery. Under D15 it takes the whole bundle down.
        if(!error){
            for(let s of sections){
                let maxSeq = await this.indexerDb.getMaxAnchorCheckpointSeq(s.CHAIN, s.NETWORK);
                if(maxSeq !== null && Number(s.CHECKPOINT_SEQ) < maxSeq){
                    error = 'invalid: SECTION ' + s.SECTION_INDEX +
                            ' CHECKPOINT_SEQ (stale; replay of an older checkpoint)';
                    break;
                }
            }
        }

        // Verify each section's 2f+1 oracle_publish quorum over its OWN canonical, against
        // the set at its OWN snapshot block. Sets are memoized per block so the common case
        // (every section sharing the bundle block) costs one query, and so two sections at
        // the same block can never be judged against two different sets.
        let sets = new Map();
        const oracleSetFor = async (snapshotBlock, network) => {
            let key = String(snapshotBlock);
            if(sets.has(key)) return sets.get(key);
            let weighted   = swq.isStakeWeightedQuorumActive(Number(snapshotBlock), network);
            let validators = weighted
                ? await this.indexerDb.getStakeWeightsByCapability('oracle_publish', Number(snapshotBlock))
                : await this.indexerDb.getValidatorsByCapability('oracle_publish', Number(snapshotBlock));
            let entry = {
                weighted, validators,
                oracleN:     (validators && validators.length) ? validators.length : 0,
                snapPubkeys: new Set((validators || []).map(v => String(v.pubkey).toLowerCase()))
            };
            sets.set(key, entry);
            return entry;
        };

        let bundleSet = null;
        if(!error){
            // A single section with no locally mirrored snapshot makes the WHOLE bundle
            // 'unverified', never a mix: the verdict is one column on N rows, and recovery
            // re-verifies from the archived snapshots either way.
            for(let s of sections){
                let set = await oracleSetFor(s.SNAPSHOT_BLOCK, s.NETWORK);
                if(set.oracleN === 0){ data['STATUS'] = 'unverified'; break; }
            }
        }
        if(!error && !data['STATUS']){
            for(let s of sections){
                let set = await oracleSetFor(s.SNAPSHOT_BLOCK, s.NETWORK);
                let canonical = this._canonical(s);
                let validSigners = [], seen = new Set();
                for(let sig of s.SIGS){
                    let pk = String(sig.pubkey || '').toLowerCase();
                    if(!pk || seen.has(pk)) continue;
                    if(!set.snapPubkeys.has(pk)) continue;
                    if(!ed25519.verify(canonical, sig.sig, sig.pubkey)) continue;
                    // Marked seen only AFTER the signature verifies, matching the archive
                    // leg and the hub/SDK/explorer/sync verifiers: marking on first
                    // encounter lets a garbage-then-valid pair for one qualified validator
                    // suppress the real signature and fail a quorate section closed.
                    seen.add(pk);
                    validSigners.push(pk);
                }
                let quorumMet = set.weighted
                    ? swq.meetsStakeThreshold(set.validators, validSigners)
                    : (validSigners.length >= ((set.oracleN <= 1) ? 1 : Math.max(2 * Math.floor((set.oracleN - 1) / 3) + 1, Math.ceil((set.oracleN + 1) / 2))));
                if(!quorumMet){
                    error = 'invalid: SECTION ' + s.SECTION_INDEX + ' insufficient ' +
                            (set.weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + set.oracleN + ')');
                    break;
                }
            }
            if(!error) bundleSet = await oracleSetFor(data['SNAPSHOT_BLOCK'], data['NETWORK']);
        }

        // ONE publisher attestation for the whole bundle: reward type 'anchor_bundle',
        // round_reference SNAPSHOT_BLOCK, qualifier 0, the FROZEN ANCHOR_REWARD_AMOUNT.
        // A degraded or forged attestation never fails the anchor, exactly as on the
        // archive leg: the sections still record 'valid', only the reward is skipped.
        if(!error && bundleSet && bundleSet.oracleN > 0){
            let rewardCanonical = this._rewardCanonical(data);
            let attSigners = [], attSeen = new Set();
            for(let s of publisherSigs){
                let pk = String(s.pubkey || '').toLowerCase();
                if(!pk || attSeen.has(pk)) continue;
                if(!bundleSet.snapPubkeys.has(pk)) continue;
                if(!ed25519.verify(rewardCanonical, s.sig, s.pubkey)) continue;
                attSeen.add(pk);
                attSigners.push(pk);
            }
            let attQuorumMet = bundleSet.weighted
                ? swq.meetsStakeThreshold(bundleSet.validators, attSigners)
                : (attSigners.length >= ((bundleSet.oracleN <= 1) ? 1 : Math.max(2 * Math.floor((bundleSet.oracleN - 1) / 3) + 1, Math.ceil((bundleSet.oracleN + 1) / 2))));
            if(ar.isAnchorRewardDeriveActive(Number(data['SNAPSHOT_BLOCK']), data['NETWORK'])){
                // At/above the derive-relocation flag-day the reward is materialized by the
                // BTC indexer from the mirrored anchor_reward_attestations row (that is where
                // the oracle_publish stake resolves; ANCHOR is DOGE-only, staking is BTC-only).
                // This DOGE-side write always dropped silently, so skipping it is byte-neutral
                // to the DOGE ledger. The attestation quorum above still runs.
            } else if(attQuorumMet && bundleSet.snapPubkeys.has(String(data['PUBLISHER']))){
                let rewardRound = Number(data['SNAPSHOT_BLOCK']);
                // Qualifier 0: unlike the archive leg's reissuable MATCH_BATCH_SEQ, a
                // bundle's round_reference IS the snapshot block, a height that only
                // advances, so the (type, round) pair already names one logical reward.
                let rewardQual  = arKey.rewardRoundQualifier('anchor_bundle', data['SNAPSHOT_BLOCK']);
                let ok = await this.indexerDb.createValidatorReward(
                    data['PUBLISHER'], rewardRound, 'anchor_bundle',
                    ar.ANCHOR_REWARD_AMOUNT, Number(data['SNAPSHOT_BLOCK']), true, null, rewardQual);
                if(ok)
                    await this.indexerDb.reconcileAnchorRewardWinner(
                        rewardRound, 'anchor_bundle',
                        Number(data['BLOCK_INDEX']), Number(data['ACTION_INDEX']), rewardQual);
            } else {
                console.warn('\t ANCHOR v0 : publisher-attestation quorum not met or PUBLISHER not in oracle_publish set; reward skipped (bundle still valid)');
            }
        }

        // The tail is persisted on EVERY section row (denormalized), keeping the shipped
        // contract of these two columns: RAW wire bytes, UNVERIFIED transport, consumers
        // re-verify. Written even when the bundle is invalid, so the on-chain record is
        // complete for a later audit.
        data['PUBLISHER_ATTESTATIONS'] = (publisherSigs.length > 0) ? JSON.stringify(publisherSigs) : null;
        if(!data['STATUS']) data['STATUS'] = (error) ? error : 'valid';

        console.log("\t ANCHOR v0 : " + data['NETWORK'] + ' @ snapshot ' + data['SNAPSHOT_BLOCK'] +
                    ' (' + sections.length + ' section(s): ' + sections.map(s => s.CHAIN).join(',') + ')' +
                    ' : ' + data['STATUS']);

        // One row per section, in wire order. A bundle too malformed to yield a single
        // section still records ONE row at section_index 0 carrying the header and the
        // verdict, so a rejected action is never invisible on chain.
        if(sections.length === 0){
            await this.indexerDb.createAnchorAction(Object.assign({}, data, { SECTION_INDEX: 0 }));
        } else {
            for(let s of sections){
                let row = Object.assign({}, data, s, {
                    VALIDATOR_SIGNATURES: JSON.stringify(s.SIGS),
                    STATUS:               data['STATUS']
                });
                delete row.SIGS;
                await this.indexerDb.createAnchorAction(row);
            }
        }

        await this.mapper.createMappings(data);
    }

    // Shape-check one v0 section's fixed fields. Returns the failure reason (which the
    // caller prefixes with 'SECTION n ') or null when the section is well formed. Split
    // out so the reason strings stay in one place and read the same as the archive leg's.
    //
    // `seenChains` is the set of chains earlier sections of the SAME bundle already
    // claimed, which is why this is called in wire order and why the guard lives here
    // rather than in a post-pass: the reason has to name the LATER section, the one that
    // is the duplicate.
    _validateSectionShape(s, seenChains){
        if(ALLOWED_CHAINS.indexOf(s.CHAIN) === -1) return 'CHAIN (unknown)';
        // D39: one chain, one section. The hub's selector groups by (chain, network) and
        // can only ever produce one row per chain per bundle, so a repeat is malformed or
        // forged. It must take the whole bundle down rather than be skipped, for the same
        // reason a stale section does (D15): a second section for a chain is a SECOND
        // checkpoint claim under one publisher signature, and every per-chain reader
        // (idx_anchor_checkpoint, getanchoraction, the SDK's chain filter, the explorer's
        // per-chain table) resolves a checkpoint identity to a row without knowing a
        // sibling row contradicts it. Skipping the duplicate would also make the verdict
        // depend on which copy the parser happened to reach first.
        if(seenChains && seenChains.has(s.CHAIN)) return 'CHAIN (duplicate)';
        if(!/^[0-9]+$/.test(String(s.BLOCK_INDEX_CHECKPOINTED)) ||
           !/^[0-9]+$/.test(String(s.CHECKPOINT_SEQ)) ||
           !/^[0-9]+$/.test(String(s.SNAPSHOT_BLOCK)))
            return 'BLOCK_INDEX / CHECKPOINT_SEQ / SECTION_SNAPSHOT_BLOCK (format)';
        for(let f of ['BLOCK_HASH', 'LEDGER_HASH', 'ACTIONS_HASH', 'CONTRACT_HASH']){
            if(!/^[0-9a-f]{64}$/.test(String(s[f]))) return f + ' (format)';
        }
        // Roots are REQUIRED: a v0 bundle is root-bearing by construction (§2.1), so a
        // rootless section is malformed rather than a legacy shape to tolerate.
        if(!/^[0-9a-f]{64}$/.test(String(s.STATE_ROOT)))        return 'STATE_ROOT (format)';
        if(!/^[0-9a-f]{64}$/.test(String(s.BLOCK_MERKLE_ROOT))) return 'BLOCK_MERKLE_ROOT (format)';
        if(!/^[0-9]+$/.test(String(s.STATE_ROOT_VERSION)) ||
           !/^[0-9]+$/.test(String(s.BLOCK_MERKLE_VERSION)))
            return 'STATE_ROOT_VERSION / BLOCK_MERKLE_VERSION (format)';
        return null;
    }

    // The author an archive batch's chunk set is scoped to, or null when the
    // publisher-scoped flag day is not active for this batch, in which case every
    // caller keeps the legacy canonical-head behavior.
    //
    // The gate is anchored to the batch's CANONICAL head (earliest archive-head row for the
    // seq): it is the one row every node resolves identically without consulting
    // status, so head-side and chunk-side verdicts for one batch always apply the SAME
    // rule. No head at all means no batch to scope, hence null. The height is
    // block_index_doge (where the ANCHOR landed), never block_index (the CHECKPOINTED
    // height on the checkpointed chain, a different chain's scale entirely).
    async _archiveAuthorScope(batchSeq, source){
        let canonical = await this.indexerDb.getAnchorV1ByBatchSeq(Number(batchSeq));
        if(!canonical) return null;
        if(!abas.isArchiveBatchAuthorActive(Number(canonical.block_index_doge), this.config['NETWORK'])) return null;
        return String(source || '');
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
        // The author the batch's chunk set is scoped to, or null while the publisher-scoped
        // flag day is inert (legacy canonical-head rule).
        let scope  = null;
        if(!error){
            // The canonical head (earliest archive-head row for the seq, status-agnostic) is
            // both the legacy parent AND the flag-day anchor, so a head and its chunks
            // can never be judged under two different rules.
            let canonical = await this.indexerDb.getAnchorV1ByBatchSeq(Number(data['MATCH_BATCH_SEQ']));
            if(canonical && abas.isArchiveBatchAuthorActive(Number(canonical.block_index_doge), this.config['NETWORK'])){
                // Publisher-scoped batch: the parent is the earliest head for this seq
                // authored by THIS chunk's publisher. A junk head squatting the seq is
                // then the head of its own batch only, and governs neither the geometry
                // gate nor the chunk set of anyone else's. A chunk with no resolvable
                // author of its own scopes to nothing and lands 'orphan' (fail-closed).
                scope  = String(data['SOURCE'] || '');
                parent = !scope ? null
                       : (String(canonical.source || '') === scope)
                            ? canonical
                            : await this.indexerDb.getAnchorV1ByBatchSeq(Number(data['MATCH_BATCH_SEQ']), scope);
            } else {
                parent = canonical;
            }
            if(!parent)
                data['STATUS'] = 'orphan';
            else if(Number(parent.total_chunks) !== Number(data['TOTAL_CHUNKS']))
                error = 'invalid: TOTAL_CHUNKS (does not match parent v1)';
            // Authorship: "authenticated by its parent v1" now MEANS it. A chunk is valid
            // only when its author is the canonical archive head's author, so a slot can
            // only be occupied by the publisher whose batch it is. Without this, the
            // duplicate guard below turned first-broadcast-wins into permanent denial:
            // anyone could fill a slot with junk and the real chunk was rejected as a
            // duplicate. parent.source comes from actions.source_id (authoritative for
            // auth); a null one means the head's author cannot be resolved at all, which
            // fails closed rather than waving the chunk through unauthenticated.
            // Under a publisher-scoped batch both verdicts are unreachable by construction
            // (the parent was SELECTED by this chunk's author), so they are skipped rather
            // than dead-checked, and a chunk with no head of its own author is an 'orphan'
            // (no head to authenticate against) instead of a rejection.
            else if(scope === null && !parent.source)
                error = 'invalid: SOURCE (archive head author unresolvable)';
            else if(scope === null && String(data['SOURCE'] || '') !== String(parent.source))
                error = 'invalid: SOURCE (not the archive head publisher)';
        }

        // Duplicate chunk guard (same batch + index already stored). The occupancy set
        // getAnchorChunks returns is author-bound, so a junk chunk that landed BEFORE the
        // head (status 'orphan', no verdict of its own) no longer counts as occupying the
        // slot and can no longer get the real chunk rejected here. The occupancy set is
        // this publisher's own, so a slot filled in someone else's batch at the same seq
        // does not collide either.
        if(!error && parent){
            let existing = await this.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']), scope);
            if(existing.some(c => Number(c.chunk_index) === Number(data['CHUNK_INDEX'])))
                error = 'invalid: CHUNK_INDEX (duplicate)';
        }

        if(!data['STATUS']) data['STATUS'] = (error) ? error : 'valid';

        console.log("\t ANCHOR v2 : batch " + data['MATCH_BATCH_SEQ'] + ' chunk ' + data['CHUNK_INDEX'] +
                    '/' + data['TOTAL_CHUNKS'] + ' : ' + data['STATUS']);

        await this.indexerDb.createAnchorAction(data);

        // When the last chunk lands, verify the reassembled archive against the
        // parent v1's signed CRC and flag the parent if the blob doesn't bind. Status
        // handling and completeness are IDENTICAL to the head-side gate above (via
        // aaq.archiveChunkCoverage): the completing chunk's own status is 'valid' here (a
        // chunk is never stored 'unverified', since only _parseCheckpoint's snapshot-less
        // branch assigns that status, so the '|| unverified' term is unreachable on this
        // path and carries no flag day of its own; the head-side twin's 'unverified' term
        // IS gated, see archive_head_unverified_gate_activation.js, because there it is
        // reachable and preimage-moving). Completeness is decided by index coverage, never
        // by a bare chunk count, so a stray out-of-range orphan can neither pad an
        // incomplete set to length nor block a complete one.
        if(!error && parent && (data['STATUS'] === 'valid' || data['STATUS'] === 'unverified')){
            let chunks = await this.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']), scope);
            let ordered = aaq.archiveChunkCoverage(chunks, Number(data['TOTAL_CHUNKS']));
            if(ordered){
                let b64 = String(parent.archive_b64 || '');
                for(let c of ordered) b64 += c.archive_b64;
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
