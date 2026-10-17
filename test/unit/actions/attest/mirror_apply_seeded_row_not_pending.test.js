// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const { applyData, setupEffects } = require('./attest_response_applier.test/helpers/effects_fixture.js');

describe('ATTEST seeded undelivered mirror response @regression @tier3', function () {
    let indexer, handler, info, requestId, row;

    beforeEach(function () {
        ({ indexer, handler } = setupEffects());
        info = sinon.stub(observability.getLogger(), 'info');
        requestId = crypto.randomBytes(32).toString('hex');
        const responsePayload = '{"seeded":true}';
        row = {
            request_id: requestId,
            provider_id: 'seed_probe',
            status: 'ok',
            response_payload: responsePayload,
            response_hash: crypto.createHash('sha256').update(responsePayload).digest('hex'),
            meta: '{"seeded":"hub-seed-undelivered"}',
            signer_pubkeys: '[]',
            signatures: '[]',
        };
    });

    afterEach(function () { sinon.restore(); });

    async function assertSkipped(request) {
        const data = applyData();
        data['MIRROR_RESPONSE'] = row;
        data['MIRROR_REQUEST'] = request;

        const result = await handler.applyMirroredResponse(data);

        assert.deepStrictEqual(
            { rejected: result.rejected, code: result.code },
            { rejected: true, code: 'local request not pending' }
        );
        assert.strictEqual(info.calledOnce, true);
        const line = String(info.firstCall.args[0]);
        assert.ok(line.includes('SKIPPED (local request not pending)'));
        assert.ok(line.includes(requestId.slice(0, 16)));
        assert.strictEqual(indexer.indexerDb.createActionIndex.called, false);
        assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);
        assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
        assert.strictEqual(indexer.mapper.createMappings.called, false);
    }

    it('ignores the seeded row when the local request is absent', async function () {
        await assertSkipped(null);
    });

    it('ignores the seeded row when the local request is already valid', async function () {
        const data = applyData({}, {}, { request_id: requestId, request_status: 'valid' });
        await assertSkipped(data['MIRROR_REQUEST']);
    });
});
