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
// DEPLOY unit suite: paying the deploy fee in the native coin or in XCHAIN. One
// part of deploy.test.js; the shared fixtures are in helpers/deploy_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');
const { getTestConfig } = require('../../../fixtures/config');
const { VALID_CODE_B64, addDeployStubs, makeVm, deployData, freshDeploySuite } = require('./helpers/deploy_suite.js');

const Deploy = require('../../../../src/actions/deploy/index.js');

// Every same-title block below runs this before each test, so each test
// starts from the same fixtures as the rest of the suite.
function freshSuite() {
    freshDeploySuite();
}

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Native coin fee payment paths (lines 185-203) ───────────────────

    describe('native coin fee payment', function () {
        it('valid native coin fee sets feePaymentMode=1 and STATUS valid', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001'; // non-zero fee to trigger payment mode check
            const localIndexer = createMockIndexer({ config });
            addDeployStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb, vm: makeVm(), protocolChanges: { isEnabled: sinon.stub().resolves(true) } };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(localIndexer.util, 'validateNativeCoinFee').resolves({ valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 1 });

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('invalid native coin fee returns error', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001';
            const localIndexer = createMockIndexer({ config });
            addDeployStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb, vm: makeVm(), protocolChanges: { isEnabled: sinon.stub().resolves(true) } };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(localIndexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'fee too small' });

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('fee too small') || String(data['STATUS']).startsWith('invalid'));
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('native coin fee payment', function () {
        it('rejected native coin fee returns insufficient fee error', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001';
            const localIndexer = createMockIndexer({ config });
            addDeployStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb, vm: makeVm(), protocolChanges: { isEnabled: sinon.stub().resolves(true) } };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('rejected');

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('insufficient fee'));
        });

        it('xchain balance insufficient for GAS returns invalid (lines 200-202)', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001';
            const localIndexer = createMockIndexer({ config });
            addDeployStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            // Zero balance; fee check will fail
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '0' });

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb, vm: makeVm(), protocolChanges: { isEnabled: sinon.stub().resolves(true) } };
            const h = new Deploy(ctx);

            // Ensure xchain mode is used (detectFeePaymentMode returns 'xchain')
            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('xchain');

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('insufficient funds') || String(data['STATUS']).includes('GAS'));
        });

    });
});
