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
 * test/unit/db.getAttestationDataForVM.test.js
 *
 * getAttestationDataForVM builds the read-only snapshot the VM exposes
 * through xchain.attestation.getResponse(requestId). This suite pins the shaping,
 * the retry-then-ok dedup, the as-of visibility gate, and the serializable shape
 * the forked-worker accessor (xchain-vm/src/readonly-accessors.js) rebuilds from.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const { buildAttestationAccessor } = require('../../../xchain-vm/src/readonly-accessors');

const VALID_ID = 7;

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    // getStatusId('valid') -> VALID_ID; the reader early-returns empty on null.
    sinon.stub(db, 'getStatusId').resolves(VALID_ID);
    return db;
}

// Stub the single SELECT the reader runs; `rows` is what it returns.
function stubRows(db, rows) {
    sinon.stub(db, 'doQuery').callsFake(async (sql) => {
        if (/FROM\s+attests\s+v1/i.test(sql)) return rows;
        return [];
    });
}

const rid = (c) => c.repeat(64);

describe('db.getAttestationDataForVM @regression @tier2', function () {

    afterEach(() => sinon.restore());

    it('shapes an ok response into { status, payload, providerId, blockIndex, validatorCount }', async function () {
        const db = makeDb();
        stubRows(db, [{
            request_id: rid('a'), provider_id: 'http_get',
            response_payload: 'BTC=64000', response_status: 'ok',
            validator_signatures: JSON.stringify([{ pubkey: 'p1', sig: 's1' }, { pubkey: 'p2', sig: 's2' }]),
            block_index: 500, action_index: 42
        }]);
        const snap = await db.getAttestationDataForVM(9, 900);
        assert.deepStrictEqual(snap.responses[rid('a')], {
            status: 'ok', payload: 'BTC=64000', providerId: 'http_get',
            blockIndex: 500, validatorCount: 2
        });
        // The forked-worker accessor reads it back the way the gateway calls it.
        const acc = buildAttestationAccessor(snap);
        assert.strictEqual(acc.getResponse(rid('a')).payload, 'BTC=64000');
        assert.strictEqual(acc.getResponse('unknown'), null);
    });

    it('passes the as-of block, the contract scope, and the valid status id to the query', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.getAttestationDataForVM('9', 900);
        const [sql, args] = dq.getCall(0).args;
        assert.ok(/v0\.contract_index\s*=\s*\?/i.test(sql), 'must scope by the request row contract_index');
        assert.ok(/v1\.block_index\s*<=\s*\?/i.test(sql), 'must gate visibility as-of the block');
        assert.ok(/response_status\s*=\s*'ok'/i.test(sql), 'must select only terminal ok responses');
        // args: [valid_id, blockIndex, contractIndex, valid_id, cap]
        assert.strictEqual(args[0], VALID_ID);
        assert.strictEqual(args[1], 900);
        assert.strictEqual(args[2], 9);      // coerced to Number
        assert.strictEqual(args[3], VALID_ID);
        assert.strictEqual(typeof args[4], 'number'); // the GETRESPONSE_MAX cap
    });

    it('dedups multiple ok rows per request_id to the EARLIEST (block, action)', async function () {
        const db = makeDb();
        // Query returns newest-first (block desc, action desc). Two rows share a
        // request_id; the earliest (block 500) must win regardless of row order.
        stubRows(db, [
            { request_id: rid('b'), provider_id: 'http_get', response_payload: 'late',
              response_status: 'ok', validator_signatures: '[]', block_index: 600, action_index: 10 },
            { request_id: rid('b'), provider_id: 'http_get', response_payload: 'early',
              response_status: 'ok', validator_signatures: '[]', block_index: 500, action_index: 99 },
        ]);
        const snap = await db.getAttestationDataForVM(9, 900);
        assert.strictEqual(Object.keys(snap.responses).length, 1);
        assert.strictEqual(snap.responses[rid('b')].payload, 'early');
        assert.strictEqual(snap.responses[rid('b')].blockIndex, 500);
    });

    it('tolerates a null payload and a malformed / missing signatures column', async function () {
        const db = makeDb();
        stubRows(db, [
            { request_id: rid('c'), provider_id: 'llm', response_payload: null,
              response_status: 'ok', validator_signatures: null, block_index: 300, action_index: 1 },
            { request_id: rid('d'), provider_id: 'llm', response_payload: 'x',
              response_status: 'ok', validator_signatures: 'not-json', block_index: 301, action_index: 2 },
            { request_id: rid('e'), provider_id: 'llm', response_payload: 'y',
              response_status: 'ok', validator_signatures: '{"not":"array"}', block_index: 302, action_index: 3 },
        ]);
        const snap = await db.getAttestationDataForVM(9, 900);
        assert.strictEqual(snap.responses[rid('c')].payload, '');       // null -> ''
        assert.strictEqual(snap.responses[rid('c')].validatorCount, 0);
        assert.strictEqual(snap.responses[rid('d')].validatorCount, 0); // unparseable -> 0
        assert.strictEqual(snap.responses[rid('e')].validatorCount, 0); // parseable non-array -> 0
    });

    it('returns an empty snapshot when the valid status id is unknown', async function () {
        const db = makeDb();
        db.getStatusId.restore();
        sinon.stub(db, 'getStatusId').resolves(null);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const snap = await db.getAttestationDataForVM(9, 900);
        assert.deepStrictEqual(snap, { responses: {} });
        assert.strictEqual(dq.called, false, 'must not run the SELECT without a valid status id');
    });

    it('lower-cases request_id keys so contract-held ids resolve', async function () {
        const db = makeDb();
        stubRows(db, [{
            request_id: 'ABCDEF' + '0'.repeat(58), provider_id: 'http_get',
            response_payload: 'v', response_status: 'ok',
            validator_signatures: '[]', block_index: 100, action_index: 1
        }]);
        const snap = await db.getAttestationDataForVM(9, 900);
        assert.ok(snap.responses['abcdef' + '0'.repeat(58)], 'key must be lower-cased');
    });
});
