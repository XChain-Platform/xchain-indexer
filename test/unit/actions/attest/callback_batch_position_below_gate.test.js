// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'mainnet';

const assert = require('assert');
const sinon = require('sinon');

const { setUpAttestHandler, makeRequestRow } = require('../../../helpers/attest_fixture.js');
const { resolveRootDiscriminator } = require('../../../../src/consensus/batch_root_discriminator.js');

describe('ATTEST callback BATCH_POSITION below gate @regression @tier3', function () {
    let handler, executeStub, actionsCtx;

    beforeEach(function () {
        ({ handler, executeStub, actionsCtx } = setUpAttestHandler());
        actionsCtx.config.NETWORK = 'mainnet';
    });

    afterEach(function () {
        sinon.restore();
    });

    async function captureContexts(method) {
        const contexts = [];
        executeStub.parse.callsFake(async (params, data) => {
            contexts.push(data);
        });

        const request = makeRequestRow({ redundancy: 1 });
        const response = {
            BLOCK_INDEX: 100,
            BLOCK_TIME: 1700000000,
            TX_INDEX: 3,
            TX_VOUT: 0,
            TX_HASH: 'aa'.repeat(32),
            ACTION_INDEX: 7,
            RESPONSE_STATUS: 'ok',
            RESPONSE_PAYLOAD: ''
        };

        for (const batchPosition of [0, 1]) {
            await handler[method](request, {
                ...response,
                BATCH_POSITION: batchPosition
            });
        }

        return contexts;
    }

    async function assertCollidingRootDiscriminators(contexts) {
        assert.strictEqual(contexts.length, 2);
        assert.ok(contexts.every(context => !Object.prototype.hasOwnProperty.call(context, 'BATCH_POSITION')));
        assert.deepStrictEqual(contexts.map(context => [context.BLOCK_INDEX, context.TX_INDEX, context.TX_VOUT]), [
            [100, 3, 0],
            [100, 3, 0]
        ]);

        const protocolChanges = { isEnabled: sinon.stub().resolves(true) };
        const discriminators = await Promise.all(contexts.map(context => resolveRootDiscriminator(
            protocolChanges,
            context.BLOCK_INDEX,
            context.TX_VOUT,
            context.BATCH_POSITION
        )));

        assert.deepStrictEqual(discriminators, [0, 0]);
    }

    it('direct v1 responses at positions 0 and 1 inject contexts with one root discriminator', async function () {
        await assertCollidingRootDiscriminators(await captureContexts('injectCallbackExecute'));
    });

    it('relay ok responses at positions 0 and 1 inject contexts with one root discriminator', async function () {
        await assertCollidingRootDiscriminators(await captureContexts('injectRelayCallback'));
    });
});
