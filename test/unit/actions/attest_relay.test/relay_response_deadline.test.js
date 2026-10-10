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
const sinon = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const { REQ_ID, v4Params, originRequestRow, setupRelay } = require('./helpers/relay_fixture.js');

describe('ATTEST v4 relay response deadline @regression @tier1', function () {
    let indexer, handler, executeStub, deadlineGate;

    beforeEach(function () {
        ({ indexer, handler, executeStub, deadlineGate } = setupRelay());
        indexer.config['COIN'] = 'LTC';
    });

    afterEach(function () { sinon.restore(); });

    it("preserves today's pre-gate fulfilled status and callback at deadline+1", async function () {
        deadlineGate.returns(false);
        indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({
            block_index: 3160000,
            deadline_block: 3160005
        }));
        const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160006 });

        await handler.parse(v4Params(), data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.deepStrictEqual(
            indexer.indexerDb.updateAttestationRequestStatus.firstCall.args.slice(0, 2),
            [REQ_ID, 'fulfilled']);
        assert.strictEqual(executeStub.parse.calledOnce, true);
    });

    it('accepts a response landing exactly at deadline_block', async function () {
        const deadline = 3160010;
        indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({ deadline_block: deadline }));
        const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: deadline });

        await handler.parse(v4Params(), data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.calledOnce, true);
        assert.strictEqual(deadlineGate.calledWith('regtest', null, null, data['BLOCK_TIME']), true);
    });

    it('rejects a response landing at deadline+1 after activation', async function () {
        const deadline = 3160010;
        indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({ deadline_block: deadline }));
        const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: deadline + 1 });

        await handler.parse(v4Params(), data, null);

        assert.strictEqual(data['STATUS'], 'invalid: REQUEST expired (deadline_block=' + deadline + ')');
        assert.strictEqual(indexer.indexerDb.createAttestationResponse.calledOnce, true);
        assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
        assert.strictEqual(executeStub.parse.called, false);
    });

    it('preserves the legacy acceptance of deadline+1 below activation', async function () {
        const deadline = 3160010;
        deadlineGate.returns(false);
        indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({ deadline_block: deadline }));
        const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: deadline + 1 });

        await handler.parse(v4Params(), data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.calledOnce, true);
        assert.strictEqual(executeStub.parse.calledOnce, true);
    });
});
