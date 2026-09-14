// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// THE HUB-MIRROR ATTEST RESPONSE APPLIER (mirrored responses bound at a block).
//
// Two units, deliberately tested apart:
//   utility.selectApplicableAttestationResponses  the BINDING RULE. Which mirrored
//       responses bind at block B, and in what order. Pure, so the block a callback
//       fires at is asserted directly rather than inferred from side effects.
//   attest.js applyMirroredResponse               the EFFECTS. The synthesized v1
//       action (NULL tx_index, deterministic hash), the response row, the terminal
//       flip, the fee settle and the contract callback - and, on a verification
//       failure, the absence of every one of them.
//
// Signature verification itself is stubbed at ed25519.verify, exactly as
// attest.test.js does it: the canonical bytes are the shared verifier's contract
// (attest_response_verify_vectors.test.js pins them), while what THIS row owes is
// that a verdict of 'no' leaves the request untouched and a verdict of 'yes'
// produces the v1 effects.
//
// The suite is split by behaviour into consecutive sibling blocks under this one
// title, sharing the mirror and request rows in
// attest_response_applier.test/helpers/rows.js. This file holds the §4.1 binding
// rule; attest_response_applier.test/ holds the per-block cap
// (per_block_cap.test.js), the applier pass wiring (applier_pass.test.js), the
// bounded applicability read (bounded_read.test.js) and the §4.4 effects
// (effects_apply.test.js, effects_regate_settle.test.js, over
// helpers/effects_fixture.js).

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const Utility  = require('../../../src/utility.js');
const arm     = require('../../../src/attest_response_mirror_activation.js');

const { REQ_ID, REQ_BLOCK, DEADLINE, EFFECTIVE_T, mirrorRow, requestRow } = require('./attest_response_applier.test/helpers/rows.js');

// Consecutive sibling blocks under the one suite title, so every full test title
// is the one the suite has always reported.

// The binding-rule cases' Utility, rebuilt by each block's beforeEach, and the
// selector call they all make through it.
let util;

function select(blockIndex, blockTime, rows = [mirrorRow()], requests = [requestRow()]) {
    return util.selectApplicableAttestationResponses(rows, requests, blockIndex, blockTime, 'regtest');
}

// ---------------------------------------------------------------- binding rule
describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    describe('§4.1 binding rule (utility.selectApplicableAttestationResponses)', function () {
        beforeEach(function () { util = new Utility(); });

        it('binds at the predicted block, and NOT one block earlier', function () {
            // One second short of the signed effective_time: the row exists, the request
            // is pending, the deadline is far away, and it still must not bind. This is
            // the whole determinism argument: the applying block is a function of the
            // SIGNED stamp against protocol time, so a node that has the row early may
            // not act on it early.
            assert.strictEqual(select(100, EFFECTIVE_T - 1).length, 0,
                'a row must not bind at a block whose protocol time is below its signed effective_time');
            const applied = select(100, EFFECTIVE_T);
            assert.strictEqual(applied.length, 1, 'it binds at the first block that reaches the effective_time');
            assert.strictEqual(applied[0].response.request_id, REQ_ID);
            assert.strictEqual(applied[0].request.action_index, 11, 'the LOCAL request row is carried through');
        });

        it('binds at a block satisfied exactly AT the deadline block (AT3, second half)', function () {
            const applied = select(DEADLINE, EFFECTIVE_T);
            assert.strictEqual(applied.length, 1,
                'B == deadline_block satisfies B <= deadline_block; the expiry sweep only fires at deadline+1');
        });

        it('never binds a row whose first satisfying block is past the deadline (AT3, first half)', function () {
            // The row became satisfiable only after the deadline passed, so no block
            // ever satisfies both halves of the predicate: the request expires and the
            // expired callback stands.
            assert.strictEqual(select(DEADLINE + 1, EFFECTIVE_T).length, 0,
                'B > deadline_block must never bind, whatever the effective_time');
            assert.strictEqual(
                select(DEADLINE + 1, EFFECTIVE_T, [mirrorRow({ effective_time: EFFECTIVE_T + 5000 })]).length, 0);
        });

        it('skips a row whose local request is absent, already terminal, or legacy-era', function () {
            assert.strictEqual(select(100, EFFECTIVE_T, [mirrorRow()], []).length, 0,
                'no local request row (reorged away) means an inert mirror row');
            assert.strictEqual(
                select(100, EFFECTIVE_T, [mirrorRow()], [requestRow({ request_status: 'fulfilled' })]).length, 0,
                'an already-terminal request is never re-bound');
            // The flag day is keyed on the REQUEST's block. regtest is armed at genesis,
            // so drive the OFF side through the network the constant leaves unarmed.
            assert.strictEqual(arm.isResponseMirrorActive(REQ_BLOCK, 'testnet'), false,
                'fixture assumption: testnet is the unarmed network in the activation map');
            assert.strictEqual(
                util.selectApplicableAttestationResponses([mirrorRow()], [requestRow()], 100, EFFECTIVE_T, 'testnet').length, 0,
                'below the activation height the response must arrive on chain, not through the mirror');
        });
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    describe('§4.1 binding rule (utility.selectApplicableAttestationResponses)', function () {
        beforeEach(function () { util = new Utility(); });

        it('applies two rows in one block in (request block_index, action_index) order, whatever the insertion order', function () {
            // Ordering is read from the LOCAL request rows. The ids are chosen so that a
            // request_id collation ORDER (a known ordering trap) and the insertion order
            // both disagree with the correct one.
            const earlyId = 'f'.repeat(64);   // request block 90, action 10  -> applies FIRST
            const lateId  = '0'.repeat(64);   // request block 95, action 20  -> applies SECOND
            const requests = [
                requestRow({ request_id: lateId,  block_index: 95, action_index: 20 }),
                requestRow({ request_id: earlyId, block_index: 90, action_index: 10 }),
            ];
            const rows = [
                mirrorRow({ request_id: lateId }),
                mirrorRow({ request_id: earlyId }),
            ];
            const applied = select(100, EFFECTIVE_T, rows, requests);
            assert.deepStrictEqual(applied.map(a => a.response.request_id), [earlyId, lateId],
                'order must be the local requests\' (block_index, action_index), not the mirror order and not the id collation');
            // And the reverse insertion order produces the identical sequence.
            const reversed = select(100, EFFECTIVE_T, rows.slice().reverse(), requests.slice().reverse());
            assert.deepStrictEqual(reversed.map(a => a.response.request_id), [earlyId, lateId]);
        });

        it('a double-finalize binds the smaller effective_time, ties by response_hash', function () {
            const lo = mirrorRow({ effective_time: EFFECTIVE_T,     response_hash: 'b'.repeat(64) });
            const hi = mirrorRow({ effective_time: EFFECTIVE_T + 1, response_hash: 'a'.repeat(64) });
            let applied = select(100, EFFECTIVE_T + 10, [hi, lo]);
            assert.strictEqual(applied.length, 1, 'one request applies at most one response');
            assert.strictEqual(applied[0].response.effective_time, EFFECTIVE_T);
            // Equal stamps fall through to the signed response_hash, so every node picks
            // the same one no matter which arrived first.
            const tieA = mirrorRow({ response_hash: 'a'.repeat(64) });
            const tieB = mirrorRow({ response_hash: 'b'.repeat(64) });
            assert.strictEqual(select(100, EFFECTIVE_T, [tieB, tieA])[0].response.response_hash, 'a'.repeat(64));
            assert.strictEqual(select(100, EFFECTIVE_T, [tieA, tieB])[0].response.response_hash, 'a'.repeat(64));
        });
    });
});
