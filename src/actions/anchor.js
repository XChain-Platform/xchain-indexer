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
 * the cross-chain match archive (v1), and archive continuation chunks (v2).
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
 *
 ********************************************************************/

const zlib    = require('zlib');
const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');

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
        if(Number(d['FORMAT']) === 1){
            base += '|' + String(d['MATCH_BATCH_SEQ']) + '|' + String(d['MATCH_COUNT']) + '|' +
                    d['BATCH_CRC32'] + '|' + String(d['TOTAL_CHUNKS']);
            roundId += '|' + d['MATCH_BATCH_SEQ'];
        }
        if(eq.isEquivHeaderActive(d['SNAPSHOT_BLOCK'], d['NETWORK']))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
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
        if(format === 1){
            data['MATCH_BATCH_SEQ'] = params[10];
            data['MATCH_COUNT']     = params[11];
            data['BATCH_CRC32']     = String(params[12] || '').toLowerCase();
            data['TOTAL_CHUNKS']    = params[13];
            data['ARCHIVE_B64']     = String(params[14] || '');
            sigBase = 15;
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
        if(!error && format === 1){
            if(!/^[0-9]+$/.test(String(data['MATCH_BATCH_SEQ'])) ||
               !/^[0-9]+$/.test(String(data['MATCH_COUNT'])) ||
               !/^[0-9]+$/.test(String(data['TOTAL_CHUNKS'])) || Number(data['TOTAL_CHUNKS']) < 1)
                error = 'invalid: MATCH_BATCH_SEQ / MATCH_COUNT / TOTAL_CHUNKS (format)';
            else if(!/^[0-9a-f]{8}$/.test(String(data['BATCH_CRC32'])))
                error = 'invalid: BATCH_CRC32 (format)';
            else if(!data['ARCHIVE_B64'] || !/^[0-9a-zA-Z_-]+$/.test(String(data['ARCHIVE_B64'])))
                error = 'invalid: ARCHIVE_B64 (format)';
        }

        // ── Parse the signature list ──────────────────────────────────────────
        let sigs = [];
        if(!error){
            try {
                let sigCount = parseInt(params[sigBase]);
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

        // ── Replay guards: never accept a seq BELOW the recorded max. Equal is
        // allowed: a v0 and its v1 share the same checkpoint_seq by design
        // (same wrapper), and an exact replay is signature-bound to identical
        // content, so it can only produce a harmless duplicate row. ──────────
        if(!error){
            let maxSeq = await this.indexerDb.getMaxAnchorCheckpointSeq(data['CHAIN'], data['NETWORK']);
            if(maxSeq !== null && Number(data['CHECKPOINT_SEQ']) < maxSeq)
                error = 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)';
        }
        if(!error && format === 1){
            let maxBatch = await this.indexerDb.getMaxAnchorBatchSeq();
            if(maxBatch !== null && Number(data['MATCH_BATCH_SEQ']) < maxBatch)
                error = 'invalid: MATCH_BATCH_SEQ (stale; replay of an older archive batch)';
        }

        // ── v1 archive integrity (single-chunk batches verify inline; chunked
        //    batches verify at reassembly when the last v2 arrives) ────────────
        if(!error && format === 1 && Number(data['TOTAL_CHUNKS']) === 1){
            let crc = this._archiveCrc(data['ARCHIVE_B64']);
            if(crc === null)                          error = 'invalid: ARCHIVE_B64 (not gzip)';
            else if(crc !== data['BATCH_CRC32'])      error = 'invalid: BATCH_CRC32 (archive mismatch)';
        }

        // ── Verify 2f+1 oracle_publish signatures over the canonical ─────────
        // SNAPSHOT_BLOCK comes from the wire payload (a BTC height), NOT from
        // the DOGE block this ANCHOR landed in.
        if(!error){
            let snapshotBlock = Number(data['SNAPSHOT_BLOCK']);
            // Stake-weighted (source-deduped) at/above STAKE_WEIGHTED_QUORUM (keyed on
            // the BTC snapshot_block + the checkpoint's network), else legacy 2f+1 count.
            let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, data['NETWORK']);
            let validators = weighted
                ? await this.indexerDb.getStakeWeightsByCapability('oracle_publish', snapshotBlock)
                : await this.indexerDb.getValidatorsByCapability('oracle_publish', snapshotBlock);
            let N = (validators && validators.length) ? validators.length : 0;
            if(N === 0){
                // No oracle_publish snapshot mirrored locally (offline resync / no hub).
                // Store as 'unverified'; recovery re-verifies from archived snapshots.
                data['STATUS'] = 'unverified';
            } else {
                let canonical = this._canonical(data);
                let snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
                let validSigners = [], seen = new Set();
                for(let s of sigs){
                    let pk = String(s.pubkey || '').toLowerCase();
                    if(seen.has(pk)) continue;
                    seen.add(pk);
                    if(!snapPubkeys.has(pk)) continue;
                    if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
                    validSigners.push(pk);
                }
                let quorumMet = weighted
                    ? swq.meetsStakeThreshold(this.util, validators, validSigners)
                    : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
                if(!quorumMet)
                    error = 'invalid: insufficient ' + (weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + N + ')');
            }
        }

        data['VALIDATOR_SIGNATURES'] = JSON.stringify(sigs);
        if(!data['STATUS']) data['STATUS'] = (error) ? error : 'valid';

        console.log("\t ANCHOR v" + format + " : " + data['CHAIN'] + '/' + data['NETWORK'] +
                    ' @ ' + data['BLOCK_INDEX_CHECKPOINTED'] + ' seq ' + data['CHECKPOINT_SEQ'] +
                    (format === 1 ? ' batch ' + data['MATCH_BATCH_SEQ'] + ' (' + data['MATCH_COUNT'] + ' matches, ' + data['TOTAL_CHUNKS'] + ' chunk(s))' : '') +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createAnchorAction(data);
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
        }

        // Duplicate chunk guard (same batch + index already stored).
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
        try { json = zlib.gunzipSync(Buffer.from(String(b64), 'base64url')).toString('utf8'); }
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
