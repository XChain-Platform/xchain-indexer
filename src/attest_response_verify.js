/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The ATTEST response verifier, ONE implementation for both delivery paths
 * (the ATTEST response-mirror design, §4.3).
 *
 * WHY THIS IS A MODULE AND NOT A METHOD. Today an attestation response reaches an
 * indexer as an on-chain ATTEST v1 transaction. Above the response-mirror flag day
 * it reaches the indexer through the hub mirror instead, with no transaction of
 * its own. The two paths carry the SAME artifact and must reach the SAME verdict
 * on it, or a mirror-fed node and a batch-replaying node disagree about whether a
 * contract callback fired. Two copies of this logic would diverge on the first
 * one-sided edit, and the symptom would be a silent fork rather than a failure, so
 * there is exactly one copy and both callers call it.
 *
 * THIS FILE ADDED NO BEHAVIOUR WHEN IT WAS CREATED. It is the verify block lifted
 * verbatim out of actions/attest.js `_parseResponse`, with the heights it used to
 * read off the surrounding scope turned into parameters. Its byte-behaviour is
 * pinned by test/unit/actions/attest-response-verify-vectors.test.js, whose
 * expected canonicals and error strings were CAPTURED from the pre-extraction
 * handler.
 *
 * THE SNAPSHOT HEIGHT IS NOT AN INPUT, AND THAT IS THE SECURITY PROPERTY.
 * The capability set is resolved at `srb.buriedSnapshotBlock(request.block_index)`
 * where `request` is the caller's OWN local v0 row. There is deliberately no
 * parameter for the declared height or the snapshot height: on the mirror path the
 * row arrives from a hub that the trust model treats as transport, never as
 * authority, and a hub that could name the height it is verified at could name a
 * height at which it controlled the responsible set. Making the height unreachable
 * from the argument list is what makes that attack unimplementable rather than
 * merely unimplemented. If a future caller "needs" to pass a height, that is the
 * attack, not a missing feature.
 *
 * THE ERROR STRINGS ARE CONSENSUS STATE. The caller writes the returned `error`
 * verbatim into `attests.status`, which is hashed into the ledger. Rewording one
 * is a fork, not a cosmetic change. They are pinned as literals in the vector
 * suite for that reason.
 *
 ********************************************************************/

'use strict';

const crypto  = require('crypto');
const ed25519 = require('./ed25519.js');
const swq     = require('./stake_weighted_quorum.js');
const wid     = require('./attest_responsible_widening_activation.js');
const eq      = require('./equivocation_header.js');
const srb     = require('./snapshot_reorg_buffer.js');
const { buildResponseCanonicalRaw } = require('./attest_response_canonical.js');

// Verify a response artifact's federation signatures against the capability
// snapshot and the request's deterministic responsible set.
//
// Inputs, and which plane each one lives on:
//
//   request            the caller's OWN local v0 request row, or null when an
//                      earlier check already failed. Never a wire-supplied row.
//   sigs               [{pubkey, sig}], already format-checked and lower-cased by
//                      the caller; wire parsing is not this module's job.
//   requestId          the LOWER-CASED request id.
//   requestIdRaw       the id exactly as it arrived. Consensus-relevant: see the
//                      lower-case gate below.
//   providerId,
//   responseStatus,
//   meta               the remaining canonical fields, as they arrived.
//   responseBodyBytes  the DECODED body. Hashed here, not by the caller, so the
//                      hash the canonical signs and the hash the caller stores can
//                      never be two different computations.
//   atBlock            the block this response is being judged AT. Drives the
//                      widening ladder (see below) and stands in for the declared
//                      height only on the unreachable branch noted there. On the
//                      chain path this is the v1 action's block; on the mirror path
//                      it is the block the row is being applied at.
//   gateBlock          the block the ATTEST_CANONICAL_LOWERCASE_ID flag day is
//                      evaluated at. Separate from atBlock on purpose: see the gate.
//   error              an error string already set by the caller, or null. When set,
//                      verification is skipped entirely and the string passes through.
//   coin, network      this indexer's plane.
//   indexerDb          the capability queries.
//   protocolChanges    the block-time-keyed protocol-change gate.
//   computeResponsibleSet  the caller's own _computeResponsibleSet, injected. It is
//                      a method that reads this.config, this.providerRegistry and
//                      this.indexerDb, and every path that computes a request's
//                      responsible set MUST use that one derivation or the stat
//                      columns and the fee split desynchronize.
//
// Returns {ok, error, verifiedSigs, validSigs, responseHash, canonical}.
async function verifyAttestationResponse(input){
    let request           = input.request;
    let sigs              = input.sigs || [];
    let requestId         = input.requestId;
    let requestIdRaw      = input.requestIdRaw;
    let providerId        = input.providerId;
    let responseStatus    = input.responseStatus;
    let meta              = input.meta;
    let responseBodyBytes = input.responseBodyBytes;
    let atBlock           = input.atBlock;
    let gateBlock         = input.gateBlock;
    let error             = input.error || null;
    let coin              = input.coin;
    let network           = input.network;
    let indexerDb         = input.indexerDb;
    let protocolChanges   = input.protocolChanges;
    let computeResponsibleSet = input.computeResponsibleSet;

    // The DECLARED height of this round: the REQUEST's block, deterministic from the
    // request_id every signer keyed on. Two different things are derived from it and
    // they must not be conflated.
    //
    // 1. The flag-day inputs (EQUIV header below) are evaluated on the DECLARED height,
    //    verbatim. Shifting a flag-day boundary by the reorg buffer would move the
    //    cutover block itself, which is its own fork.
    // 2. The height the capability set is RESOLVED at is the declared height BURIED by
    //    the canonical reorg buffer, because that is what the hub actually resolved at:
    //    CapabilitySnapshot subtracts CANONICAL_REORG_BUFFER from every height it is
    //    handed (_buriedBlockIndex) while AttestationRound passes the raw
    //    request.block_index, so the responsible set the hub signed is the set at
    //    (declared - 6). Verifying at the raw height resolved a DIFFERENT set whenever a
    //    validator's stake activated or deactivated inside (declared - 6, declared],
    //    which rejects a correct deterministic response or stalls the round. Gated:
    //    below the flag-day this is the declared height unchanged, so pre-flag-day
    //    acceptance is byte-preserved.
    //
    // The `atBlock` fallback is reachable ONLY with a null request, and a null request
    // always means the caller already set `error` (either before the lookup or because
    // the lookup missed), so the canonical it feeds is built and then never verified
    // against. It exists to keep the pre-error code path allocation-identical to the
    // handler this was lifted from, not because a heightless round is meaningful.
    let declaredBlock = request ? Number(request.block_index) : Number(atBlock);
    let snapshotBlock = srb.buriedSnapshotBlock(declaredBlock, network);

    // Build canonical signing message (UTF-8 Buffer). At/above the EQUIV flag-day
    // (WI-2 bump 2) the raw string is wrapped in the uniform header (TAG=XATTEST,
    // ROUND_ID=request_id, VIEW=0, no view change), gated on the request's block +
    // network; below it, the bare bytes. Byte-matches AttestationConsensus._buildCanonical.
    let responseHash = crypto.createHash('sha256').update(responseBodyBytes).digest('hex');
    // The id case inside the canonical is gated. The hub signs the LOWERCASE rid and
    // the only live producer lowercases before broadcast, but whether the canonical
    // uses the raw wire case or the lowercased id is CONSENSUS BEHAVIOUR: legacy nodes
    // build it from the RAW wire id, so a case-mutated replay of a pending v1 fails
    // signature verification there, and lowercasing ungated would make the same wire
    // bytes verify on an upgraded node and fork the fleet.
    //
    // `gateBlock` IS the action's own block, and the change is block-TIME keyed rather
    // than height keyed (protocol_changes.js). Spec §4.3 says this is evaluated at the
    // request's block "as the hub does"; it is wrong on both counts (the hub has no such
    // gate and lowercases unconditionally), and inventory D57 records that. The mirror
    // path's synthesized action is minted at the applying block, so passing that block
    // here keeps the identical evaluation without re-keying anything.
    let canonId  = (await protocolChanges.isEnabled('ATTEST_CANONICAL_LOWERCASE_ID', gateBlock))
                 ? String(requestId) : String(requestIdRaw);
    // LEGACY ERA ONLY, for now. `effectiveTime: null` makes buildResponseCanonicalRaw
    // return the historical five-field concatenation byte for byte, which is the whole
    // reason this call stands in for a hand-rolled string in the handler: one
    // spelling of the canonical, shared with the hub twin. The mirror-era canonical
    // appends the signed effective_time; wiring that through is the mirror applier's
    // row, and it belongs HERE as a caller-selected field, never as something this
    // module infers from the row it is verifying.
    let canonRaw = buildResponseCanonicalRaw({
        requestId:     canonId,
        providerId:    String(providerId),
        responseHash:  responseHash,
        status:        String(responseStatus),
        meta:          meta,
        effectiveTime: null,
    });
    if(eq.isEquivHeaderActive(declaredBlock, network))
        canonRaw = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, canonId, 0, canonRaw);
    let canonical    = Buffer.from(canonRaw, 'utf8');
    let validSigs    = 0;
    let verifiedSigs = [];

    if(!error){
        // Resolve the attestation-eligible set ONCE (hasCapability is ~5 sequential
        // queries per signer), from the SAME derivation the responsible-set filter
        // below uses. The two MUST agree on eligibility or a responsible signer is
        // discarded here, before it is ever counted.
        //
        // At/above STAKE_WEIGHTED_QUORUM _computeResponsibleSet selects
        // getStakeWeightsByCapability, whose _stakeWeightsSql qualifies a staking
        // SOURCE on its aggregate and then emits ALL of that source's effective keys,
        // while getValidatorsByCapability / hasCapability qualify each PUBKEY on its
        // own aggregate (_effectiveCapabilitySetSql GROUP BY ip.pubkey HAVING, whose
        // only widening branch is a `delegations` row). A source clearing MIN_STAKE
        // only in aggregate across sub-threshold stake keys is therefore IN the
        // weighted responsible set and OUT of the pubkey-aggregate set, so its valid
        // signatures were dropped here and validSigs could never reach redundancy:
        // the responsible set is exactly REDUNDANCY keys, so losing even one made the
        // request permanently unfulfillable while every retry burned a real fee and
        // expiry charged missed_count to the whole set, honest signers included.
        //
        // Selecting the weighted query here widens eligibility only UP TO the weighted
        // set, and the responsible filter below is derived from that same query at
        // this same block, so it still clips acceptance to the deterministic
        // top-REDUNDANCY selection: no coalition that was not already responsible can
        // land a response. Gated exactly as _computeResponsibleSet is, and for its
        // reasons: BTC ONLY, because the SWQ anchor is a BTC height and evaluating it
        // against an LTC/DOGE local height resolves TRUE out of band; and on the
        // DECLARED height, because moving a flag-day boundary by the reorg buffer is
        // its own fork. `snapshotBlock` is ALREADY the buried resolve height (see the
        // note above), so it must NOT be buried a second time here.
        let weighted    = (coin === 'BTC')
                       && swq.isStakeWeightedQuorumActive(declaredBlock, network);
        let capableRows = weighted
                        ? await indexerDb.getStakeWeightsByCapability('attestation', snapshotBlock)
                        : await indexerDb.getValidatorsByCapability('attestation', snapshotBlock);
        // A truncated read has silently-dropped rows. Below the gate, fall back
        // per-signer to hasCapability rather than drop a capable co-signer: that probe
        // is the same pubkey aggregate the unweighted set is built from, so the two
        // still agree. On the weighted branch there is NO per-signer equivalent -
        // hasCapability sums WHERE s.signing_pubkey_id = ?, the pubkey aggregate
        // again, so falling back to it would reinstate this exact bug on precisely the
        // truncated read where the federation is largest. Take the truncated rows as
        // they stand instead: _computeResponsibleSet resolves the responsible set from
        // the SAME truncated read at the same block, so eligibility still covers it and
        // the responsible filter stays the binding gate.
        let capableSet  = (!weighted && capableRows && capableRows.truncated === true)
                        ? null
                        : new Set((capableRows || []).map(v => String(v.pubkey).toLowerCase()));
        // Dedupe BEFORE the verify, not after. A pubkey gets one attempt: the first
        // entry that names it. Deduping after the verify would let a producer append a
        // second, good signature behind a bad one for the same key and have it counted,
        // which makes the number of admitted signatures depend on how many entries a
        // producer chose to send rather than on how many distinct responsible
        // validators signed.
        let seenPubkey = new Set();
        for(let s of sigs){
            if(seenPubkey.has(s.pubkey)) continue;
            seenPubkey.add(s.pubkey);
            if(capableSet
                ? !capableSet.has(s.pubkey)
                : !await indexerDb.hasCapability(s.pubkey, 'attestation', snapshotBlock))
                continue;
            if(!ed25519.verify(canonical, s.sig, s.pubkey))
                continue;
            verifiedSigs.push(s);
        }

        // Restrict the verified signers to the request's deterministic
        // responsible set (the top-REDUNDANCY validators ranked by
        // SHA256(request_id || pubkey), the same set _parseExpire charges
        // missed_count to. Holding the attestation capability and producing a
        // valid ed25519 signature is necessary but NOT sufficient: without
        // this gate any quorum of capable validators could assemble a valid
        // v1, so two different capable coalitions could each land a response
        // (first-lands-wins, non-deterministic) and fulfilled_count (credited
        // to whoever signed) would diverge from missed_count (charged to the
        // hash-selected set on expiry). Filtering here makes fulfillment
        // deterministic and keeps the two stat columns symmetric. (request is
        // guaranteed non-null inside this !error block; a null lookup sets
        // 'no matching request' upstream and skips the loop.)
        // DECLARED, not buried: computeResponsibleSet takes the declared height and
        // buries it internally, so every site that computes this request's
        // responsible set (admission, the persisted RESPONSIBLE_SET_JSON, the expiry
        // missed_count charge, the fulfilled fee split, and here) resolves ONE set.
        //
        // WIDENED at the RESPONSE's own height (spec 8.2 liveness ladder). The set is
        // still RESOLVED at the declared height, so which validators are ranked is
        // unchanged; the ladder only decides how far down that ranking a signature is
        // admitted. Evaluating it at `atBlock` rather than at the declared height is what
        // makes the two sides agree: the signing hub derived its slots from the indexer tip it
        // polled, and a response cannot be mined below that tip, so this set is always a
        // SUPERSET of the one that signed and a signature authorized at proposal time can
        // never be rejected here. The same monotonicity argument is what lets the mirror
        // path pass its own applying block: that block's protocol time is at or past the
        // signed effective time, so it too is at or above the tip the hub used. The
        // flag-day itself is gated on the REQUEST's block, so a request admitted below it
        // never widens.
        let responseWiden = wid.widenSlots(
            atBlock, declaredBlock, request.deadline_block, network
        );
        let responsible = new Set(await computeResponsibleSet(
            requestId, request.redundancy, declaredBlock, request.provider_id, responseWiden
        ));
        verifiedSigs = verifiedSigs.filter(s => responsible.has(s.pubkey));
        validSigs    = verifiedSigs.length;

        // Quorum: only REDUNDANCY validators are responsible for fetching (spec §8.2)
        let redundancy = request ? Number(request.redundancy) : 0;
        if(validSigs < redundancy)
            error = 'invalid: insufficient valid signatures (' + validSigs + '/' + redundancy + ')';
    }

    return { ok: !error, error, verifiedSigs, validSigs, responseHash, canonical };
}

module.exports = {
    verifyAttestationResponse
};
