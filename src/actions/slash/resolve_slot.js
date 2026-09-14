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
 * SLASH slot resolution: recovering WHICH protocol slot a proof is about.
 *
 * The EQUIV header names the engine, the round and the view, but not the block
 * whose locked signer set governs them. Every engine answers that question from
 * its own canonical layout: most carry the height in-content at a fixed field
 * index, XORACLE keys it on the round id, XORACLEB on the first segment of a
 * composite round id, and XATTEST has to read it back off the mirrored request
 * row. They live here, one function per engine, because the handler only ever
 * needs the answer and each layout is its own body of rules about when two
 * messages are really one slot.
 *
 ********************************************************************/

const eq = require('../../equivocation_header.js');
const { parseOracleContent, parseBatchContent } = require('./content_parsers.js');


// In-content snapshot_block field index per engine (raw canonical layout).
const FIELD = {
    [eq.ENGINE_TAGS.DEX]:        2,   // XMATCH|match_id|snapshot_block|...
    [eq.ENGINE_TAGS.XCALL]:      3,   // XCALL|DISPATCH|call_id|snapshot_block|...  (RESULT: same index)
    [eq.ENGINE_TAGS.CHECKPOINT]: 9,   // XCHECKPOINT|chain|network|block_index|block_hash|ledger|actions|contract|checkpoint_seq|snapshot_block[|batch_seq..]
    // The bridge pair. WITHOUT these two rows the ENGINE_CAPABILITY entries above are
    // inert: a well-formed bridge equivocation proof maps to cross_chain, then falls
    // through to 'invalid: ENGINE_TAG (no snapshot_block rule)' and burns nothing,
    // which is the one outcome "a bridge forgery directs value, so it must be
    // slashable" was meant to rule out. Each carries the height in-content at index 2
    // and each is a SINGLE content family, so neither needs the family discriminator
    // the CHECKPOINT and ATTEST legs below carry.
    [eq.ENGINE_TAGS.BRIDGE]:     2,   // XBRIDGE|transfer_id|snapshot_block|tick|...
    [eq.ENGINE_TAGS.POLICY]:     2,   // XPOLICY|snapshot_id|snapshot_block|origin_chain|...
    [eq.ENGINE_TAGS.CONFIG]:     0,   // XCONFIG content = snapshot_block|config_digest (block carried in-content so config equivocation is slashable)
};

// The field-indexed engines: the height rides the signed content itself, so the
// pair is judged on one field of each canonical. Returns null when this engine
// does not carry its block that way.
function resolveFieldSlot(util, engineTag, contentA, contentB){
    if(FIELD[engineTag] !== undefined){
        let i  = FIELD[engineTag];
        // The CHECKPOINT engine tag carries TWO content families: the checkpoint
        // root canonical (XCHECKPOINT|...) and the reward-attestation canonical
        // (XANCPUB|scope|seq|snapshot_block|publisher|amount, both the per-chain and
        // archive legs; see anchor.js rewardCanonical). Dispatch the field index on the
        // content's leading token; both messages must agree on the family (a matched
        // field across DIFFERENT layouts proves nothing about a shared slot).
        if(engineTag === eq.ENGINE_TAGS.CHECKPOINT){
            let famA = contentA.split('|', 1)[0];
            let famB = contentB.split('|', 1)[0];
            if(famA !== famB)
                return { error: 'invalid: CHECKPOINT content family mismatch' };
            if(famA === 'XANCPUB') i = 3;
        }
        let fa = contentA.split('|')[i];
        let fb = contentB.split('|')[i];
        if(util.isNull(fa) || fa !== fb || !/^[0-9]+$/.test(String(fa)))
            return { error: 'invalid: snapshot_block (mismatch or format)' };
        return { snapshotBlock: Number(fa) };
    }
    return null;
}

// XORACLE: the ROUND_ID IS the BTC block. Returns null for any other engine.
function resolveOracleSlot(engineTag, roundId, contentA, contentB, oracleRoundGate){
    // XORACLE: the ROUND_ID IS the BTC block.
    if(engineTag === eq.ENGINE_TAGS.ORACLE){
        if(!/^[0-9]+$/.test(String(roundId)))
            return { error: 'invalid: ORACLE round (not a block)' };
        // The BTC height alone does NOT name the slot. Oracle rounds
        // advance on wall-clock (hub oracle/round.js), so a run of rounds can capture
        // the SAME BTC tip; ed25519.buildPriceV0Payload keys the EQUIV header on that
        // height with VIEW=0 and leaves the round counter inside the signed JSON. Two
        // honest, distinct rounds at one tip therefore share the header prefix and
        // differ in content, which reads here as equivocation and burns the whole bond
        // of a validator that did nothing wrong. Discriminate on the in-content round:
        // different rounds are different messages, not two versions of one.
        //
        // Only pairs where BOTH contents declare a round are judged. A content with no
        // `round` cannot have come from buildPriceV0Payload, the one producer of an
        // ORACLE-tagged canonical, and refusing to resolve those would widen the
        // rejection surface past the bug (the fail-open leg is unreachable for a real
        // proof: both signatures verify against the offender's own key). The
        // btc_block_height cross-check runs on the same terms.
        if(oracleRoundGate){
            let pa = parseOracleContent(contentA);
            let pb = parseOracleContent(contentB);
            if(pa !== null && pb !== null){
                if(pa.round !== null && pb.round !== null && pa.round !== pb.round)
                    return { error: 'invalid: ORACLE round mismatch (distinct rounds, not equivocation)' };
                if((pa.height !== null && pa.height !== Number(roundId)) ||
                   (pb.height !== null && pb.height !== Number(roundId)))
                    return { error: 'invalid: ORACLE btc_block_height (does not match ROUND_ID)' };
            }
        }
        return { snapshotBlock: Number(roundId) };
    }
    return null;
}

// XORACLEB (PRICE batches): the block is the first segment of a composite round
// id. Returns null for any other engine.
function resolveBatchSlot(engineTag, roundId, contentA, contentB){
    // XORACLEB (PRICE batches): the ROUND_ID is the COMPOSITE
    // `<anchor>|<first_round>|<last_round>`, so the BTC anchor is its first segment.
    if(engineTag === eq.ENGINE_TAGS.ORACLE_BATCH){
        // The round id legitimately contains '|' and equivKey treats it as opaque, so
        // it is parsed HERE and never by field-splitting the whole key (the checkpoint
        // round id `chain|network|block_index|checkpoint_seq` has the same property).
        // parse() already peeled ENGINE_TAG and VIEW off the ends, so exactly three
        // integer segments must remain; anything else does not name a batch slot.
        let seg = String(roundId).split('|');
        if(seg.length !== 3 || !seg.every(s => /^[0-9]+$/.test(s)))
            return { error: 'invalid: ORACLE_BATCH round id (format)' };
        let anchor = Number(seg[0]), first = Number(seg[1]), last = Number(seg[2]);
        if(first > last)
            return { error: 'invalid: ORACLE_BATCH window (first_round > last_round)' };

        // A batch is named by (anchor, window), and the spec explicitly permits two
        // leaders to split ONE window differently at one anchor. Two batches over
        // different sub-ranges are therefore two messages, not two versions of one, and
        // pairing them would burn an honest bond. Discriminate on the in-content window
        // the way the XORACLE leg above discriminates on `round`, each end independently
        // so a half-declared window still narrows the pair.
        //
        // Ungated, unlike SLASH_ORACLE_ROUND_DISCRIMINATED: that gate exists only because
        // XORACLE has pre-fix verdicts it must keep reproducing. XORACLEB is a new tag
        // whose first acceptance is this branch (the XCONFIG precedent), so there is no
        // earlier verdict to stay identical with, and no window in which an honest split
        // would burn a bond.
        let pa = parseBatchContent(contentA);
        let pb = parseBatchContent(contentB);
        if(pa !== null && pb !== null){
            if((pa.first !== null && pb.first !== null && pa.first !== pb.first) ||
               (pa.last  !== null && pb.last  !== null && pa.last  !== pb.last))
                return { error: 'invalid: ORACLE_BATCH window mismatch (distinct windows, not equivocation)' };
            // The anchor is what membership resolves at, so a content naming a different
            // one is not evidence about this slot. The WINDOW is deliberately not
            // cross-checked against the header: it is offender-attested there, and a pair
            // whose contents agree with each other but not with the header is still two
            // conflicting signatures under one key, which is equivocation.
            if((pa.height !== null && pa.height !== anchor) ||
               (pb.height !== null && pb.height !== anchor))
                return { error: 'invalid: ORACLE_BATCH btc_block_height (does not match ROUND_ID)' };
        }
        return { snapshotBlock: anchor };
    }
    return null;
}

// XATTEST: nothing in the canonical carries the block, so it is read back off
// indexed state. Returns null for any other engine.
async function resolveAttestSlot(util, indexerDb, engineTag, roundId, contentA, contentB){
    // XATTEST: the canonical is delimiter-less and carries no block. Recover it from
    // the mirrored request row keyed by the ROUND_ID (= request_id). Deterministic
    // (the request is indexed state present on every BTC indexer).
    if(engineTag === eq.ENGINE_TAGS.ATTEST){
        // XATTEST carries TWO families (base v1 and relay). The relay legs are shaped
        // like XCALL: pipe-delimited, snapshot_block at index 3, hashed ROUND_ID, and
        // locked under `cross_chain` (attest.js verifyRelayQuorum). The base v1
        // canonical is delimiter-less and starts with the request_id, so its first
        // '|' segment can never be the literal 'ATTEST'. Both messages must agree on
        // the family: a matched field across DIFFERENT layouts proves nothing about a
        // shared slot.
        let pa = contentA.split('|'), pb = contentB.split('|');
        let relayA = pa[0] === 'ATTEST' && (pa[1] === 'RELAY_REQUEST' || pa[1] === 'RELAY_RESPONSE');
        let relayB = pb[0] === 'ATTEST' && (pb[1] === 'RELAY_REQUEST' || pb[1] === 'RELAY_RESPONSE');
        if(relayA !== relayB)
            return { error: 'invalid: ATTEST content family mismatch' };
        if(relayA){
            if(pa[1] !== pb[1])
                return { error: 'invalid: ATTEST relay phase mismatch' };
            let fa = pa[3], fb = pb[3];
            if(util.isNull(fa) || fa !== fb || !/^[0-9]+$/.test(String(fa)))
                return { error: 'invalid: snapshot_block (mismatch or format)' };
            return { snapshotBlock: Number(fa), capability: 'cross_chain' };
        }
        let request = await indexerDb.getAttestationRequestById(String(roundId).toLowerCase());
        if(!request || request.block_index == null)
            return { error: 'invalid: ATTEST request unknown (cannot resolve snapshot_block)' };
        return { snapshotBlock: Number(request.block_index) };
    }
    return null;
}

// Recover the slot's snapshot_block from the proof, deterministically per engine.
// The two CONTENT strings (header already stripped) must agree on the block where
// it is carried in-content; for engines that don't carry it, derive from the round.
// `deps` carries the handler state these layouts need: util for isNull, indexerDb
// for the XATTEST request read.
async function resolveSlot(deps, engineTag, roundId, contentA, contentB, oracleRoundGate){
    return resolveFieldSlot(deps.util, engineTag, contentA, contentB)
        || resolveOracleSlot(engineTag, roundId, contentA, contentB, oracleRoundGate)
        || resolveBatchSlot(engineTag, roundId, contentA, contentB)
        || await resolveAttestSlot(deps.util, deps.indexerDb, engineTag, roundId, contentA, contentB)
        || { error: 'invalid: ENGINE_TAG (no snapshot_block rule)' };
}

module.exports = { resolveSlot, resolveFieldSlot, resolveOracleSlot, resolveBatchSlot, resolveAttestSlot };
