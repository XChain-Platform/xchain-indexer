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
const { openingPassesContext: baseContext } = require('./opening_passes.test/helpers/opening_passes_context.js');

const BLOCK = 9;
const TIME = 1700000000;

// regtest is an open network, so the launch gate admits every transaction here.
function openingPassesContext(opts = {}){
    return baseContext({ network: 'regtest', ...opts });
}

function threeTransactions(){
    return [{ tx_hash: 'a' }, { tx_hash: 'b' }, { tx_hash: 'c' }];
}

function run(ctx, blockTransactions){
    return ctx.runOpeningPasses({ blockToParse: BLOCK, blockTime: TIME, blockTransactions });
}

describe('drives the opening passes against a recording context', function () {
    it('records the exact call order for a three-transaction block', async function () {
        const { ctx, calls } = openingPassesContext();
        await run(ctx, threeTransactions());
        assert.deepStrictEqual(calls.map((c) => c[0]), [
            'vm.beginBlock', 'genesis.inject', 'delegation',
            'processTransaction', 'processTransaction', 'processTransaction'
        ]);
        assert.deepStrictEqual(calls[1], ['genesis.inject', BLOCK, TIME]);
        assert.deepStrictEqual(calls[2], ['delegation', BLOCK]);
    });

    it('records each transaction object itself in block order', async function () {
        const { ctx, calls } = openingPassesContext();
        const txs = threeTransactions();
        await run(ctx, txs);
        const seen = calls.filter((c) => c[0] === 'processTransaction');
        assert.strictEqual(seen.length, 3);
        seen.forEach((c, i) => assert.strictEqual(c[1], txs[i]));
    });

    it('drops only the beginBlock entry when vm is false', async function () {
        const { ctx, calls } = openingPassesContext({ vm: false });
        assert.strictEqual(ctx.actions.vm, undefined);
        await run(ctx, threeTransactions());
        assert.deepStrictEqual(calls.map((c) => c[0]), [
            'genesis.inject', 'delegation',
            'processTransaction', 'processTransaction', 'processTransaction'
        ]);
    });

    it('records only the genesis and delegation entries for an empty block', async function () {
        const { ctx, calls } = openingPassesContext({ vm: false });
        await run(ctx, []);
        assert.deepStrictEqual(calls.map((c) => c[0]), ['genesis.inject', 'delegation']);
    });

    it('propagates a processTransaction rejection with no later transaction recorded', async function () {
        const { ctx, calls } = openingPassesContext();
        const txs = threeTransactions();
        ctx.actions.processTransaction = async (tx) => {
            calls.push(['processTransaction', tx]);
            if(tx === txs[1])
                throw new Error('rejected');
        };
        await assert.rejects(run(ctx, txs), /rejected/);
        const seen = calls.filter((c) => c[0] === 'processTransaction').map((c) => c[1]);
        assert.deepStrictEqual(seen, [txs[0], txs[1]]);
    });
});
