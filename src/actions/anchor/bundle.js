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
 * ANCHOR v0, the per-network checkpoint BUNDLE. Reached through
 * Anchor.parseBundle in index.js; the shape checks live in validate.js, the
 * section and attestation quorums in quorum.js and the reward in settle.js.
 *
 ********************************************************************/

const diag     = require('./diagnostic_events.js');
const validate = require('./validate.js');
const quorum   = require('./quorum.js');
const settle   = require('./settle.js');

const { getLogger } = require('../../observability/index.js');

// Positional extraction. A section is 13 fixed slots (CHAIN .. SIG_COUNT) plus
// 2*SIG_COUNT signature slots, so the cursor walks the sections and lands on the
// publisher tail. No length cap on SECTION_COUNT is needed: a forged count runs
// out of params on the first section it cannot fill, which fails the shape checks
// below and stops the walk.
function walkSections(handler, params, data, error){
    let sections = [];
    let cursor   = 4;
    // Chains already claimed by an earlier section of THIS bundle, for the one-section-per-chain
    // duplicate guard below. Scoped to the walk so it cannot leak across actions.
    let seenChains = new Set();
    if(!error){
        for(let i = 0; i < Number(data['SECTION_COUNT']); i++){
            let s = validate.readSection(params, cursor, i, data['NETWORK']);
            let reason = handler.validateSectionShape(s, seenChains);
            if(reason){ error = 'invalid: SECTION ' + i + ' ' + reason; break; }
            seenChains.add(s.CHAIN);

            let sectionSigs = validate.parseSectionSigs(params, cursor, i);
            if(sectionSigs.error){ error = sectionSigs.error; break; }
            s.SIGS = sectionSigs.sigs;
            sections.push(s);
            cursor += validate.SECTION_FIXED_FIELDS + 2 * sectionSigs.sigCount;
        }
    }
    return { error, sections, cursor };
}

// Stale-seq replay guard, per section, against that chain's own watermark. Strictly
// less, exactly as the archive leg reads it: an equal seq is a signature-bound
// re-broadcast that can only produce a duplicate row, while a genuinely lower seq
// is something the hub's selector cannot emit (its MAX subquery only ever climbs),
// so it is a replay or a forgery. Under the all-or-nothing verdict it takes the whole bundle down.
async function checkSectionSeqs(handler, sections, error){
    if(!error){
        for(let s of sections){
            let maxSeq = await handler.indexerDb.getMaxAnchorCheckpointSeq(s.CHAIN, s.NETWORK);
            if(maxSeq !== null && Number(s.CHECKPOINT_SEQ) < maxSeq){
                error = 'invalid: SECTION ' + s.SECTION_INDEX +
                        ' CHECKPOINT_SEQ (stale; replay of an older checkpoint)';
                break;
            }
        }
    }
    return error;
}

// Persist the bundle: the verdict, the log line, the failure event and one row
// per section.
async function recordBundle(handler, data, sections, publisherSigs, error){
    // The tail is persisted on EVERY section row (denormalized), keeping the shipped
    // contract of these two columns: RAW wire bytes, UNVERIFIED transport, consumers
    // re-verify. Written even when the bundle is invalid, so the on-chain record is
    // complete for a later audit.
    data['PUBLISHER_ATTESTATIONS'] = (publisherSigs.length > 0) ? JSON.stringify(publisherSigs) : null;
    if(!data['STATUS']) data['STATUS'] = (error) ? error : 'valid';

    getLogger().info("\t ANCHOR v0 : " + data['NETWORK'] + ' @ snapshot ' + data['SNAPSHOT_BLOCK'] +
                ' (' + sections.length + ' section(s): ' + sections.map(s => s.CHAIN).join(',') + ')' +
                ' : ' + data['STATUS']);

    // A bundle verdict is all-or-nothing, so one event carries every chain the
    // rejected bundle would have checkpointed. A bundle too malformed to yield
    // a section names no chain at all, which is itself the reason.
    if(diag.isAnchorFailureStatus(data['STATUS']))
        diag.noteAnchorFailed({
            chain:          sections.map(s => s.CHAIN).join(','),
            reason:         data['STATUS'],
            network:        data['NETWORK'],
            version:        0,
            snapshot_block: data['SNAPSHOT_BLOCK'],
            block_index:    data['BLOCK_INDEX']
        });

    // One row per section, in wire order. A bundle too malformed to yield a single
    // section still records ONE row at section_index 0 carrying the header and the
    // verdict, so a rejected action is never invisible on chain.
    if(sections.length === 0){
        await handler.indexerDb.createAnchorAction(Object.assign({}, data, { SECTION_INDEX: 0 }));
    } else {
        for(let s of sections){
            let row = Object.assign({}, data, s, {
                VALIDATOR_SIGNATURES: JSON.stringify(s.SIGS),
                STATUS:               data['STATUS']
            });
            delete row.SIGS;
            await handler.indexerDb.createAnchorAction(row);
        }
    }
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
// Verdict is ALL-OR-NOTHING. The publisher signed for every section, and
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
async function parseBundleAction(handler, params, data, error){
    error = validate.validateBundleHeader(handler.config, params, data, error);

    let walk = walkSections(handler, params, data, error);
    let sections = walk.sections;
    error = walk.error;

    // The header block is the election and attestation block, and the bundle format fixes it as the
    // MAX over the sections. Checked rather than assumed: a header block higher than
    // every section's would move the attestation round (and the reward's earn block)
    // onto an oracle_publish set no section's signatures were ever bound to.
    if(!error && sections.length > 0){
        let maxSection = sections.reduce((m, s) => Math.max(m, Number(s.SNAPSHOT_BLOCK)), 0);
        if(Number(data['SNAPSHOT_BLOCK']) !== maxSection)
            error = 'invalid: SNAPSHOT_BLOCK (not the section maximum)';
    }

    let tail = validate.parseBundleTail(params, data, walk.cursor, error);
    let publisherSigs = tail.publisherSigs;
    error = tail.error;

    error = await checkSectionSeqs(handler, sections, error);

    let oracleSetFor = quorum.makeOracleSetResolver(handler);
    let verdict = await quorum.verifySections(handler, data, sections, oracleSetFor, error);
    let bundleSet = verdict.bundleSet;
    error = verdict.error;

    // ONE publisher attestation for the whole bundle: reward type 'anchor_bundle',
    // round_reference SNAPSHOT_BLOCK, qualifier 0, the FROZEN ANCHOR_REWARD_AMOUNT.
    // A degraded or forged attestation never fails the anchor, exactly as on the
    // archive leg: the sections still record 'valid', only the reward is skipped.
    if(!error && bundleSet && bundleSet.oracleN > 0){
        let attQuorumMet = quorum.bundleAttestationMet(handler, data, bundleSet, publisherSigs);
        await settle.creditBundleReward(handler, data, attQuorumMet, bundleSet);
    }

    await recordBundle(handler, data, sections, publisherSigs, error);

    await handler.mapper.createMappings(data);
}

module.exports = { parseBundleAction };
