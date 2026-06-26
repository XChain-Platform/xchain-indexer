'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XCHAIN is BTC-only. The gas token exists as a real, balance-bearing token
 * only on the BTC ledger; on DOGE/LTC fees settle in native coin (XCHAIN is
 * only a unit of account for sizing), so XCHAIN is never created there. issue.js
 * rejects an XCHAIN ISSUE with 'invalid: TICK (BTC-only)' on any non-BTC chain
 * (regtest is exempt so the e2e harness can self-seed play-money gas). ISSUE of
 * XCHAIN remains GAS-only on every chain; this test isolates the chain gate.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Issue = require('../../src/actions/issue.js');

// Per-chain GAS (issuer) addresses, matching configs/<COIN>.js mainnet shapes.
const GAS = {
    BTC:  '1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA',
    DOGE: 'DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW',
    LTC:  'LXChainCN6yjHVqqS9tYzYVYZ8CCZcSx72'
};

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction:   sinon.stub().resolves(),
    };
}

// ISSUE format-0 field array (VERSION first), only the fields we care about set.
function issueParams(overrides = {}) {
    const d = Object.assign({
        VERSION: '0', TICK: 'XCHAIN', MAX_SUPPLY: '100000000', MAX_MINT: '',
        DECIMALS: '8', DESCRIPTION: 'XChain gas token', MINT_SUPPLY: '', TRANSFER: '',
        TRANSFER_SUPPLY: '', LOCK_MAX_SUPPLY: '', LOCK_MAX_MINT: '', LOCK_DESCRIPTION: '',
        LOCK_SLEEP: '', LOCK_CALLBACK: '', CALLBACK_BLOCK: '', CALLBACK_TICK: '',
        CALLBACK_AMOUNT: '', ALLOW_LIST: '', BLOCK_LIST: '', MINT_ADDRESS_MAX: '',
        MINT_START_BLOCK: '999999999', MINT_STOP_BLOCK: '', LOCK_MINT: '',
        LOCK_MINT_SUPPLY: '', MEMO: ''
    }, overrides);
    return [d.VERSION, d.TICK, d.MAX_SUPPLY, d.MAX_MINT, d.DECIMALS, d.DESCRIPTION,
        d.MINT_SUPPLY, d.TRANSFER, d.TRANSFER_SUPPLY, d.LOCK_MAX_SUPPLY, d.LOCK_MAX_MINT,
        d.LOCK_DESCRIPTION, d.LOCK_SLEEP, d.LOCK_CALLBACK, d.CALLBACK_BLOCK, d.CALLBACK_TICK,
        d.CALLBACK_AMOUNT, d.ALLOW_LIST, d.BLOCK_LIST, d.MINT_ADDRESS_MAX, d.MINT_START_BLOCK,
        d.MINT_STOP_BLOCK, d.LOCK_MINT, d.LOCK_MINT_SUPPLY, d.MEMO];
}

// Run an XCHAIN ISSUE from the chain's own GAS address (so the reserved-tick and
// GAS-address gates pass and only the BTC-only chain gate is under test).
async function runXchainIssue({ coin, network }){
    const indexer = createMockIndexer();
    indexer.config.COIN    = coin;
    indexer.config.NETWORK = network;
    indexer.config.ADDRESS.GAS = GAS[coin];
    indexer.indexerDb.getTokenInfo.resolves(null); // XCHAIN does not yet exist

    const handler = new Issue(makeActionsCtx(indexer));
    const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 950001, SOURCE: GAS[coin] });
    await handler.parse(issueParams(), data, null);
    return data.STATUS;
}

describe('XCHAIN BTC-only ISSUE gate @regression @security', function () {

    afterEach(function () { sinon.restore(); });

    it('rejects an XCHAIN ISSUE on DOGE mainnet (BTC-only)', async function () {
        assert.strictEqual(await runXchainIssue({ coin: 'DOGE', network: 'mainnet' }), 'invalid: TICK (BTC-only)');
    });

    it('rejects an XCHAIN ISSUE on LTC mainnet (BTC-only)', async function () {
        assert.strictEqual(await runXchainIssue({ coin: 'LTC', network: 'mainnet' }), 'invalid: TICK (BTC-only)');
    });

    it('rejects an XCHAIN ISSUE on DOGE testnet (BTC-only)', async function () {
        assert.strictEqual(await runXchainIssue({ coin: 'DOGE', network: 'testnet' }), 'invalid: TICK (BTC-only)');
    });

    it('does NOT apply the BTC-only gate on BTC mainnet', async function () {
        assert.notStrictEqual(await runXchainIssue({ coin: 'BTC', network: 'mainnet' }), 'invalid: TICK (BTC-only)');
    });

    it('exempts regtest so e2e can self-seed gas on DOGE regtest', async function () {
        assert.notStrictEqual(await runXchainIssue({ coin: 'DOGE', network: 'regtest' }), 'invalid: TICK (BTC-only)');
    });
});
