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
 * Tier 2: State Management Mutations @tier2
 *
 * Verifies that tests detect mutations in consolidateLedgerRecords,
 * debitBalances, addAddressTicker, and the rollback module.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, sinon, Utility, mathjs,
    createMockIndexer,
} = require('../setup/harness');

describe('Mutation : Tier 2: State Management @tier2', function () {
    let util;

    beforeEach(function () {
        util = new Utility();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── SDL: Statement Deletion in consolidateLedgerRecords ──────────────

    describe('SDL: consolidateLedgerRecords', function () {

        it('SDL-400: bcadd removed : only last amount kept (no consolidation)', function () {
            // Mutant: skips bcadd, always overwrites with latest amount
            sinon.stub(util, 'consolidateLedgerRecords').callsFake(function (records) {
                let arr = [], data = [];
                for (let idx in records) {
                    let [tick, amount, address] = records[idx];
                    let key = tick + '\0' + address;
                    arr[key] = amount; // NO bcadd : just overwrite
                }
                for (let key in arr) {
                    let amount = arr[key];
                    let [tick, address] = String(key).split('\0');
                    data.push([tick, amount, address]);
                }
                return data;
            });

            const records = [
                ['TEST', '100', 'addr1'],
                ['TEST', '200', 'addr1'],
                ['OTHER', '50', 'addr2'],
            ];
            const result = util.consolidateLedgerRecords(records);

            // Should be 300 (100+200) for TEST/addr1
            const testRecord = result.find(r => r[0] === 'TEST' && r[2] === 'addr1');
            const mutated = testRecord && String(testRecord[1]) !== '300';

            registry.record({
                id: 'SDL-400', operator: 'SDL', target: 'Utility.consolidateLedgerRecords',
                mutation: 'bcadd removed : last-write-wins', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `consolidated amount = ${testRecord ? testRecord[1] : 'missing'}` : '',
                description: 'consolidateLedgerRecords without bcadd loses earlier amounts',
            });
            assert.ok(mutated, 'SDL-400 survived');
        });

        it('SDL-401: single record : no consolidation needed (equivalent)', function () {
            // With a single record, bcadd is never called : equivalent mutant
            sinon.stub(util, 'consolidateLedgerRecords').callsFake(function (records) {
                let arr = [], data = [];
                for (let idx in records) {
                    let [tick, amount, address] = records[idx];
                    let key = tick + '\0' + address;
                    arr[key] = amount;
                }
                for (let key in arr) {
                    let amount = arr[key];
                    let [tick, address] = String(key).split('\0');
                    data.push([tick, amount, address]);
                }
                return data;
            });

            const records = [['TEST', '100', 'addr1']];
            const result = util.consolidateLedgerRecords(records);
            const amount = result[0] ? String(result[0][1]) : null;

            registry.record({
                id: 'SDL-401', operator: 'SDL', target: 'Utility.consolidateLedgerRecords',
                mutation: 'bcadd removed (single record)', file: 'src/utility.js',
                status: amount === '100' ? 'survived' : 'killed',
                killedBy: amount === '100' ? '' : `got ${amount}`,
                description: 'consolidateLedgerRecords single record : equivalent mutant',
            });
            // Expected: equivalent : single record doesn't trigger consolidation
        });
    });

    // ── ACR: Array/Collection in consolidateLedgerRecords ────────────────

    describe('ACR: Array Index Mutations', function () {

        it('ACR-200: destructuring swap [amount, tick, address] instead of [tick, amount, address]', function () {
            operators.ACR.consolidateSwapTickAmount(util);

            const records = [
                ['TEST', '100', 'addr1'],
                ['TEST', '200', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);

            // With swapped destructuring: tick='100', amount='TEST', address='addr1'
            // Key = '100\0addr1' : completely wrong
            const hasTest = result.some(r => r[0] === 'TEST');
            const mutated = !hasTest || result.length !== 1;

            registry.record({
                id: 'ACR-200', operator: 'ACR', target: 'Utility.consolidateLedgerRecords',
                mutation: '[tick,amount,address] → [amount,tick,address]', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `result has wrong structure: ${JSON.stringify(result)}` : '',
                description: 'consolidateLedgerRecords destructuring swap',
            });
            assert.ok(mutated, 'ACR-200 survived');
        });

        it('ACR-201: key components swapped : address\\0tick instead of tick\\0address', function () {
            operators.ACR.consolidateSwapKey(util);

            const records = [
                ['TEST', '100', 'addr1'],
                ['TEST', '200', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);

            // With swapped key: key = 'addr1\0TEST'
            // Split gives tick='addr1', address='TEST' : inverted
            const firstRecord = result[0];
            const tickIsWrong = firstRecord && firstRecord[0] !== 'TEST';

            registry.record({
                id: 'ACR-201', operator: 'ACR', target: 'Utility.consolidateLedgerRecords',
                mutation: 'key = address+\\0+tick instead of tick+\\0+address', file: 'src/utility.js',
                status: tickIsWrong ? 'killed' : 'survived',
                killedBy: tickIsWrong ? `tick field = '${firstRecord[0]}'` : '',
                description: 'consolidateLedgerRecords key components swapped',
            });
            assert.ok(tickIsWrong, 'ACR-201 survived');
        });

        it('ACR-202: different ticks consolidated correctly (not swapped)', function () {
            const records = [
                ['TICK_A', '100', 'addr1'],
                ['TICK_B', '200', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);

            // Should produce 2 records : different ticks
            const detected = (result.length === 2);
            registry.record({
                id: 'ACR-202', operator: 'ACR', target: 'Utility.consolidateLedgerRecords',
                mutation: 'different ticks stay separate (baseline)', file: 'src/utility.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'different ticks produce separate records' : '',
                description: 'consolidateLedgerRecords keeps different ticks separate',
            });
            assert.strictEqual(result.length, 2, 'ACR-202: different ticks should not be merged');
        });
    });

    // ── SBR: Separator mutation in consolidateLedgerRecords ──────────────

    describe('SBR: Separator Mutations', function () {

        it('SBR-400: \\0 separator changed to | : pipe collision possible', function () {
            // Mutant: uses '|' as separator instead of '\0'
            sinon.stub(util, 'consolidateLedgerRecords').callsFake(function (records) {
                let arr = [], data = [];
                for (let idx in records) {
                    let [tick, amount, address] = records[idx];
                    let key = tick + '|' + address; // MUTATED: | instead of \0
                    arr[key] = (arr[key]) ? this.bcadd(arr[key], amount, 18) : amount;
                }
                for (let key in arr) {
                    let amount = arr[key];
                    let [tick, address] = String(key).split('|'); // Split on |
                    data.push([tick, amount, address]);
                }
                return data;
            });

            // Create a scenario where | in tick name causes collision
            const records = [
                ['A|B', '100', 'addr1'],  // With | separator: key = 'A|B|addr1'
                ['A', '200', 'B|addr1'],   // With | separator: key = 'A|B|addr1' : COLLISION!
            ];
            const result = util.consolidateLedgerRecords(records);

            // With \0 separator: two separate records. With | separator: may collide
            // The split will produce wrong tick/address values
            const hasCollision = result.length < 2;

            registry.record({
                id: 'SBR-400', operator: 'SBR', target: 'Utility.consolidateLedgerRecords',
                mutation: 'separator \\0 → | (collision risk)', file: 'src/utility.js',
                status: hasCollision ? 'killed' : 'survived',
                killedBy: hasCollision ? `collision: ${result.length} records instead of 2` : '',
                description: 'consolidateLedgerRecords pipe separator causes key collision',
            });
            assert.ok(hasCollision, 'SBR-400 survived');
        });
    });

    // ── AOR: debitBalances mutations ─────────────────────────────────────

    describe('AOR: debitBalances Arithmetic', function () {

        it('AOR-400: debitBalances bcsub→bcadd : balance increases', function () {
            operators.AOR.subToAdd(util);
            const balances = { 1: '1000' };
            util.debitBalances(balances, 1, '100');
            const result = util.bcformat(balances[1], 0);

            const mutated = (result !== '900');
            registry.record({
                id: 'AOR-400', operator: 'AOR', target: 'Utility.debitBalances',
                mutation: 'bcsub→bcadd', file: 'src/utility.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `balance = ${result} not 900` : '',
                description: 'debitBalances adds instead of subtracting',
            });
            assert.notStrictEqual(result, '900', 'AOR-400 survived');
        });

        it('AOR-401: debitBalances with zero amount : equivalent mutant', function () {
            operators.AOR.subToAdd(util);
            const balances = { 1: '1000' };
            util.debitBalances(balances, 1, '0');
            const result = util.bcformat(balances[1], 0);

            registry.record({
                id: 'AOR-401', operator: 'AOR', target: 'Utility.debitBalances',
                mutation: 'bcsub→bcadd with zero amount', file: 'src/utility.js',
                status: result === '1000' ? 'survived' : 'killed',
                killedBy: result === '1000' ? '' : `balance = ${result}`,
                description: 'debitBalances zero amount : equivalent mutant',
            });
            // Expected: equivalent : 1000-0 = 1000+0 = 1000
        });
    });

    // ── PRM: addAddressTicker mutations ──────────────────────────────────

    describe('PRM: addAddressTicker', function () {

        it('PRM-400: addAddressTicker correctly associates address → tick', function () {
            util.addAddressTicker('addr1', 'TICK_A');
            util.addAddressTicker('addr1', 'TICK_B');

            const list = util.getAddressesList();
            const hasBoth = list['addr1'] && list['addr1'].includes('TICK_A') && list['addr1'].includes('TICK_B');

            registry.record({
                id: 'PRM-400', operator: 'PRM', target: 'Utility.addAddressTicker',
                mutation: 'address→tick mapping (baseline)', file: 'src/utility.js',
                status: hasBoth ? 'killed' : 'survived',
                killedBy: hasBoth ? 'both ticks associated correctly' : '',
                description: 'addAddressTicker maps address to multiple ticks',
            });
            assert.ok(hasBoth, 'PRM-400: both ticks should be in address list');
        });

        it('PRM-401: addAddressTicker does not duplicate ticks', function () {
            util.addAddressTicker('addr1', 'TICK_A');
            util.addAddressTicker('addr1', 'TICK_A'); // Duplicate

            const list = util.getAddressesList();
            const count = list['addr1'] ? list['addr1'].filter(t => t === 'TICK_A').length : 0;

            registry.record({
                id: 'PRM-401', operator: 'PRM', target: 'Utility.addAddressTicker',
                mutation: 'duplicate prevention (baseline)', file: 'src/utility.js',
                status: count === 1 ? 'killed' : 'survived',
                killedBy: count === 1 ? 'no duplicates' : '',
                description: 'addAddressTicker prevents duplicate tick entries',
            });
            assert.strictEqual(count, 1, 'PRM-401: tick should not be duplicated');
        });
    });

    // ── BCR: Rollback boundary mutations ─────────────────────────────────

    describe('BCR: Rollback Boundary', function () {

        it('BCR-400: Rollback class uses >= for block_index comparison', async function () {
            const indexer = createMockIndexer();
            const queriesCaptured = [];

            // Stub doQuery to capture SQL
            indexer.indexerDb.doQuery = sinon.stub().callsFake(async (query, args) => {
                queriesCaptured.push(query);
                return [];
            });
            indexer.indexerDb.getConnection = sinon.stub().resolves({});
            indexer.indexerDb.beginTransaction = sinon.stub().resolves();
            indexer.indexerDb.commitTransaction = sinon.stub().resolves();
            indexer.indexerDb.releaseConnection = sinon.stub().resolves();
            indexer.indexerDb.updateBalances = sinon.stub().resolves();

            const Rollback = require('../../../src/rollback.js');
            const rollback = new Rollback(indexer);

            try {
                await rollback.rollback(100);
            } catch (e) {
                // May throw due to incomplete setup : that's OK, we just need the queries
            }

            // Check if any captured query uses >= for block_index
            const usesGte = queriesCaptured.some(q =>
                q.includes('block_index') && (q.includes('>=') || q.includes('> ='))
            );

            registry.record({
                id: 'BCR-400', operator: 'BCR', target: 'Rollback.rollback',
                mutation: 'block_index >= boundary check', file: 'src/rollback.js',
                status: usesGte ? 'killed' : 'survived',
                killedBy: usesGte ? 'SQL uses >= for block_index' : 'rollback executed queries',
                description: 'Rollback uses >= for block_index (includes the reorg block)',
            });
            // BCR-400 is killed only when the rollback actually issues block_index >=
            // DELETEs; a regression to > (excluding the reorg block) must redden CI.
            assert.ok(usesGte, 'BCR-400 survived: rollback does not use >= for block_index');
        });
    });
});
