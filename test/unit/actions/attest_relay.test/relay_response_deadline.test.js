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
const sinon  = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const {
    REQ_ID, v4Params, originRequestRow, setupRelay
} = require('./helpers/relay_fixture.js');

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler, executeStub;
    beforeEach(function () {
        ({ indexer, handler, executeStub } = setupRelay());
        indexer.config['COIN'] = 'LTC';
    });
    afterEach(function () { sinon.restore(); });

    describe('relay response deadline pre-gate', function () {
        it('records valid, closes fulfilled, and fires the callback at deadline+1', async function () {
            const deadlineBlock = 500;
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({
                deadline_block: deadlineBlock
            }));
            const data = createBaseData({
                ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: deadlineBlock + 1
            });

            await handler.parse(v4Params(), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.calledOnce, true);
            assert.strictEqual(
                indexer.indexerDb.createAttestationResponse.firstCall.args[0]['STATUS'],
                'valid');
            assert.deepStrictEqual(
                indexer.indexerDb.updateAttestationRequestStatus.firstCall.args.slice(0, 3),
                [REQ_ID, 'fulfilled', deadlineBlock + 1]);
            assert.strictEqual(executeStub.parse.calledOnce, true);
        });
    });
});
