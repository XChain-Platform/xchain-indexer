'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/relayed-attestation-requests.test.js
 *
 * getRelayedAttestationRequests, the home-side read the cross-chain
 * attestation relay runs both halves of its round trip on.
 *
 * What these pin, and why each is worth a test rather than a reading:
 *
 *   1. PLACEHOLDER ALIGNMENT. The valid-status id is bound inside the LEFT JOIN's
 *      ON clause, so it is the FIRST placeholder in the statement while being the
 *      last value the method computes. A misordered args array is not a syntax
 *      error: it silently filters on the wrong column and the read comes back
 *      empty, which the relay driver cannot distinguish from "no work", so the
 *      response leg would simply never fire. Counted here rather than trusted.
 *   2. ANY STATUS, NOT JUST PENDING. The read exists because the pending queue
 *      alone answered "is this request already materialized" only while the
 *      request was pending; a fulfilled one read as absent and drew a duplicate v3
 *      that v3 admission rejects after the BTC fee is already spent.
 *   3. TERMINAL RESPONSES ONLY. Relaying a retryable response (no_quorum,
 *      timeout, provider_error) would close an origin request the home chain still
 *      intends to fulfill.
 *   4. FOREIGN ORIGIN ONLY. A native request has origin_chain NULL and an
 *      origin-side relay row carries this coin, so neither is home-side relay work.
 ********************************************************************/

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility  = require('../../src/utility.js');
const Database = require('../../src/db.js');

const REQ_ID = 'd'.repeat(64);

function makeDb(rows = []) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'getStatusId').resolves(7);
    sinon.stub(db, 'doQuery').resolves(rows);
    return db;
}

// Everything the relay driver reads off one row, in the column names it expects.
function row(overrides = {}) {
    return {
        action_index:          9001n,
        block_index:           940n,
        request_id:            REQ_ID,
        provider_id:           'http_get',
        origin_chain:          'LTC',
        origin_action_index:   4242n,
        request_status:        'fulfilled',
        response_action_index: 9002n,
        response_block_index:  980n,
        response_hash:         'a'.repeat(64),
        response_payload:      '{"score":42}',
        response_status:       'ok',
        meta:                  '200',
        ...overrides,
    };
}

describe('getRelayedAttestationRequests @regression @tier1', function () {

    afterEach(function () { sinon.restore(); });

    it('binds exactly as many arguments as the statement has placeholders', async function () {
        const db = makeDb();
        // Every optional clause on at once: status id, coin, request id, both cursor
        // components (bound three times by the keyset predicate) and the limit.
        await db.getRelayedAttestationRequests('BTC', REQ_ID, 250,
            { after_block_index: 100, after_action_index: 5 });

        const [sql, args] = db.doQuery.firstCall.args;
        assert.strictEqual((sql.match(/\?/g) || []).length, args.length,
            'placeholder count and bound argument count disagree');
    });

    it('binds the valid-status id FIRST, because its placeholder sits in the ON clause', async function () {
        const db = makeDb();
        await db.getRelayedAttestationRequests('BTC', null, 100, null);

        const [sql, args] = db.doQuery.firstCall.args;
        assert.ok(sql.indexOf('resp.status_id = ?') < sql.indexOf('WHERE'),
            'the status placeholder must precede the WHERE clause');
        assert.strictEqual(args[0], 7, 'the status id must be the first bound value');
        assert.strictEqual(args[1], 'BTC', 'the coin must be the second bound value');
        assert.strictEqual(args[args.length - 1], 100, 'the limit must be the last bound value');
    });

    it('returns a request at ANY lifecycle status, not only pending ones', async function () {
        const db = makeDb();
        await db.getRelayedAttestationRequests('BTC', null, 100, null);

        const [sql] = db.doQuery.firstCall.args;
        // The whole point of the read: a fulfilled or expired BTC row must still be
        // visible or the relay driver re-materializes it.
        assert.ok(!/req\.request_status\s*=/.test(sql),
            'the read must not filter the request by status');
        assert.ok(/req\.version = 0/.test(sql));
    });

    it('attaches only a VALID and TERMINAL response, through the join not the filter', async function () {
        const db = makeDb();
        await db.getRelayedAttestationRequests('BTC', null, 100, null);

        const [sql] = db.doQuery.firstCall.args;
        const onClause = sql.slice(sql.indexOf('LEFT JOIN'), sql.indexOf('WHERE'));
        assert.ok(/resp\.version = 1/.test(onClause));
        assert.ok(/resp\.status_id = \?/.test(onClause));
        assert.ok(/resp\.response_status IN \('ok','expired'\)/.test(onClause),
            'a retryable response must never attach: relaying one closes a request BTC still intends to fulfill');
        // In the WHERE clause these would null out the LEFT JOIN and hide every
        // unfulfilled request, defeating point 2 above.
        const whereClause = sql.slice(sql.indexOf('WHERE'));
        assert.ok(!/resp\./.test(whereClause), 'no response predicate may sit in the WHERE clause');
    });

    it('selects only requests whose origin chain is some OTHER chain', async function () {
        const db = makeDb();
        await db.getRelayedAttestationRequests('BTC', null, 100, null);

        const [sql] = db.doQuery.firstCall.args;
        assert.ok(/req\.origin_chain IS NOT NULL/.test(sql), 'a native request is not relay work');
        assert.ok(/req\.origin_chain <> \?/.test(sql), 'an origin-side row carries this coin and is not home-side work');
    });

    it('orders and pages on the REQUEST pair, so one cursor implementation serves both attest reads', async function () {
        const db = makeDb();
        await db.getRelayedAttestationRequests('BTC', null, 100,
            { after_block_index: 100, after_action_index: 5 });

        const [sql] = db.doQuery.firstCall.args;
        assert.ok(/ORDER BY req\.block_index ASC, req\.action_index ASC/.test(sql));
        assert.ok(/req\.block_index > \? OR \(req\.block_index = \? AND req\.action_index > \?\)/.test(sql));
    });

    it('clamps the limit rather than interpolating a caller value into LIMIT', async function () {
        for (const [given, expected] of [[100.5, 100], [5000, 500], [0, 100], ['x', 100], [-1, 100]]) {
            const db = makeDb();
            await db.getRelayedAttestationRequests('BTC', null, given, null);
            const args = db.doQuery.firstCall.args[1];
            assert.strictEqual(args[args.length - 1], expected, 'limit ' + given + ' should clamp to ' + expected);
            sinon.restore();
        }
    });

    it('lowercases the request_id filter, which is stored lowercase', async function () {
        const db = makeDb();
        await db.getRelayedAttestationRequests('BTC', REQ_ID.toUpperCase(), 100, null);
        assert.ok(db.doQuery.firstCall.args[1].includes(REQ_ID));
    });

    it('converts every BigInt column so the JSON-RPC serializer can emit the row', async function () {
        const db = makeDb([row()]);
        const [out] = await db.getRelayedAttestationRequests('BTC', null, 100, null);
        for (const field of ['action_index', 'block_index', 'response_action_index',
                             'response_block_index', 'origin_action_index'])
            assert.strictEqual(typeof out[field], 'number', field + ' must serialize as a Number');
        assert.strictEqual(out.response_status, 'ok');
        assert.strictEqual(out.provider_id, 'http_get');
    });

    it('leaves an unfulfilled request with a null response, which the relay driver skips', async function () {
        const db = makeDb([row({
            request_status: 'pending', response_action_index: null, response_block_index: null,
            response_hash: null, response_payload: null, response_status: null, meta: null,
        })]);
        const [out] = await db.getRelayedAttestationRequests('BTC', null, 100, null);
        assert.strictEqual(out.response_action_index, null);
        assert.strictEqual(out.request_id, REQ_ID);
    });
});
