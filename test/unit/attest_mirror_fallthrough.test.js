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
// THE APPLIER FALL-THROUGH (zero-confirmation-flip spec §5, D11 and D34-D38, D89).
//
// Before the zero-conf height the applier picked ONE mirror row per request and, if
// that row failed verification, wrote nothing and re-picked the same inert row at
// every block until the deadline: a request with a perfectly good second row (a round
// that finalized twice under two leader slots) stranded. Above the height the selector
// carries the whole sorted candidate list inside the one item it still returns, and
// the pass tries the candidates in order until one binds.
//
// What is asserted here, and nowhere else:
//   * the candidate list exists ONLY above the height, is sorted by the signed
//     (effective_time, response_hash), and its head is the row the old rule chose;
//   * below the height the item is the old single-choice object, with no candidates
//     key, so a mixed fleet cannot fork on a request below the flag day;
//   * the pass dispatches a request AT MOST ONCE (hostile F1: the handler re-gates on
//     an in-memory MIRROR_REQUEST snapshot, so a second dispatch would bind twice) and
//     STOPS at the first candidate that binds;
//   * an all-inert request writes nothing and is selected again, unchanged, next block.
//
// The handler itself is stubbed at actions.processAction. The bind signal it owns is
// data['STATUS'] === 'valid' (attest.js:903, set only after the row verified), so the
// stub sets exactly that key and nothing else: a test that asserted on a log string
// would pass against a loop that never read the verdict at all.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');

const Utility = require('../../src/utility.js');
const arm     = require('../../src/attest_response_mirror_activation.js');
const zc      = require('../../src/attest_zero_conf_activation.js');

const REQ_ID   = 'd'.repeat(64);
const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);
const BODY     = 'hello';

// regtest is armed at genesis, so a regtest request is above the height at any block.
const REQ_BLOCK   = 90;
const DEADLINE    = 200;
const BLOCK       = 100;
const BLOCK_TIME  = 1700000000;
const EFFECTIVE_T = BLOCK_TIME;

// The below-height venue: testnet has the MIRROR armed at 151324 and zero-conf still
// null, which is the only combination that reaches the old single-candidate path with
// the mirror-era gate satisfied. Asserted as a fixture assumption below, because if the
// operator arms testnet these cases would silently stop testing the below-height shape.
const T_REQ_BLOCK = 151400;
const T_DEADLINE  = 151500;
const T_BLOCK     = 151410;

function mirrorRow(overrides = {}) {
    return {
        request_id:       REQ_ID,
        provider_id:      'http_get',
        status:           'ok',
        response_payload: BODY,
        response_hash:    crypto.createHash('sha256').update(Buffer.from(BODY, 'utf8')).digest('hex'),
        meta:             'm',
        effective_time:   EFFECTIVE_T,
        signer_pubkeys:   JSON.stringify([PUBKEY_A]),
        signatures:       JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        widen:            0,
        ...overrides,
    };
}

function requestRow(overrides = {}) {
    return {
        request_id:           REQ_ID,
        action_index:         11,
        provider_id:          'http_get',
        request_status:       'pending',
        deadline_block:       DEADLINE,
        block_index:          REQ_BLOCK,
        redundancy:           1,
        contract_index:       5,
        callback_method:      'onResult',
        callback_params_json: '[]',
        fee_payer:            'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        ...overrides,
    };
}

// A db double for processAttestationResponses: one page of local requests, one mirror
// read. Deliberately not sinon, so the call counts below are counted by this file.
function fakeDb(network, requests, mirrored) {
    const calls = { requestPages: 0, mirrorReads: 0 };
    return {
        calls,
        config: { NETWORK: network },
        async getAttestationRequestsAwaitingMirrorResponse() {
            calls.requestPages++;
            return calls.requestPages === 1 ? requests : [];
        },
        async getMirroredAttestationResponses() {
            calls.mirrorReads++;
            return mirrored;
        },
    };
}

// Records every dispatch and lets a case decide which candidate binds, by
// response_hash. `bindHashes` empty means every candidate is inert.
function applierSpy(bindHashes = []) {
    const seen = [];
    const bind = new Set(bindHashes);
    return {
        seen,
        async processAction(action, params, data) {
            seen.push({
                action,
                params,
                requestId: data['REQUEST_ID'],
                hash:      data['MIRROR_RESPONSE'].response_hash,
                data,
            });
            // The one thing the real handler does that this loop reads.
            if (bind.has(data['MIRROR_RESPONSE'].response_hash)) data['STATUS'] = 'valid';
        },
    };
}

describe('ATTEST applier fall-through above the zero-conf height @regression @tier3', function () {

    let util;
    beforeEach(function () { util = new Utility(); });

    // ------------------------------------------------------------------ the selector

    describe('selector candidate list (utility.selectApplicableAttestationResponses)', function () {

        it('carries every eligible row for one request, sorted, as ONE item', function () {
            // Three rows for one request, inserted in an order that disagrees with both
            // sort keys, so nothing but the sort can produce the expected sequence.
            const late = mirrorRow({ effective_time: EFFECTIVE_T + 5, response_hash: 'a'.repeat(64) });
            const tieB = mirrorRow({ effective_time: EFFECTIVE_T,     response_hash: 'b'.repeat(64) });
            const tieA = mirrorRow({ effective_time: EFFECTIVE_T,     response_hash: 'a'.repeat(64) });

            const applied = util.selectApplicableAttestationResponses(
                [late, tieB, tieA], [requestRow()], BLOCK, EFFECTIVE_T + 10, 'regtest');

            assert.strictEqual(applied.length, 1,
                'the cap counts REQUESTS (D34): three rows for one request are still one item');
            assert.deepStrictEqual(
                applied[0].candidates.map(c => [c.effective_time, c.response_hash]),
                [[EFFECTIVE_T, 'a'.repeat(64)], [EFFECTIVE_T, 'b'.repeat(64)], [EFFECTIVE_T + 5, 'a'.repeat(64)]],
                'candidates sort (effective_time ASC, response_hash ASC), which is the read\'s only order (D35)');
            assert.strictEqual(applied[0].response, applied[0].candidates[0],
                'the head of the list is the row that binds first, and it is the same object');
            assert.strictEqual(applied[0].response.response_hash, 'a'.repeat(64),
                'the head is exactly what the old single-choice tie-break picked');
            assert.strictEqual(applied[0].request.action_index, 11,
                'the LOCAL request row is still carried through unchanged');
        });

        it('excludes a row whose effective_time has not been reached from the list at all', function () {
            const now   = mirrorRow({ response_hash: 'b'.repeat(64) });
            const later = mirrorRow({ effective_time: EFFECTIVE_T + 1, response_hash: 'a'.repeat(64) });
            const applied = util.selectApplicableAttestationResponses(
                [later, now], [requestRow()], BLOCK, EFFECTIVE_T, 'regtest');
            assert.deepStrictEqual(applied[0].candidates.map(c => c.response_hash), ['b'.repeat(64)],
                'a candidate is a row that BINDS at this block; a future stamp is not one yet');
        });

        it('gives each request its own list, in the (block_index, action_index) order', function () {
            const earlyId = 'f'.repeat(64);
            const lateId  = '0'.repeat(64);
            const requests = [
                requestRow({ request_id: lateId,  block_index: 95, action_index: 20 }),
                requestRow({ request_id: earlyId, block_index: 90, action_index: 10 }),
            ];
            const rows = [
                mirrorRow({ request_id: lateId,  response_hash: 'c'.repeat(64) }),
                mirrorRow({ request_id: earlyId, response_hash: 'e'.repeat(64) }),
                mirrorRow({ request_id: earlyId, response_hash: 'd'.repeat(64) }),
            ];
            const applied = util.selectApplicableAttestationResponses(
                rows, requests, BLOCK, EFFECTIVE_T, 'regtest');
            assert.deepStrictEqual(applied.map(a => a.response.request_id), [earlyId, lateId],
                'the item order is unchanged by the candidate lists');
            assert.deepStrictEqual(applied[0].candidates.map(c => c.response_hash),
                ['d'.repeat(64), 'e'.repeat(64)]);
            assert.deepStrictEqual(applied[1].candidates.map(c => c.response_hash), ['c'.repeat(64)]);
        });

        it('BELOW the height returns the old single-choice item with no candidates key', function () {
            assert.strictEqual(arm.isResponseMirrorActive(T_REQ_BLOCK, 'testnet'), true,
                'fixture assumption: the mirror is armed on testnet at this block');
            assert.strictEqual(zc.isZeroConfActive(T_REQ_BLOCK, 'testnet'), false,
                'fixture assumption: zero-conf is NOT armed on testnet, so this is the below-height path');

            const lo = mirrorRow({ effective_time: EFFECTIVE_T,     response_hash: 'b'.repeat(64) });
            const hi = mirrorRow({ effective_time: EFFECTIVE_T + 1, response_hash: 'a'.repeat(64) });
            const request = requestRow({ block_index: T_REQ_BLOCK, deadline_block: T_DEADLINE });
            const applied = util.selectApplicableAttestationResponses(
                [hi, lo], [request], T_BLOCK, EFFECTIVE_T + 10, 'testnet');

            assert.strictEqual(applied.length, 1);
            assert.strictEqual(applied[0].candidates, undefined,
                'a below-height item must carry no candidates key: the fall-through is gated on the height (D11)');
            assert.deepStrictEqual(Object.keys(applied[0]).sort(), ['request', 'response'],
                'the below-height item shape is byte-for-byte the old one');
            assert.strictEqual(applied[0].response, lo,
                'and the choice is the old rule\'s: the smaller signed effective_time');
        });
    });

    // ---------------------------------------------------------------- the applier pass

    describe('the pass tries candidates in order (utility.processAttestationResponses)', function () {

        // Three candidates for one request, hashes chosen so the sort order is a<b<c.
        function threeCandidates() {
            return [
                mirrorRow({ response_hash: 'c'.repeat(64) }),
                mirrorRow({ response_hash: 'a'.repeat(64) }),
                mirrorRow({ response_hash: 'b'.repeat(64) }),
            ];
        }

        it('stops at the first candidate that binds and never dispatches again for that request', async function () {
            const spy = applierSpy(['b'.repeat(64)]);   // the SECOND candidate binds
            const db  = fakeDb('regtest', [requestRow()], threeCandidates());

            await util.processAttestationResponses(spy, db, BLOCK, BLOCK_TIME);

            assert.deepStrictEqual(spy.seen.map(s => s.hash), ['a'.repeat(64), 'b'.repeat(64)],
                'the inert head is tried, then the next candidate, and the third is never reached');
            assert.strictEqual(spy.seen.length, 2,
                'the loop must break on the bind: a third dispatch would bind a second time (hostile F1)');
            assert.ok(spy.seen.every(s => s.action === 'ATTEST' && s.params[0] === 1),
                'every attempt is still a synthetic ATTEST v1');
            assert.ok(spy.seen.every(s => s.requestId === REQ_ID));
        });

        it('dispatches exactly once when the head binds', async function () {
            const spy = applierSpy(['a'.repeat(64)]);
            const db  = fakeDb('regtest', [requestRow()], threeCandidates());
            await util.processAttestationResponses(spy, db, BLOCK, BLOCK_TIME);
            assert.deepStrictEqual(spy.seen.map(s => s.hash), ['a'.repeat(64)],
                'a request that binds on its first candidate costs exactly one dispatch, as it does today');
        });

        it('hands each candidate a FRESH data object carrying that candidate\'s row', async function () {
            const spy = applierSpy(['b'.repeat(64)]);
            const db  = fakeDb('regtest', [requestRow()], threeCandidates());
            await util.processAttestationResponses(spy, db, BLOCK, BLOCK_TIME);

            assert.notStrictEqual(spy.seen[0].data, spy.seen[1].data,
                'a shared data object would carry a skipped attempt\'s leftovers into the next one');
            assert.strictEqual(spy.seen[0].data['STATUS'], undefined,
                'the skipped attempt is inert: the handler never set a status on it');
            assert.strictEqual(spy.seen[1].data['STATUS'], 'valid');
            for (const s of spy.seen) {
                assert.strictEqual(s.data['MIRROR_RESPONSE'].response_hash, s.hash,
                    'each attempt carries its OWN mirror row');
                assert.strictEqual(s.data['MIRROR_REQUEST'].request_id, REQ_ID);
                assert.strictEqual(s.data['TX_INDEX'], null);
                assert.strictEqual(s.data['TX_VOUT'], null);
                assert.strictEqual(s.data['IS_SYNTHETIC'], true);
                assert.strictEqual(s.data['BLOCK_TIME'], BLOCK_TIME);
                assert.strictEqual(s.data['BLOCK_INDEX'], BLOCK);
            }
        });

        it('tries EVERY candidate when none binds, and the request is selected again unchanged next block', async function () {
            const spy = applierSpy([]);                 // every row inert
            const rows = threeCandidates();
            const db   = fakeDb('regtest', [requestRow()], rows);

            await util.processAttestationResponses(spy, db, BLOCK, BLOCK_TIME);
            assert.deepStrictEqual(spy.seen.map(s => s.hash),
                ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
                'with no bind the whole list is tried, in order');
            assert.ok(spy.seen.every(s => s.data['STATUS'] === undefined),
                'an all-inert request wrote nothing: no attempt was ever marked valid');

            // The request is still pending (nothing was written), so the next block's
            // selection over the same inputs is identical. This is the carry-forward rule:
            // there is no stored state between the two calls.
            const again = util.selectApplicableAttestationResponses(
                rows, [requestRow()], BLOCK + 1, BLOCK_TIME, 'regtest');
            assert.strictEqual(again.length, 1);
            assert.deepStrictEqual(again[0].candidates.map(c => c.response_hash),
                ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
                'the next block sees the same request with the same candidate list, in the same order');
            assert.strictEqual(again[0].response.response_hash, 'a'.repeat(64));
        });

        it('BELOW the height dispatches the single choice once, whatever else the mirror holds', async function () {
            const spy = applierSpy([]);                 // inert, so a fall-through would show
            const lo  = mirrorRow({ effective_time: EFFECTIVE_T,     response_hash: 'b'.repeat(64) });
            const hi  = mirrorRow({ effective_time: EFFECTIVE_T + 1, response_hash: 'a'.repeat(64) });
            const db  = fakeDb('testnet',
                [requestRow({ block_index: T_REQ_BLOCK, deadline_block: T_DEADLINE })], [hi, lo]);

            await util.processAttestationResponses(spy, db, T_BLOCK, EFFECTIVE_T + 10);

            assert.deepStrictEqual(spy.seen.map(s => s.hash), ['b'.repeat(64)],
                'below the height an inert row strands the request exactly as it does today: one dispatch, no fall-through');
        });
    });
});
