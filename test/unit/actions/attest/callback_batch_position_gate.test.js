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
const { stubActiveAt } = require('../../../helpers/gate_modules.js');
const { resolveRootDiscriminator } = require('../../../../src/consensus/batch_root_discriminator.js');

const GATE = 'attest_callback_batch_position_activation.ATTEST_CALLBACK_BATCH_POSITION_ACTIVATION';

describe('ATTEST callback batch position activation @regression @tier3', function () {
    let handler, executeStub, actionsCtx;

    beforeEach(function () {
        ({ handler, executeStub, actionsCtx } = setUpAttestHandler());
        actionsCtx.config.NETWORK = 'mainnet';
    });

    afterEach(function () {
        sinon.restore();
    });

    const responseAt = (batchPosition) => ({
        BLOCK_INDEX: 100,
        BLOCK_TIME: 1700000000,
        TX_INDEX: 3,
        TX_VOUT: 0,
        TX_HASH: 'aa'.repeat(32),
        ACTION_INDEX: 7,
        RESPONSE_STATUS: 'ok',
        RESPONSE_PAYLOAD: '',
        BATCH_POSITION: batchPosition
    });

    async function inject(method, gateOn, batchPosition) {
        stubActiveAt(sinon, GATE, gateOn);
        await handler[method](makeRequestRow({ redundancy: 1 }), responseAt(batchPosition));
        return executeStub.parse.lastCall.args[1];
    }

    it('gate off preserves the legacy context without BATCH_POSITION', async function () {
        for (const position of [0, 1]) {
            const context = await inject('injectCallbackExecute', false, position);
            assert.ok(!Object.prototype.hasOwnProperty.call(context, 'BATCH_POSITION'));
        }
    });

    it('gate on copies BATCH_POSITION and separates callback root discriminators', async function () {
        const contexts = [];
        for (const position of [0, 1])
            contexts.push(await inject('injectCallbackExecute', true, position));

        assert.deepStrictEqual(contexts.map((context) => context.BATCH_POSITION), [0, 1]);
        const protocolChanges = { isEnabled: sinon.stub().resolves(true) };
        const roots = await Promise.all(contexts.map((context) => resolveRootDiscriminator(
            protocolChanges, context.BLOCK_INDEX, context.TX_VOUT, context.BATCH_POSITION
        )));
        assert.deepStrictEqual(roots, ['0.0', '0.1']);
    });

    it('relay mirror keeps the gated BATCH_POSITION identical to the direct callback', async function () {
        const direct = await inject('injectCallbackExecute', true, 4);
        const relayed = await inject('injectRelayCallback', true, 4);
        assert.strictEqual(direct.BATCH_POSITION, 4);
        assert.strictEqual(relayed.BATCH_POSITION, direct.BATCH_POSITION);
    });
});
