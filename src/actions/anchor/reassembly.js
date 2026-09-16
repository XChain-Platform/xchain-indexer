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
 * ANCHOR archive reassembly: the completeness + CRC gate that binds a chunked
 * archive batch to its head's signed BATCH_CRC32, run from whichever side
 * lands last (the head in archive_head.js, the completing chunk in
 * archive_chunk.js). Both sides share the index-coverage rule
 * (aaq.archiveChunkCoverage) so the verdict never depends on arrival order.
 *
 ********************************************************************/

const gateRegistry = require('../../consensus/gate_registry');
const aaq  = require('./anchor_action_query.js');
const diag = require('./diagnostic_events.js');

const { getLogger } = require('../../observability/index.js');

// Head-side archive reassembly gate: the chunk-side gate in parseContinuation only
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
// head (the quorum branch in quorum.js sets error = 'invalid: insufficient signer stake' /
// 'insufficient valid signatures'), on which this gate never runs and no stamp
// lands, while a snapshot-less node's same head is 'unverified' with error null and
// DOES stamp. invalid_archive is projected by stateHash.js class 6, so ungated the
// two classes silently fork wherever ARCHIVE_INVALID_STATE_HASH_ACTIVATION is armed.
// Rationale and the pinning train live beside the registry row
// archive_head_unverified_gate_activation.ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION
// in src/protocol_changes/; do not re-argue it here.
async function reassembleAtHead(handler, data, error, format){
    let admitUnverifiedHead = gateRegistry.activeAt(
        'archive_head_unverified_gate_activation.ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION',
        handler.config['NETWORK'], null, Number(data['BLOCK_INDEX']), null);
    if(!error &&
       (data['STATUS'] === 'valid' || (admitUnverifiedHead && data['STATUS'] === 'unverified')) &&
       Number(data['TOTAL_CHUNKS']) > 1){
        // At/after the publisher-scoped-archive flag day, the head reassembles its OWN
        // publisher's chunks. Below it, the canonical-head rule (whatever it selects) is kept.
        let scope = await handler.archiveAuthorScope(data['MATCH_BATCH_SEQ'], data['SOURCE']);
        let chunks = await handler.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']), scope);
        let ordered = aaq.archiveChunkCoverage(chunks, Number(data['TOTAL_CHUNKS']));
        if(ordered){
            let b64 = String(data['ARCHIVE_B64'] || '');
            for(let c of ordered) b64 += c.archive_b64;
            let crc = handler.archiveCrc(b64);
            if(crc === null || crc !== String(data['BATCH_CRC32'])){
                getLogger().warn("\t ANCHOR v" + format + " : batch " + data['MATCH_BATCH_SEQ'] + ' head-side reassembly CRC mismatch, flagging invalid_archive');
                diag.noteAnchorFailed({
                    chain:           data['CHAIN'],
                    reason:          'invalid_archive: head-side reassembly CRC mismatch',
                    network:         data['NETWORK'],
                    version:         format,
                    match_batch_seq: data['MATCH_BATCH_SEQ'],
                    block_index:     data['BLOCK_INDEX']
                });
                await handler.indexerDb.setAnchorArchiveStatus(Number(data['ACTION_INDEX']), 'invalid_archive');
            }
        }
    }
}

// When the last chunk lands, verify the reassembled archive against the
// parent v1's signed CRC and flag the parent if the blob doesn't bind. Status
// handling and completeness are IDENTICAL to the head-side gate above (via
// aaq.archiveChunkCoverage): the completing chunk's own status is 'valid' here (a
// chunk is never stored 'unverified', since only parseCheckpoint's snapshot-less
// branch assigns that status, so the '|| unverified' term is unreachable on this
// path and carries no flag day of its own; the head-side twin's 'unverified' term
// IS gated, see the archive_head_unverified_gate_activation row in src/protocol_changes/, because there it is
// reachable and preimage-moving). Completeness is decided by index coverage, never
// by a bare chunk count, so a stray out-of-range orphan can neither pad an
// incomplete set to length nor block a complete one.
async function reassembleAtChunk(handler, data, parent, scope, error){
    if(!error && parent && (data['STATUS'] === 'valid' || data['STATUS'] === 'unverified')){
        let chunks = await handler.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']), scope);
        let ordered = aaq.archiveChunkCoverage(chunks, Number(data['TOTAL_CHUNKS']));
        if(ordered){
            let b64 = String(parent.archive_b64 || '');
            for(let c of ordered) b64 += c.archive_b64;
            let crc = handler.archiveCrc(b64);
            if(crc === null || crc !== String(parent.batch_crc32)){
                getLogger().warn("\t ANCHOR v2 : batch " + data['MATCH_BATCH_SEQ'] + ' reassembly CRC mismatch, flagging invalid_archive');
                diag.noteAnchorFailed({
                    chain:           parent.chain,
                    reason:          'invalid_archive: reassembly CRC mismatch',
                    network:         handler.config['NETWORK'],
                    version:         2,
                    match_batch_seq: data['MATCH_BATCH_SEQ'],
                    block_index:     data['BLOCK_INDEX']
                });
                await handler.indexerDb.setAnchorArchiveStatus(Number(parent.action_index), 'invalid_archive');
            }
        }
    }
}

module.exports = { reassembleAtHead, reassembleAtChunk };
