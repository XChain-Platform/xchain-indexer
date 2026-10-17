'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { buildIssue, makeData } = require('./issue.test/helpers/fixture.js');
const Address = require('../../../../src/actions/address.js');

const VALUES = [
    { wire: '1', expected: 1, name: '1' },
    { wire: '0', expected: 0, name: '0' },
    { wire: '01', expected: 0, name: '01' },
    { wire: '1.0', expected: 0, name: '1.0' },
    { wire: '', expected: 0, name: 'empty' },
    { wire: 'text', expected: 0, name: 'text' },
];

function effectiveController(expected) {
    return expected === 1 ? {
        action_index: 1500,
        contract_index: 1200,
        is_unbind: 0,
        cooldown_blocks: 144,
        cooldown_end_block: null,
    } : null;
}

describe('UNBIND exact wire value rule @regression', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('ISSUE format 6 (v6) treats only wire string 1 as unbind', async function () {
        for (const { wire, expected, name } of VALUES) {
            const { indexer, handler } = buildIssue();
            const data = makeData({ FORMAT: 6, ACTION_INDEX: 1600, BLOCK_INDEX: 900 });
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ OWNER: data.SOURCE }));
            indexer.indexerDb.getContract = sinon.stub().resolves({ action_index: 1500, status_id: 1 });
            indexer.indexerDb.getStatusString = sinon.stub().resolves('valid');
            indexer.indexerDb.getEffectiveTokenController.resolves(effectiveController(expected));

            await handler.parse(['6', 'TEST', '1500', 'transfer', '144', wire, ''], data, null);

            assert.strictEqual(data.STATUS, 'valid', `${name} remains a valid binding action`);
            assert.ok(indexer.indexerDb.recordTokenControllerEvent.calledOnce,
                `${name} records exactly one controller event`);
            assert.strictEqual(indexer.indexerDb.recordTokenControllerEvent.firstCall.args[0].is_unbind,
                expected, `${name} selects the expected binding branch`);
            sinon.restore();
        }
    });

    it('ADDRESS format 1 (v1) treats only wire string 1 as unbind', async function () {
        for (const { wire, expected, name } of VALUES) {
            const indexer = createMockIndexer();
            const handler = new Address({
                config: indexer.config,
                util: indexer.util,
                mapper: indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                protocolChanges: {
                    isDefined: sinon.stub().returns(true),
                    isEnabled: sinon.stub().resolves(true),
                },
                processAction: sinon.stub().resolves(),
            });
            const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 1, ACTION_INDEX: 1601, BLOCK_INDEX: 900 });
            indexer.indexerDb.getContract = sinon.stub().resolves({ action_index: 1500, status_id: 1 });
            indexer.indexerDb.getStatusString = sinon.stub().resolves('valid');
            indexer.indexerDb.getAddressId.resolves(7);
            indexer.indexerDb.createAddress.resolves(7);
            indexer.indexerDb.getEffectiveAddressController.resolves(effectiveController(expected));

            await handler.parse(['1', '1500', 'transfer', '144', wire, ''], data, null);

            assert.strictEqual(data.STATUS, 'valid', `${name} remains a valid binding action`);
            assert.ok(indexer.indexerDb.recordAddressControllerEvent.calledOnce,
                `${name} records exactly one controller event`);
            assert.strictEqual(indexer.indexerDb.recordAddressControllerEvent.firstCall.args[0].is_unbind,
                expected, `${name} selects the expected binding branch`);
            sinon.restore();
        }
    });
});
