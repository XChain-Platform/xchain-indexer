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
// Stake handler: gate-off behavior for contract-targeted stakes whose signing
// key is claimed by a live contract delegation. Part of the Stake suite; see
// ../stake.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../../../fixtures/mocks');

const { PUBKEY, makeData, useStakeHarness } = require('./helpers/stake_harness.js');

let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

const CONTRACT_INDEX = '5';
const CONTRACT_TICK  = 'TEST';
const PARAMS = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];

function makeContractToken() {
    return createTokenInfo({ TICK: CONTRACT_TICK, TICK_ID: 2, DECIMALS: 0 });
}

describe('Stake handler delegated signing key gate off @regression @tier2', function () {
    useStakeHarness(bind);

    beforeEach(function () {
        actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
            return name !== 'STAKE_DELEGATED_SIGNING_KEY';
        });
        indexer.indexerDb.isSigningPubkeyUsedByContractDelegation = sinon.stub().resolves(true);
        indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: 100 });
        indexer.indexerDb.getStatusString.resolves('valid');
        indexer.indexerDb.getTokenInfo.resolves(makeContractToken());
        indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });
    });

    it('accepts a new claim when the delegation claim gate is off', async function () {
        indexer.indexerDb.getContractStakeOwner.resolves(null);
        const data = makeData({ FORMAT: 3 });

        await handler.parse(PARAMS, data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(indexer.indexerDb.createContractStake.calledOnce);
    });

    it('accepts a same-source top-up when the delegation claim gate is off', async function () {
        indexer.indexerDb.getContractStakeOwner.resolves(42);
        indexer.indexerDb.getAddressId.resolves(42);
        const data = makeData({ FORMAT: 3 });

        await handler.parse(PARAMS, data, null);

        assert.strictEqual(data.STATUS, 'valid');
    });

    it('preserves the existing stake collision verdict when the gate is off', async function () {
        indexer.indexerDb.getContractStakeOwner.resolves(99);
        const data = makeData({ FORMAT: 3 });

        await handler.parse(PARAMS, data, null);

        assert.ok(data.STATUS.includes('already staked'));
    });
});
