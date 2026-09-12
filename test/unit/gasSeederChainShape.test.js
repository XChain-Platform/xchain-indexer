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
 * The integration gas preamble takes the shape the protocol allows on the
 * chain it seeds: a broadcast ISSUE + MINT on BTC (the only chain that mints
 * XCHAIN), an empty decoder block plus a pending bridge-shaped seed off BTC
 * (where actions/issue.js refuses every broadcast ISSUE of the gas tick).
 * These tests pin that dispatch without a database; the ledger effect of the
 * pending seed is exercised by the DB-backed scenarios (11, 14, 26).
 */

const assert = require('assert');
const { seedGas, pendingSystemGasAt, clearSystemGas, GAS_FUNDER, GAS_TICK } =
    require('../integration/setup/gas-seeder');

const A1 = 'mpAEYsk8fhxph1f8P9k7nYxfixstUr6LV9';
const A2 = 'mgNErQKtZ6V6ZZLrbdmtLBd5bHJzBDDC3L';

// A decoder seeder stand-in that records what would have been written.
function recordingSeeder() {
    const blocks = [];
    return { blocks, seedBlock: async (index, time, txs) => { blocks.push({ index, time, txs }); } };
}

describe('gas seeder: chain-shaped preamble', function () {
    let priorCoin;
    beforeEach(function () { priorCoin = process.env.INDEXER_COIN; clearSystemGas(); });
    afterEach(function () {
        if (priorCoin === undefined) delete process.env.INDEXER_COIN;
        else process.env.INDEXER_COIN = priorCoin;
        clearSystemGas();
    });

    it('on BTC seeds the broadcast ISSUE + MINT block and registers no system seed', async function () {
        process.env.INDEXER_COIN = 'BTC';
        const seeder = recordingSeeder();
        await seedGas(seeder, { addresses: [A1, A2] });
        assert.strictEqual(seeder.blocks.length, 1);
        const { index, txs } = seeder.blocks[0];
        assert.strictEqual(index, 99);
        assert.strictEqual(txs.length, 3);
        assert.strictEqual(txs[0].source, GAS_FUNDER);
        assert.ok(txs[0].data.startsWith('ISSUE|0|' + GAS_TICK + '|'), txs[0].data);
        assert.strictEqual(txs[1].data, 'MINT|0|' + GAS_TICK + '|100');
        assert.strictEqual(txs[2].source, A2);
        assert.strictEqual(pendingSystemGasAt(99), null);
    });

    it('an unset INDEXER_COIN is BTC, the launcher default', async function () {
        delete process.env.INDEXER_COIN;
        const seeder = recordingSeeder();
        await seedGas(seeder, { addresses: [A1] });
        assert.strictEqual(seeder.blocks[0].txs.length, 2);
        assert.strictEqual(pendingSystemGasAt(99), null);
    });

    for (const coin of ['LTC', 'DOGE']) {
        it(`on ${coin} seeds an EMPTY block and registers the bridge-shaped seed`, async function () {
            process.env.INDEXER_COIN = coin;
            const seeder = recordingSeeder();
            await seedGas(seeder, { addresses: [A1, A2], amount: '250', blockIndex: 42 });
            assert.strictEqual(seeder.blocks.length, 1, 'still one decoder block (contiguity)');
            assert.deepStrictEqual(seeder.blocks[0], { index: 42, time: 1699999000, txs: [] });
            assert.deepStrictEqual(pendingSystemGasAt(42), { addresses: [A1, A2], amount: '250' });
            assert.strictEqual(pendingSystemGasAt(99), null);
        });
    }

    it('system: true forces the bridge shape on BTC too', async function () {
        process.env.INDEXER_COIN = 'BTC';
        const seeder = recordingSeeder();
        await seedGas(seeder, { addresses: [A1], system: true });
        assert.deepStrictEqual(seeder.blocks[0].txs, []);
        assert.deepStrictEqual(pendingSystemGasAt(99), { addresses: [A1], amount: '100' });
    });

    it('the registered address list is a copy, not the caller\'s array', async function () {
        process.env.INDEXER_COIN = 'LTC';
        const addresses = [A1];
        await seedGas(recordingSeeder(), { addresses });
        addresses.push(A2);
        assert.deepStrictEqual(pendingSystemGasAt(99).addresses, [A1]);
    });

    it('clearSystemGas forgets every pending seed', async function () {
        process.env.INDEXER_COIN = 'DOGE';
        await seedGas(recordingSeeder(), { addresses: [A1] });
        assert.ok(pendingSystemGasAt(99));
        clearSystemGas();
        assert.strictEqual(pendingSystemGasAt(99), null);
    });
});
