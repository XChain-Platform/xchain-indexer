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
const {
    prelaunchInput,
    admittedTransactions
} = require('../../../src/XChainIndexer/block_admission.js');

const CTX = { network: 'mainnet', coin: 'BTC', blockTime: 1700000000 };

function sampleTransactions(){
    return [
        { tx_hash: 'a', source: 's1', data: 'A' },
        { tx_hash: 'b', source: 's2', data: 'B' },
        { tx_hash: 'c', source: 's3', data: 'C' }
    ];
}

describe('block admission', function () {
    it('filters block transactions through an admission predicate', function () {
        const txs = sampleTransactions();

        assert.deepStrictEqual(prelaunchInput(txs[1], CTX), {
            network: 'mainnet', coin: 'BTC', blockTime: 1700000000, data: 'B', source: 's2'
        });
        assert.throws(() => prelaunchInput(null, CTX), TypeError);
        assert.throws(() => prelaunchInput('tx', CTX), TypeError);

        const seen = [];
        const kept = admittedTransactions(txs, (input) => {
            seen.push(input);
            return input.data !== 'B';
        }, CTX);
        assert.deepStrictEqual(kept.map((tx) => tx.tx_hash), ['a', 'c']);
        assert.strictEqual(kept[0], txs[0]);
        assert.strictEqual(kept[1], txs[2]);
        assert.deepStrictEqual(seen.map((input) => input.source), ['s1', 's2', 's3']);
        assert.deepStrictEqual(seen[0], prelaunchInput(txs[0], CTX));

        for(const truthy of [1, 'true', {}, [], 'yes']){
            assert.deepStrictEqual(admittedTransactions(txs, () => truthy, CTX), []);
        }
        assert.deepStrictEqual(admittedTransactions(txs, () => false, CTX), []);
        assert.strictEqual(admittedTransactions(txs, () => true, CTX).length, 3);
        assert.deepStrictEqual(admittedTransactions([], () => true, CTX), []);

        assert.throws(() => admittedTransactions(txs, () => { throw new Error('boom'); }, CTX), /boom/);
        assert.throws(() => admittedTransactions(txs, null, CTX), TypeError);
        assert.throws(() => admittedTransactions(null, () => true, CTX), TypeError);
        assert.throws(() => admittedTransactions({}, () => true, CTX), TypeError);
    });
});
