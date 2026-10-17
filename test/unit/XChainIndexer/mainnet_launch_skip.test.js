// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { openingPassesContext } = require('./opening_passes.test/helpers/opening_passes_context.js');

const BLOCK = 9;
const PRELAUNCH = 1700000000;
const LAUNCH = 1798761600;

const txs = () => [
    { tx_hash: 'a', source: '1Other', data: 'SEND|0|x' },
    { tx_hash: 'b', source: '1Val', data: 'ANCHOR|0' },
    { tx_hash: 'c', source: '1Other', data: 'SEND|0|y' }
];

async function processed(network, blockTime){
    const { ctx, calls } = openingPassesContext({ network });
    await ctx.runOpeningPasses({ blockToParse: BLOCK, blockTime, blockTransactions: txs() });
    return calls.filter((c) => c[0] === 'processTransaction').map((c) => c[1].tx_hash);
}

describe('mainnet launch skip in the opening passes', function () {
    it('skips refused mainnet transactions before launch and keeps validator wire actions', async function () {
        assert.deepStrictEqual(await processed('mainnet', PRELAUNCH), ['b']);
    });

    it('admits every transaction at the launch instant', async function () {
        assert.deepStrictEqual(await processed('mainnet', LAUNCH), ['a', 'b', 'c']);
    });

    it('admits every transaction on open networks before launch', async function () {
        assert.deepStrictEqual(await processed('testnet', PRELAUNCH), ['a', 'b', 'c']);
    });

    it('still runs the opening passes when every transaction is refused', async function () {
        const { ctx, calls } = openingPassesContext();
        await ctx.runOpeningPasses({ blockToParse: BLOCK, blockTime: PRELAUNCH, blockTransactions: [txs()[0]] });
        assert.deepStrictEqual(calls.map((c) => c[0]), ['vm.beginBlock', 'genesis.inject', 'delegation']);
    });
});
