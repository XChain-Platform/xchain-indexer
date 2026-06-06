'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Sleep = require('../../../../src/actions/sleep.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

describe('SLEEP RESUME_BLOCK boundary tests @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
    const BLOCK  = 100;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Sleep(actionsCtx);
        indexer.indexerDb.isActionAllowed.resolves(true);
    });

    afterEach(function () { sinon.restore(); });

    it('TS-11: SLEEP with RESUME_BLOCK = -1 (indefinite special value) is valid', async function () {
        // -1 is listed in SLEEP_IMMEDIATE_METHODS so the past-block check is skipped
        const params = ['0', '-1', ''];
        const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('TS-12: SLEEP with RESUME_BLOCK = 0 (immediate resume special value) is valid', async function () {
        // 0 is listed in SLEEP_IMMEDIATE_METHODS so the past-block check is skipped
        const params = ['0', '0', ''];
        const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('TS-13: SLEEP with RESUME_BLOCK = 50 (past, non-special) when BLOCK_INDEX = 100 is invalid', async function () {
        // 50 < 100 and 50 is not in SLEEP_IMMEDIATE_METHODS — must be rejected
        const params = ['0', '50', ''];
        const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('SLEEP with RESUME_BLOCK = BLOCK_INDEX (exactly current block) — documents boundary behavior', async function () {
        // The check is bclt(RESUME_BLOCK, BLOCK_INDEX) — strictly less-than.
        // RESUME_BLOCK == BLOCK_INDEX is NOT less-than, so the guard does NOT fire → valid.
        const params = ['0', String(BLOCK), ''];
        const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });
        await handler.parse(params, data, null);
        // Document: equal-to-current-block is treated as valid (not past)
        assert.strictEqual(data.STATUS, 'valid', `expected valid (equal is not past) but got: ${data.STATUS}`);
    });

    it('SLEEP with RESUME_BLOCK = BLOCK_INDEX + 1 (one block in the future) is valid', async function () {
        const params = ['0', String(BLOCK + 1), ''];
        const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });
});
