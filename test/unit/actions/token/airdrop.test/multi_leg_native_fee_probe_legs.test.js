// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The fee probe draws no AIRDROP tally, so it lists each charged leg's own fee for the quote to
// replay the chain's in-order draw. The list exists only on a probe with a tally: a block's
// AIRDROP, a BATCH leg and an XCHAIN-balance fee never carry it.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'mainnet';

const assert = require('assert');
const sinon = require('sinon');
const { nativeFeeAirdrop } = require('./helpers/native_fee_legs.js');

const PARAMS = ['2', 'TEST', '10', '1', 'TEST', '10', '1', null];

async function runAirdrop(opts = {}) {
    const { indexer, handler, data } = nativeFeeAirdrop({ nativeFeeValue: '0.01000000' });
    indexer.config['NETWORK'] = 'regtest';
    data['NETWORK'] = 'regtest';
    if(opts.probe) data['FEE_PROBE'] = true;
    if(opts.batch) data['BATCH_VALUE_LEDGER'] = { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} };
    if(opts.xchain) data['TX_OUTPUTS'] = [];
    const statuses = [];
    indexer.indexerDb.createAirdrop.callsFake(async airdrop => statuses.push(airdrop['STATUS']));
    await handler.parse(PARAMS, data, null);
    return { statuses, legs: data['PROBE_NATIVE_FEE_LEGS'] };
}

describe('Airdrop FEE_PROBE per-leg native fee disclosure @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('lists each tallied leg\'s own fee under a probe while drawing nothing', async function () {
        const outcome = await runAirdrop({ probe: true });
        assert.deepStrictEqual(outcome.statuses, ['valid', 'valid']);
        assert.deepStrictEqual(outcome.legs, ['0.00100000', '0.00100000']);
    });

    it('adds no disclosure to a block AIRDROP, a BATCH leg or an XCHAIN-balance fee', async function () {
        const block = await runAirdrop();
        assert.deepStrictEqual(block.statuses, ['valid', 'invalid: fee output has zero value']);
        assert.strictEqual(block.legs, undefined);
        assert.strictEqual((await runAirdrop({ probe: true, batch: true })).legs, undefined);
        assert.strictEqual((await runAirdrop({ probe: true, xchain: true })).legs, undefined);
    });
});
