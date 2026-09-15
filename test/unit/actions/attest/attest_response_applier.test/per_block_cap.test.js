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
// THE HUB-MIRROR ATTEST RESPONSE APPLIER, the per-block cap on mirror applies
// (ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK) and its stateless carry to the next block.
//
// The two units under test, why signature verification is stubbed, and the
// shared rows (./helpers/rows.js) are described in ../attest_response_applier.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');

const Utility  = require('../../../../../src/utility.js');

const { REQ_BLOCK, DEADLINE, EFFECTIVE_T, mirrorRow, requestRow } = require('./helpers/rows.js');

// Consecutive sibling blocks under the one suite title, so every full test title
// is the one the suite has always reported.

let util;
// The cap is spelled out as a LITERAL below, never read from the constant: a case
// whose expectation is derived from the value under test moves with it and passes
// at any cap at all. The value itself is pinned by its own case at the end.
const CAP   = 10;
const BURST = 14;

// `n` requests all effective at the same stamp, in a deliberately scrambled
// insertion order, so nothing but the applier order can produce the sequence
// the assertions expect. action_index carries the order; the ids are hashes of
// it, so an id collation would produce a different sequence.
function aligned(n, deadline = DEADLINE) {
    const requests = [], rows = [];
    for (let i = 0; i < n; i++) {
        const id = crypto.createHash('sha256').update('cap:' + i).digest('hex');
        requests.push(requestRow({ request_id: id, action_index: 100 + i,
                                   block_index: REQ_BLOCK, deadline_block: deadline }));
        rows.push(mirrorRow({ request_id: id,
                              response_hash: crypto.createHash('sha256').update(id).digest('hex') }));
    }
    const scramble = (a) => a.slice().sort((x, y) =>
        String(x.request_id).localeCompare(String(y.request_id)));
    const order = requests.map(r => r.request_id);
    const shuffled = scramble(requests);
    assert.notDeepStrictEqual(shuffled.map(r => r.request_id), order,
        'fixture assumption: the insertion order must disagree with the applier order, ' +
        'or a cap over an unordered set would pass these cases');
    return { requests: shuffled, rows: scramble(rows), order };
}
const idsOf = (applied) => applied.map(a => a.response.request_id);

// ------------------------------------------------- the per-block cap and its carry

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    describe('per-block cap (ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK)', function () {
        beforeEach(function () { util = new Utility(); });

        it('takes exactly the cap at B, in the applier order', function () {
            const { requests, rows, order } = aligned(BURST);
            const atB = util.selectApplicableAttestationResponses(rows, requests, 100, EFFECTIVE_T, 'regtest');
            assert.strictEqual(atB.length, CAP,
                'an aligned burst must not put every callback into one block transaction');
            assert.deepStrictEqual(idsOf(atB), order.slice(0, CAP),
                'the cap takes a PREFIX of the total order, never an arbitrary subset');
        });

        it('applies the deferred rows at B+1, in the same order, with no stored state', function () {
            const { requests, rows, order } = aligned(BURST);
            const atB = util.selectApplicableAttestationResponses(rows, requests, 100, EFFECTIVE_T, 'regtest');

            // The carry-forward rule verbatim: the rows B took are terminal now, so the
            // next block sees the rest still pending and selects them itself. Nothing was
            // written down between the two calls.
            const taken = new Set(idsOf(atB));
            const left  = requests.filter(r => !taken.has(r.request_id));
            const atB1  = util.selectApplicableAttestationResponses(rows, left, 101, EFFECTIVE_T, 'regtest');

            assert.deepStrictEqual(idsOf(atB1), order.slice(CAP),
                'the deferred rows drain at the next block, in the order they were deferred in');
            assert.deepStrictEqual(idsOf(atB).concat(idsOf(atB1)), order,
                'and the two prefixes concatenate to the one order, so the boundary moves nothing');
        });

        it('never applies a row whose deadline passes while it is deferred', function () {
            // The burst's deadline is B itself, so everything past the cap can only be
            // reconsidered at B+1, where B+1 > deadline_block refuses it. The expiry
            // sweep flips those requests and the expired callback stands.
            const { requests, rows, order } = aligned(BURST, 100);
            const atB = util.selectApplicableAttestationResponses(rows, requests, 100, EFFECTIVE_T, 'regtest');
            assert.deepStrictEqual(idsOf(atB), order.slice(0, CAP));

            const taken = new Set(idsOf(atB));
            const left  = requests.filter(r => !taken.has(r.request_id));
            assert.strictEqual(
                util.selectApplicableAttestationResponses(rows, left, 101, EFFECTIVE_T, 'regtest').length, 0,
                'a deferred row past its deadline is never applied: the expiry verdict stands');
        });

        it('is the admission cap\'s own per-block figure, so it never throttles a legal rate', function () {
            const caps = require('../../../../../src/attest_request_cap_activation.js');
            const declared = require('../../../../../src/actions/attest/index.js').ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK;
            assert.strictEqual(declared, CAP, 'the cap the cases above spell out is the one the code carries');
            assert.strictEqual(declared, caps.ATTEST_REQUEST_CAPS.perBlock,
                'the chain cannot admit more requests per block than this, so a steady ' +
                'state can never produce more responses per block than the cap allows');
        });
    });
});
