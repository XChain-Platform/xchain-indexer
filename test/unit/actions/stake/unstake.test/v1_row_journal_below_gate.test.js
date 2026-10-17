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
process.env.INDEXER_NETWORK = 'mainnet';

const assert = require('assert');
const sinon = require('sinon');
const { PUBKEY, makeData, makeUnstakeContext } = require('./helpers/unstake_context.js');

const CONTRACT_INDEX = '5';
const TICK = 'XCHAIN';
const ENABLED_CHANGES = [
    'PARTIAL_UNSTAKE_COLLECT',
    'CONTRACT_INDEX_CANONICAL',
    'UNSTAKE_CONTRACT_COOLDOWN_STRICT',
];

let indexer, handler;

function freshUnstake() {
    const context = makeUnstakeContext();
    indexer = context.indexer;
    handler = context.handler;
    indexer.config.NETWORK = 'mainnet';
    context.actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
        ENABLED_CHANGES.includes(name));
    indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: 200 });
    indexer.indexerDb.getActiveContractStakeByPubkey.resolves({
        source_id: 42,
        amount: '100.00000000',
    });
    indexer.indexerDb.createContractDelegationRotation = sinon.stub().resolves();
}

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v1 row journal before delegated rotation', function () {
        it('partial unstake keeps the unstake and VERSION 3 residual on the request pubkey', async function () {
            const data = makeData({ FORMAT: 1 });

            await handler.parse(['1', PUBKEY, CONTRACT_INDEX, TICK, '40'], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createContractUnstake.calledOnce);
            assert.strictEqual(
                indexer.indexerDb.createContractUnstake.firstCall.args[0].SIGNING_PUBKEY,
                PUBKEY
            );
            assert.ok(indexer.indexerDb.createContractStake.calledOnce);
            const residual = indexer.indexerDb.createContractStake.firstCall.args[0];
            assert.strictEqual(residual.VERSION, 3);
            assert.strictEqual(residual.SIGNING_PUBKEY, PUBKEY);
            assert.ok(indexer.indexerDb.createContractDelegationRotation.notCalled);
        });

        it('full unstake keeps the unstake on the request pubkey and writes no residual', async function () {
            const data = makeData({ FORMAT: 1 });

            await handler.parse(['1', PUBKEY, CONTRACT_INDEX, TICK], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createContractUnstake.calledOnce);
            assert.strictEqual(
                indexer.indexerDb.createContractUnstake.firstCall.args[0].SIGNING_PUBKEY,
                PUBKEY
            );
            assert.ok(indexer.indexerDb.createContractStake.notCalled);
            assert.ok(indexer.indexerDb.createContractDelegationRotation.notCalled);
        });
    });
});
