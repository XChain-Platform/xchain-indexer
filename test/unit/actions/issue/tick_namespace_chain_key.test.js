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

// The ISSUE tick-namespace flag day is keyed per chain ('<COIN>:<network>') since the
// v0.20.0 arming train, with the bare network as the fallback, and src/actions/issue/
// wire.js must pass the chain being parsed into that lookup. The other ISSUE suites
// drive regtest or mainnet, where the per-chain and bare answers are the same flat
// number, so a chain argument dropped back to null left all of them green. These
// cases parse on LTC and DOGE testnet, where the per-chain height is armed and the
// bare testnet fallback is the dark sentinel, so the two answers differ and only the
// per-chain verdict passes.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const gateRegistry = require('../../../../src/consensus/gate_registry');
const { makeFormat0Params, makeData, buildIssue } = require('../token/issue.test/helpers/fixture.js');

const NAMESPACE_KEY = 'tick_namespace_activation.TICK_NAMESPACE_ACTIVATION';

// Parse a one-character new-token ISSUE on <coin> testnet at <height> and return its
// verdict. One character is under the namespace's four-character creation floor, so
// the verdict reads the flag directly: 'invalid: TICK (length)' when the namespace is
// active at that height on that chain, 'valid' when it is not. The issuance fee is
// switched off because every height here is above its mainnet flag day and the fee is
// not what these cases are about.
async function verdictOn(coin, height) {
    const { indexer, actionsCtx, handler } = buildIssue();
    indexer.config.NETWORK = 'testnet';
    indexer.config.COIN    = coin;
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => name !== 'ISSUANCE_FEE');
    const data = makeData({ FORMAT: 0, BLOCK_INDEX: height, COIN: coin });
    await handler.parse(makeFormat0Params({ TICK: 'A' }), data, null);
    return data.STATUS;
}

describe('ISSUE tick namespace keyed on the chain being parsed', function () {
    afterEach(function () { sinon.restore(); });

    for (const coin of ['LTC', 'DOGE']) {
        describe(coin + ' testnet', function () {
            const height = gateRegistry.get(NAMESPACE_KEY)[coin + ':testnet'];

            // Guards against a vacuous pass: if the registry ever keys this chain flat, or
            // the fallback arms, the per-chain and bare answers agree and the cases below
            // would stop telling the two apart.
            it('is a configuration where the per-chain answer differs from the bare network answer', function () {
                assert.ok(Number.isSafeInteger(height) && height > 0, coin + ':testnet has an armed height');
                assert.strictEqual(gateRegistry.activeAt(NAMESPACE_KEY, 'testnet', coin, height), true);
                assert.strictEqual(gateRegistry.activeAt(NAMESPACE_KEY, 'testnet', null, height), false);
            });

            it('refuses a one-character TICK at the chain\'s own namespace height', async function () {
                assert.strictEqual(await verdictOn(coin, height), 'invalid: TICK (length)');
            });

            it('still accepts it one block below that height', async function () {
                assert.strictEqual(await verdictOn(coin, height - 1), 'valid');
            });
        });
    }

    // BTC testnet arms far lower than LTC. A lookup keyed on the wrong chain would close
    // the namespace on LTC millions of blocks early and re-verdict mined ISSUEs there.
    it('does not apply BTC testnet\'s lower height to an LTC testnet block', async function () {
        const btc = gateRegistry.get(NAMESPACE_KEY)['BTC:testnet'];
        const ltc = gateRegistry.get(NAMESPACE_KEY)['LTC:testnet'];
        assert.ok(btc < ltc, 'BTC testnet arms below LTC testnet in block numbers');
        assert.strictEqual(await verdictOn('LTC', btc), 'valid');
    });
});
