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
// THE HUB-MIRROR ATTEST RESPONSE APPLIER, the bounded applicability read: paging
// the pending-request read must not move which rows bind.
//
// The two units under test, why signature verification is stubbed, and the
// shared rows (./helpers/rows.js) are described in ../attest_response_applier.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const Utility  = require('../../../../../src/utility.js');
const Database = require('../../../../../src/db');

const { REQ_BLOCK, BLOCK_TIME, mirrorRow, requestRow } = require('./helpers/rows.js');

// Consecutive sibling blocks under the one suite title, so every full test title
// is the one the suite has always reported.

// The page size is spelled as a literal for the reason the cap is: a fixture
// derived from the value under test would follow it anywhere and prove nothing.
// It is not exported, so nothing but this comment ties the two together, and the
// point of every case here is that the answer does not depend on it.
const PAGE = 500;

// `n` pending requests in local request-row order, with a mirror row only for the indexes
// in `withResponse`, so the applicable rows sit at chosen distances into the read.
function fixture(n, withResponse) {
    const requests = [], rows = [], applicableIds = [];
    for (let i = 0; i < n; i++) {
        const id = crypto.createHash('sha256').update('page:' + i).digest('hex');
        requests.push(requestRow({ request_id: id, action_index: 1000 + i, block_index: REQ_BLOCK }));
        if (withResponse.has(i)) {
            rows.push(mirrorRow({ request_id: id,
                                  response_hash: crypto.createHash('sha256').update(id).digest('hex') }));
            applicableIds.push(id);
        }
    }
    return { requests, rows, applicableIds };
}

function mirrorStub(rows) {
    const byId = new Map(rows.map(r => [String(r.request_id), r]));
    return sinon.stub().callsFake(async (network, ids) =>
        ids.map(id => byId.get(String(id))).filter(Boolean));
}

// The read as it is now: a keyset walk the caller drives.
function pagedDb(fx) {
    return {
        config: { NETWORK: 'regtest' },
        getAttestationRequestsAwaitingMirrorResponse: sinon.stub().callsFake(async (b, limit, after) => {
            let rows = fx.requests;
            if (after) rows = rows.filter(r => Number(r.action_index) > Number(after.action_index));
            return (limit === undefined || limit === null) ? rows.slice() : rows.slice(0, Number(limit));
        }),
        getMirroredAttestationResponses: mirrorStub(fx.rows),
    };
}

async function applied(db) {
    const util   = new Utility();
    const spy    = { processAction: sinon.stub().resolves() };
    await util.processAttestationResponses(spy, db, 100, BLOCK_TIME);
    return spy.processAction.getCalls().map(c => c.args[2]['REQUEST_ID']);
}

// ------------------------------------------------------- the BOUNDED read (row 58)

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    describe('bounded applicability read (utility.processAttestationResponses paging)', function () {
        const CAP  = 10;

        // The read as it WAS: one call hands back every pending request and the selector's
        // own slice does the capping. This is the reference the bound must not move.
        function unpagedDb(fx) {
            let served = false;
            return {
                config: { NETWORK: 'regtest' },
                getAttestationRequestsAwaitingMirrorResponse: sinon.stub().callsFake(async () => {
                    if (served) return [];
                    served = true;
                    return fx.requests.slice();
                }),
                getMirroredAttestationResponses: mirrorStub(fx.rows),
            };
        }

        afterEach(function () { sinon.restore(); });

        it('applies the same rows paged as unpaged, when the cap prefix spans two pages', async function () {
            // Six applicable rows in the first page and six in the second, so the prefix
            // the cap takes crosses the page boundary: a bound that took its rows per page,
            // or that re-read a shifted window, would produce a different set here.
            const marks = new Set([3, 40, 111, 250, 400, 499, PAGE + 1, PAGE + 60, PAGE + 200,
                                   PAGE + 300, PAGE + 400, PAGE + 499]);
            const fx = fixture(PAGE * 3, marks);
            assert.strictEqual(fx.applicableIds.length, 12, 'fixture assumption: more applicable rows than the cap');

            const paged   = await applied(pagedDb(fx));
            const unpaged = await applied(unpagedDb(fx));
            assert.deepStrictEqual(paged, unpaged,
                'paging the read must not move which rows bind; a different prefix here is a fork');
            assert.deepStrictEqual(paged, fx.applicableIds.slice(0, CAP),
                'and the set is still the first CAP of the §4.1 total order');
        });

        it('stops reading once the cap is filled instead of dragging the whole pending set in', async function () {
            // Ten applicable rows inside the first page, and three pages of pending
            // requests behind them. The old read pulled all three pages and then every one
            // of their mirror rows; this one must never look past the first.
            const marks = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, PAGE + 5, PAGE * 2 + 5]);
            const fx = fixture(PAGE * 3, marks);
            const db = pagedDb(fx);
            const ids = await applied(db);

            assert.strictEqual(ids.length, CAP);
            assert.strictEqual(db.getAttestationRequestsAwaitingMirrorResponse.callCount, 1,
                'the second and third pages were never read');
            assert.strictEqual(db.getMirroredAttestationResponses.callCount, 1);
            assert.strictEqual(db.getMirroredAttestationResponses.firstCall.args[1].length, PAGE,
                'and the mirror read is bounded to one page of ids, not to every pending request');
        });
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    describe('bounded applicability read (utility.processAttestationResponses paging)', function () {
        afterEach(function () { sinon.restore(); });

        it('walks past pages that yield nothing, and carries the keyset rather than an offset', async function () {
            // One applicable row, in the LAST page. The read has to reach it, so the walk
            // does not stop early, and every page must advance: a cursor that did not move
            // would spin, and an offset cursor would re-read a shifted window.
            const fx = fixture(PAGE * 3, new Set([PAGE * 3 - 1]));
            const db = pagedDb(fx);
            assert.deepStrictEqual(await applied(db), fx.applicableIds);
            // Four reads for three pages: the pending set ends exactly on a page boundary,
            // which a full page cannot be told apart from a partial one, so the walk asks
            // once more and gets nothing.
            assert.strictEqual(db.getAttestationRequestsAwaitingMirrorResponse.callCount, 4);
            const cursors = db.getAttestationRequestsAwaitingMirrorResponse.getCalls().map(c => c.args[2]);
            assert.strictEqual(cursors[0], null, 'the first page starts with no cursor');
            assert.strictEqual(cursors[1].action_index, 1000 + PAGE - 1,
                'the cursor is the last row of the page just read, exclusive');
            assert.strictEqual(cursors[2].action_index, 1000 + PAGE * 2 - 1);
        });

        it('orders the page by §4.1 before it bounds it, and keysets rather than offsets', async function () {
            // The one thing the SQL owes the prefix: the bound must apply to the total
            // order, not to whatever order the planner would otherwise hand back. A LIMIT
            // above the ORDER BY, or an ORDER BY on anything but the local request row's
            // (block_index, action_index), silently changes WHICH rows a node applies.
            const db = Object.create(Database.prototype);
            db.doQuery = sinon.stub().resolves([]);
            await db.getAttestationRequestsAwaitingMirrorResponse(100, 250, { block_index: 90, action_index: 11 });

            const [query, params] = db.doQuery.firstCall.args;
            assert.ok(query.includes('ORDER BY ar.block_index ASC, ar.action_index ASC'),
                'the read order IS the §4.1 applier order');
            assert.ok(query.indexOf('ar.block_index > ?') < query.indexOf('ORDER BY'),
                'the keyset is a filter on that order, never a second ordering');
            assert.ok(query.indexOf('ORDER BY') < query.indexOf('LIMIT'),
                'and the bound takes a prefix of it');
            assert.deepStrictEqual(params, [100, 90, 90, 11, 250]);

            // Omitting both reproduces the unbounded read exactly, so nothing that still
            // wants the whole set is changed by the paging seam.
            db.doQuery.resetHistory();
            await db.getAttestationRequestsAwaitingMirrorResponse(100);
            assert.strictEqual(/LIMIT/.test(db.doQuery.firstCall.args[0]), false);
            assert.deepStrictEqual(db.doQuery.firstCall.args[1], [100]);
        });

        it('short-circuits an empty pending set without touching the mirror', async function () {
            const fx = fixture(0, new Set());
            const db = pagedDb(fx);
            assert.deepStrictEqual(await applied(db), []);
            assert.strictEqual(db.getMirroredAttestationResponses.called, false);
        });
    });
});
