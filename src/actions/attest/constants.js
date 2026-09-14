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
 * XChain Indexer - ATTEST protocol constants
 *
 * The handler's constants, shared by index.js and every part file under
 * actions/attest/. They live apart from the parts so a part can read one without
 * requiring the entry back (a cycle), and index.js re-exports the three the rest of
 * the tree reads off the handler.
 *
 ********************************************************************/

'use strict';


// The chain every `attestation` capability stake lives on, and therefore the only
// chain whose heights can key a responsible set. Relay requests are materialized
// here (v3) and nowhere else.
const HOME_CHAIN = 'BTC';

// Chains a relay request may originate from. Deliberately not derived from the
// coin registry: a chain becomes relay-eligible by protocol decision, not by
// being configured, and BTC is excluded because it needs no relay.
const ALLOWED_ORIGIN_CHAINS = ['LTC', 'DOGE'];

// The rail the periodic response batch (v5/v6) rides. DOGE, for the reason every
// other bulk publish rail is DOGE: it is the cheap chain, and one batch per window
// costs a transaction whether or not the window carried rows. This is a chain
// DECISION, not a derivation from configuration, so it is written out here the way
// ALLOWED_ORIGIN_CHAINS is. A batch on any other chain is invalid.
const BATCH_CHAIN = 'DOGE';

// Marker appended to the verdict a COMPLETING v6 continuation stamps on a surviving
// v5 head (absorbCompletedBatch). It exists for the reorg reset in rollback.js and
// for nothing else.
//
// WHY A MARKER AND NOT A BLANKET RESTORE. The stamp is an in-place write on a row
// that landed in an EARLIER block, so a reorg taking the completing chunk deletes the
// chunk and cannot undo the stamp: the head stays terminal, drops out of
// getAttestBatchChunks (which reads status 'valid' only), and canonicalBatchHead then
// resolves NOTHING on replay, so the re-mined chunk rejoins a batch with no head and
// the window is dead on this node while a from-genesis replay has it live. The obvious
// remedy - reset every non-valid head joined to an orphaned chunk back to 'valid' - is
// UNSAFE: a head can be terminal because it was terminal AT WRITE TIME (a duplicate
// head for the publisher's window, a foreign NETWORK, a single-chunk head that failed
// its own quorum), and blanket-restoring those REVIVES a head that was never valid,
// handing one publisher two live heads for one window.
//
// A marker separates the two classes with no ambiguity at all: only the post-hoc stamp
// carries it, and a row carrying it was, by construction, 'valid' immediately before
// (the head reached absorbCompletedBatch only by coming back from the status='valid'
// chunk read). So the pre-flip status the reset restores is not a guess, it is the one
// value the flip could possibly have overwritten.
//
// It is a SUFFIX so the verdict itself stays first and stays readable: an operator (and
// every existing reader keyed on the reason's leading text) still sees why the batch
// failed. Keep it byte-identical to the copy in rollback.js; a test pins the pair.
// It must contain no SQL LIKE wildcard ('%' or '_'), because the reset matches on it.
const ATTEST_BATCH_COMPLETION_STAMP = ' (stamped on batch completion)';

// Decoded-body ceiling for a mirror-applied response, the byte-twin of the hub's
// ATTEST_RESPONSE_BODY_MAX_BYTES (xchain-hub/src/attestation/attest_response_body_cap.js),
// which the leader enforces before proposing and every follower before signing.
// The applier re-checks it so a DISHONEST quorum cannot push through a body the
// periodic on-chain batch could never carry: v3/v4 relay legs stay on chain at the
// encoder's 8189-byte wire ceiling, so a larger body would finalize and then be
// un-relayable and un-reconstructible. Skipping such a row is deterministic (same
// row, same arithmetic on every node), so it is inert rather than a fork.
const ATTEST_RESPONSE_BODY_MAX_BYTES = 8189;

// Deterministic per-block ceiling on the hub-mirror response applier, the sibling of
// ATTEST_MAX_EXPIRIES_PER_BLOCK and XCALL_MAX_CALLS_PER_BLOCK and hashed state for the
// same reason they are: each apply synthesizes an ATTEST v1 action and injects a contract
// callback, so an uncapped pass makes a block's processing time and its action rows a
// function of how many responses happened to become effective at once. That number is not
// hypothetical here: effective_time is the round leader's `now + ATTEST_RESPONSE_FORWARD_S`,
// so requests finalized in the same span align on a handful of blocks by construction.
//
// TEN, which is the admission cap's own perBlock figure (attest_request_cap_activation.js):
// the chain admits at most ten requests per block, so a steady state cannot produce more
// than ten responses per block either, and a ceiling at that number bounds the callback
// cost of a block without ever throttling the rate the protocol itself allows. A burst that
// aligned several blocks' worth of requests on one effective time drains at the admission
// rate instead of firing in one block transaction.
//
// CARRY-FORWARD, and why it stores nothing: a deferred row is simply still applicable at
// B+1. Its effective_time is already passed, the deadline test is re-evaluated there, and
// its request is still pending, so the next block's pass selects it again in the same total
// order and takes the next prefix. A row whose deadline passes while it waits is never
// applied at all: the expiry sweep at deadline+1 flips the request and the expired callback
// stands, which is the binding rule's existing verdict rather than a new one.
//
// UNGATED, deliberately: below the response-mirror activation height nothing reaches this
// path at all (the applier gates on the request's own era), so there is no pre-activation
// history for a flag day to preserve and a gate would only be a second thing to arm.
//
// The cap is APPLIED in utility.selectApplicableAttestationResponses, where the total order
// it takes a prefix of is built; it lives here, with the rest of the ATTEST protocol
// constants, exactly as xcall.js holds the cap utility applies to its own pass.
const ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK = 10;

// Terminal response vocabulary the mirror carries. In practice the hub emits only
// 'ok' ('expired' is an INDEXER verdict from the local deadline sweep, which needs no
// mirror row), but the column keeps the wider vocabulary so an 'expired' producer
// could be added without a schema change, and the applier handles both.
const MIRROR_TERMINAL_STATUSES = ['ok', 'expired'];

// request_id preimage fields, in preimage order. This list is the single in-file
// source of truth for the ORDER and the COUNT, so a skew against the VM's
// derivation is one visible edit rather than a miscounted string concatenation.
// Exported and pinned against the canonical xchain-vm GOLDEN_VECTORS.requestId
// tuple by bin/check-preimage-golden-parity.js, the same way xcall.js pins
// CALL_ID_PREIMAGE_FIELDS; before this list existed a request_id field skew
// surfaced only as an opaque hash difference in a unit suite.
const REQUEST_ID_PREIMAGE_FIELDS = [
    'TX_HASH', 'ROOT_ACTION_INDEX', 'EMITTER_PATH', 'CONTRACT_INDEX', 'EMITTER_POSITION'
];

module.exports = {
    HOME_CHAIN,
    ALLOWED_ORIGIN_CHAINS,
    BATCH_CHAIN,
    ATTEST_BATCH_COMPLETION_STAMP,
    ATTEST_RESPONSE_BODY_MAX_BYTES,
    ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK,
    MIRROR_TERMINAL_STATUSES,
    REQUEST_ID_PREIMAGE_FIELDS,
};
