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
 * full chain parse alone (bin/recovery.js). Live indexers keep settling
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
 *        sections, one publisher-attestation tail (see parseBundle)
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
const eq      = require('../../equivocation_header.js');
const ar      = require('../../anchor_reward_activation.js');
const abas    = require('../../archive_batch_author_activation.js');
const aact    = require('../../anchor_activation.js');

// The three wire families and their shared steps, one part file each.
const validate     = require('./validate.js');
const archiveHead  = require('./archive_head.js');
const bundle       = require('./bundle.js');
const archiveChunk = require('./archive_chunk.js');

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
        // Per-version format strings
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
        // |BLOCK_MERKLE_VERSION|SIG_COUNT|(PUBKEY|SIG)..., walked positionally by parseBundle.
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
    canonical(d){
        let base = ['XCHECKPOINT', d['CHAIN'], d['NETWORK'], String(d['BLOCK_INDEX_CHECKPOINTED']),
                    d['BLOCK_HASH'], d['LEDGER_HASH'], d['ACTIONS_HASH'], d['CONTRACT_HASH'],
                    String(d['CHECKPOINT_SEQ']), String(d['SNAPSHOT_BLOCK'])].join('|');
        // A checkpoint ROUND_ID is chain|network|block|checkpoint_seq; the archive head
        // appends batch_seq so the checkpoint and archive canonicals (which share
        // checkpoint_seq) get DISTINCT equivocation keys (so no honest validator is falsely slashed). Must
        // byte-match the hub.
        let roundId = d['CHAIN'] + '|' + d['NETWORK'] + '|' + d['BLOCK_INDEX_CHECKPOINTED'] + '|' + d['CHECKPOINT_SEQ'];
        if(Number(d['FORMAT']) === 1){
            // Archive head: rootless checkpoint base + archive extension. Byte-matches the
            // hub's archiveCanonical, which nests the bare rawCanonicalCheckpoint; the
            // wrapper sigs are produced over the SAME archive canonical (the publisher tail
            // is attested separately via rewardCanonical).
            base += '|' + String(d['MATCH_BATCH_SEQ']) + '|' + String(d['MATCH_COUNT']) + '|' +
                    d['BATCH_CRC32'] + '|' + String(d['TOTAL_CHUNKS']);
            roundId += '|' + d['MATCH_BATCH_SEQ'];
        } else if(Number(d['FORMAT']) === 0){
            // Append the root suffix UNCONDITIONALLY, alone among the four canonical
            // builders: hub (checkpointRootSuffix), SDK and explorer all gate it on
            // isCheckpointCommitmentActive. The divergence is deliberate and
            // belongs to the per-network anchor bundle.
            //
            // Parity therefore rests on a PRODUCER-side invariant, not on a shared gate:
            // no bundle may carry a section whose OWN snapshot block is below
            // CHECKPOINT_COMMITMENT_ACTIVATION. Nothing enforces that here or in the hub's
            // rootless-row skip, which drops a row on root ABSENCE only, and roots appear at the
            // EARLIER per-chain STATE_COMMITMENT gate. So the invariant is a deployment
            // fact (every checkpoint the live federations cut is far past the height),
            // not a code property.
            //
            // Fail-closed if it ever breaks: the hub signed such a row rootless, so every
            // section signature fails and the all-or-nothing verdict takes the whole bundle down. It never
            // adopts unsigned roots.
            //
            // `d` is ONE section, rebuilt with the header NETWORK and with SNAPSHOT_BLOCK =
            // its own SECTION_SNAPSHOT_BLOCK, the block its signatures were produced over.
            base += '|' + [String(d['STATE_ROOT'] || '').toLowerCase(), String(d['STATE_ROOT_VERSION']),
                           String(d['BLOCK_MERKLE_ROOT'] || '').toLowerCase(), String(d['BLOCK_MERKLE_VERSION'])].join('|');
        }
        if(eq.isEquivHeaderActive(d['SNAPSHOT_BLOCK'], d['NETWORK']))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        return base;
    }

    // Publisher-attestation canonical (XANCPUB): the string the 2f+1 oracle_publish quorum
    // signs to ATTEST which validator earns the anchor reward. MUST byte-match the hub's
    // StateAnchorPublisher.attestationCanonical. The amount is the FROZEN consensus constant
    // (ar.ANCHOR_REWARD_AMOUNT), NEVER taken from the wire. A distinct 'XANCPUB|...' roundId
    // prefix gives the attestation its OWN equivocation family, so a validator that signs both
    // the checkpoint root canonical and this reward attestation in the same round is never
    // falsely slashable (same false-slash reasoning as the checkpoint/archive roundId split above).
    rewardCanonical(d){
        // Archive leg (v1): the attested tuple is the anchor_archive reward, keyed on
        // MATCH_BATCH_SEQ (the archive round number) with the frozen ARCHIVE amount. MUST
        // byte-match the hub's StateAnchorPublisher.archiveAttestationCanonical. The
        // 'XANCPUB|archive|...' roundId is disjoint from the bundle's ('XANCPUB|bundle|...')
        // and from the retired per-chain family ('XANCPUB|BTC|...'), so the attestation
        // families can never equivocation-collide (same false-slash reasoning as the checkpoint
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

    // Dispatch on VERSION
    async parse(params, data, error){
        let format = data['FORMAT'];

        // Activation FIRST, ahead of the version table: below ANCHOR_ACTIVATION the same
        // version bytes belonged to the pre-restart wire set, so no shape check on these
        // bytes means anything and every ANCHOR down there is invalid whatever it decodes
        // to. Keyed on the anchor's OWN DOGE mined height (data['BLOCK_INDEX'], the same
        // key the unverified-head gate in reassembly.js reads), never on SNAPSHOT_BLOCK or the
        // checkpointed height, which belong to other chains. isAnchorActive fails closed on
        // a non-numeric height or an unknown network.
        if(!error && !aact.isAnchorActive(Number(data['BLOCK_INDEX']), this.config['NETWORK']))
            error = 'invalid: ANCHOR before activation';

        // Verify VERSION is one this parser knows (the table in the constructor is the whole wire set)
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // ANCHOR is valid only on the anchor chain: DOGE (all networks).
        if(!error && String(this.config['COIN']) !== 'DOGE')
            error = 'invalid: ANCHOR only valid on DOGE';

        // Dispatch by family. An unparseable version still lands on a body parser (carrying
        // the error), and the archive-head parser is the fall-through, so a rejected action
        // is recorded rather than dropped.
        if(format === 2) return await this.parseContinuation(params, data, error);
        if(format === 0) return await this.parseBundle(params, data, error);
        return await this.parseCheckpoint(params, data, error, format);
    }

    // ANCHOR v1: the archive head (a checkpoint wrapper carrying the match archive plus
    // the publisher-attestation tail). The body lives in archive_head.js.
    async parseCheckpoint(params, data, error, format){
        return await archiveHead.parseArchiveHead(this, params, data, error, format);
    }

    // ANCHOR v0: the per-network checkpoint BUNDLE, one all-or-nothing action for every
    // chain checkpointed this cycle. The body lives in bundle.js.
    async parseBundle(params, data, error){
        return await bundle.parseBundleAction(this, params, data, error);
    }

    // Shape-check one v0 section's fixed fields: the failure reason, or null when the
    // section is well formed. The rules and their reasons live in validate.js.
    validateSectionShape(s, seenChains){
        return validate.sectionShapeReason(s, seenChains);
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
    async archiveAuthorScope(batchSeq, source){
        let canonical = await this.indexerDb.getAnchorV1ByBatchSeq(Number(batchSeq));
        if(!canonical) return null;
        if(!abas.isArchiveBatchAuthorActive(Number(canonical.block_index_doge), this.config['NETWORK'])) return null;
        return String(source || '');
    }

    // ANCHOR v2: archive continuation chunk (authenticated by its parent v1). The body
    // lives in archive_chunk.js.
    async parseContinuation(params, data, error){
        return await archiveChunk.parseArchiveChunk(this, params, data, error);
    }

    // CRC32 (hex) of the decompressed archive; null when the blob isn't valid gzip.
    archiveCrc(b64){
        let json;
        // Bound the decompressed output: ARCHIVE_B64 is attacker-supplied, freely
        // broadcastable on-chain data decompressed here BEFORE any signature/quorum
        // check, so an unbounded gunzip is a gzip-bomb memory-DoS vector. zlib throws
        // RangeError past the cap and the catch below rejects the archive as invalid.
        try { json = zlib.gunzipSync(Buffer.from(String(b64), 'base64url'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'); }
        catch(e){ return null; }
        let n = zlib.crc32 ? zlib.crc32(Buffer.from(json, 'utf8')) : this.crc32Fallback(Buffer.from(json, 'utf8'));
        return (n >>> 0).toString(16).padStart(8, '0');
    }
    crc32Fallback(buf){
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
