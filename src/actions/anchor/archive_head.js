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
 * ANCHOR v1, the archive head: the checkpoint wrapper carrying the match
 * archive segment plus the publisher-attestation tail. Reached through
 * Anchor.parseCheckpoint in index.js; the shape checks live in validate.js,
 * the quorums in quorum.js, the reward in settle.js and the chunked-batch CRC
 * gate in reassembly.js.
 *
 ********************************************************************/

const diag       = require('./diagnostic_events.js');
const validate   = require('./validate.js');
const quorum     = require('./quorum.js');
const settle     = require('./settle.js');
const reassembly = require('./reassembly.js');

const { getLogger } = require('../../observability/index.js');

async function checkReplayGuards(handler, data, error){
    // Replay guards: never accept a seq BELOW the recorded max. Equal is allowed: a v0
    // and its v1 share the same checkpoint_seq by design (same wrapper), and an exact
    // replay is signature-bound to identical content, so it can only produce a harmless
    // duplicate row.
    if(!error){
        let maxSeq = await handler.indexerDb.getMaxAnchorCheckpointSeq(data['CHAIN'], data['NETWORK']);
        if(maxSeq !== null && Number(data['CHECKPOINT_SEQ']) < maxSeq)
            error = 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)';
    }
    // The archive half of the guard needs a second condition: MATCH_BATCH_SEQ is a dense
    // counter the hub allocates from its own tables (StateAnchorPublisher.getNextBatchSeq:
    // MAX(batch_seq)+1 over cross_chain_matches / cross_chain_calls / validator_rewards),
    // and those tables are reset by a wipe-and-replay rebase while this watermark (read
    // from replayed anchor_actions) returns to the pre-rebase maximum. Seq alone cannot
    // tell "the hub's counter restarted" from "someone is replaying an old archive", and
    // reading it alone fails closed: every post-rebase archive indexes invalid, the
    // invalid row does not advance the watermark, and the rail stays down for as many
    // batches as history had, while paying real DOGE for each attempt.
    //
    // The wrapper checkpoint seq settles it: CHECKPOINT_SEQ is NOT dense, it equals
    // snapshot_block, a chain value that keeps advancing across any wipe. A genuine
    // replay is signature-bound to its original canonical and so carries the OLD
    // checkpoint seq; a post-rebase archive carries a strictly higher one. So a low
    // batch seq is stale only when the checkpoint is ALSO behind the newest archive's.
    //
    // Deliberately "behind", not "not ahead": two archives can legitimately ride ONE
    // checkpoint (a second batch draining leftover rows in the same cadence), and the
    // equal case is already tolerated elsewhere in this guard since an exact re-broadcast
    // is signature-bound to identical content and can only produce a duplicate row, which
    // the archive-head pick is already required to handle deterministically.
    if(!error){
        let wm = await handler.indexerDb.getArchiveReplayWatermarks();
        let batchStale      = (wm.batchSeq !== null && Number(data['MATCH_BATCH_SEQ']) < wm.batchSeq);
        let checkpointStale = (wm.checkpointSeq !== null && Number(data['CHECKPOINT_SEQ']) < wm.checkpointSeq);
        if(batchStale && checkpointStale)
            error = 'invalid: MATCH_BATCH_SEQ (stale; replay of an older archive batch)';
    }
    return error;
}

// Persist the head: signatures, the raw publisher tail and the verdict, then the
// log line, the failure event and the anchor_actions row.
async function recordHead(handler, data, sigs, publisherSigs, error, format){
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

    getLogger().info("\t ANCHOR v" + format + " : " + data['CHAIN'] + '/' + data['NETWORK'] +
                ' @ ' + data['BLOCK_INDEX_CHECKPOINTED'] + ' seq ' + data['CHECKPOINT_SEQ'] +
                ' batch ' + data['MATCH_BATCH_SEQ'] + ' (' + data['MATCH_COUNT'] + ' matches, ' + data['TOTAL_CHUNKS'] + ' chunk(s))' +
                ' : ' + data['STATUS']);

    // A refused archive head prints through the same console.log as an
    // accepted one, at the same level, one word apart. The event separates
    // them for anything reading the stream.
    if(diag.isAnchorFailureStatus(data['STATUS']))
        diag.noteAnchorFailed({
            chain:          data['CHAIN'],
            reason:         data['STATUS'],
            network:        data['NETWORK'],
            version:        format,
            checkpoint_seq: data['CHECKPOINT_SEQ'],
            block_index:    data['BLOCK_INDEX']
        });

    await handler.indexerDb.createAnchorAction(data);
}

// ANCHOR v1: the archive head (a checkpoint wrapper carrying the match archive plus
// the publisher-attestation tail).
async function parseArchiveHead(handler, params, data, error, format){
    let sigBase = validate.readHeadFields(params, data);

    // Structural validation
    error = validate.validateHeadShape(handler.config, data, error);
    // Parse the signature list, then the publisher tail it locates
    let root = validate.parseHeadSigs(params, sigBase, error);
    let sigs = root.sigs;
    error = root.error;
    let tail = validate.parseHeadPublisherTail(params, data, sigBase, root.sigCount, error, format);
    let publisherSigs = tail.publisherSigs;
    error = tail.error;

    error = await checkReplayGuards(handler, data, error);

    // v1 archive integrity (single-chunk batches verify inline; chunked batches verify
    // at reassembly when the last v2 arrives)
    if(!error && Number(data['TOTAL_CHUNKS']) === 1){
        let crc = handler.archiveCrc(data['ARCHIVE_B64']);
        if(crc === null)                          error = 'invalid: ARCHIVE_B64 (not gzip)';
        else if(crc !== data['BATCH_CRC32'])      error = 'invalid: BATCH_CRC32 (archive mismatch)';
    }

    let q = await quorum.verifyHeadQuorum(handler, data, sigs, error);
    error = q.error;

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
    // double-publish, identical to the retired push path and its recovery, so the COLLECT
    // rail stays single-winner fleet-wide. Reward type anchor_archive,
    // round = MATCH_BATCH_SEQ.
    if(!error && format === 1 && q.snapPubkeys && q.oracleN > 0){
        let attQuorumMet = quorum.headAttestationMet(handler, data, publisherSigs, q);
        await settle.creditArchiveReward(handler, data, attQuorumMet, q.snapPubkeys, format);
    }

    await recordHead(handler, data, sigs, publisherSigs, error, format);
    await reassembly.reassembleAtHead(handler, data, error, format);

    await handler.mapper.createMappings(data);
}

module.exports = { parseArchiveHead };
