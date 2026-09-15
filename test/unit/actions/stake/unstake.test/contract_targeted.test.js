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
//
// UNSTAKE v1 (contract-targeted): the valid path and its cooldown, target and
// stake-ownership rejections, parameter checks, and the error-path cooldown
// under UNSTAKE_CONTRACT_COOLDOWN_STRICT.
// Part of the UNSTAKE suite; see ../unstake.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { PUBKEY, BLOCK, makeData, makeUnstakeContext } = require('./helpers/unstake_context.js');

let indexer, actionsCtx, handler;

// Each test starts from its own mock indexer and UNSTAKE handler.
function freshUnstake() {
    ({ indexer, actionsCtx, handler } = makeUnstakeContext());
}

const CONTRACT_INDEX = '5';
const TICK           = 'TEST';

function makeContractInfo(overrides = {}) {
    return Object.assign({ source_id: 42, cooldown_blocks: 200 }, overrides);
}

// -----------------------------------------------------------------------
// v1 : Contract-targeted unstake
// -----------------------------------------------------------------------

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v1 : contract-targeted unstake', function () {
        beforeEach(function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '100' });
        });

        it('valid v1 unstake → STATUS valid, createContractUnstake called', async function () {
            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createContractUnstake.calledOnce);
        });

        it('valid v1 unstake → setContractStakeDeactivationByPubkey called', async function () {
            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.setContractStakeDeactivationByPubkey.calledOnce);
        });

        it('valid v1 unstake → mapper.createMappings called', async function () {
            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('v1 COOLDOWN_END_BLOCK = block + contract cooldown_blocks', async function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo({ cooldown_blocks: 50 }));

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.COOLDOWN_END_BLOCK, BLOCK + 50);
        });
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v1 : contract-targeted unstake', function () {
        beforeEach(function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '100' });
        });

        it('contract not found → invalid', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('unknown'));
        });

        it('contract has no cooldown_blocks → invalid (not stakeable)', async function () {
            indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: null });

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('not stakeable'));
        });

        it('no active contract stake for (target, pubkey, tick) → invalid', async function () {
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves(null);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('no active stake on contract'));
        });

        it('contract stake owned by different source → invalid', async function () {
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 99, amount: '100' });
            indexer.indexerDb.getAddressId.resolves(42);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v1 : contract-targeted unstake', function () {
        beforeEach(function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '100' });
        });

        it('v1 TARGET_CONTRACT_INDEX missing → invalid', async function () {
            const params = ['1', PUBKEY, '', TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TARGET_CONTRACT_INDEX'));
        });

        it('v1 TARGET_CONTRACT_INDEX = 0 → invalid', async function () {
            const params = ['1', PUBKEY, '0', TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TARGET_CONTRACT_INDEX'));
        });

        it('v1 TICK missing → invalid', async function () {
            const params = ['1', PUBKEY, CONTRACT_INDEX, ''];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TICK'));
        });

        it('v1 source sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v1 : contract-targeted unstake', function () {
        beforeEach(function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '100' });
        });

        it('v1 AMOUNT set from aggregate amount', async function () {
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '333' });

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.AMOUNT, '333');
        });

        // Pkg6 / 048fdea9 + ce6a484f (gated UNSTAKE_CONTRACT_COOLDOWN_STRICT): error-path rows
        // must not carry the phantom BLOCK_INDEX+1000 cooldown from the legacy global fallback.
        it('error-path (unknown target) COOLDOWN_END_BLOCK is 0, not BLOCK+1000, once strict', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('unknown'));
            assert.strictEqual(data.COOLDOWN_END_BLOCK, 0);
        });

        it('error-path COOLDOWN_END_BLOCK stays BLOCK+1000 below the flag-day (replay fidelity)', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
                name === 'UNSTAKE_CONTRACT_COOLDOWN_STRICT' ? false : true);
            indexer.indexerDb.getContract.resolves(null);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('unknown'));
            assert.strictEqual(data.COOLDOWN_END_BLOCK, BLOCK + 1000);
        });
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v1 : contract-targeted unstake', function () {
        beforeEach(function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '100' });
        });

        it('rejects a non-integer contract cooldown once strict (latent cross-file trap closed)', async function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo({ cooldown_blocks: 50.5 }));

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('contract cooldown invalid'));
            assert.strictEqual(data.COOLDOWN_END_BLOCK, 0);
        });

        it('valid-path COOLDOWN_END_BLOCK is unchanged by the strict gate', async function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo({ cooldown_blocks: 200 }));

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.COOLDOWN_END_BLOCK, BLOCK + 200);
        });
    });
});
