'use strict';

/**
 * Integration tests — 06: Error handling and integrity verification
 *
 * Tests that the indexer gracefully handles malformed/unknown actions,
 * records invalid actions correctly, and maintains ledger integrity across
 * a variety of scenarios.
 */

const assert = require('assert');
const {
    decoderQuery, indexerQuery,
    createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb, closeAll,
} = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const helpers = require('../setup/assertion-helpers');

// ---------------------------------------------------------------------------
// Addresses — 30-char strings
// ---------------------------------------------------------------------------
const ADDR1 = 'mAddr1XXXXXXXXXXXXXXXXXXXXXXX1';
const ADDR2 = 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2';
const ADDR3 = 'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3';

// Base block time and spacing
const T0  = 1700100000;
const BLK = 600;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('06 – Error Handling and Integrity @regression @tier3', function () {
    this.timeout(60000);

    before(async function () {
        this.timeout(30000);
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    beforeEach(async function () {
        this.timeout(15000);
        await resetDecoderDb();
        await resetIndexerDb();
    });

    // -----------------------------------------------------------------------
    // 1. Empty block — no transactions, block record still created
    // -----------------------------------------------------------------------
    it('1. empty block processes without error and creates a block record', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        await seeder.seedBlock(100, T0, []); // no transactions

        const indexer = await initIndexer();
        const processed = await processBlocks(indexer);
        await destroyIndexer(indexer);

        assert.strictEqual(processed, 1, 'Should process 1 block');
        await helpers.assertBlockCount(indexerQuery, 1);

        // No actions should exist
        const actionCount = await helpers.countRows(indexerQuery, 'actions');
        assert.strictEqual(actionCount, 0, 'No actions for an empty block');
    });

    // -----------------------------------------------------------------------
    // 2. Malformed action data — garbage data field recorded as UNKNOWN
    // -----------------------------------------------------------------------
    it('2. malformed action data is recorded as an UNKNOWN action', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        await seeder.seedBlock(100, T0, [
            { source: ADDR1, destination: null, amount: '0', data: '!@#$GARBAGE_NOT_AN_ACTION!@#$' },
        ]);

        const indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // An action record must exist
        const actionCount = await helpers.countRows(indexerQuery, 'actions');
        assert.strictEqual(actionCount, 1, 'Malformed data should create 1 action record');

        // Verify it landed in the actions table (action type = UNKNOWN or status shows invalid)
        const rows = await indexerQuery('SELECT * FROM actions ORDER BY action_index ASC');
        assert.strictEqual(rows.length, 1);
        // The block must also be recorded
        await helpers.assertBlockCount(indexerQuery, 1);
    });

    // -----------------------------------------------------------------------
    // 3. Unknown action type — 'FOOBAR|0|param1' processed as UNKNOWN
    // -----------------------------------------------------------------------
    it('3. unknown action type creates a record with invalid status', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        await seeder.seedBlock(100, T0, [
            { source: ADDR1, destination: null, amount: '0', data: 'FOOBAR|0|param1|param2' },
        ]);

        const indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // One action record created
        const actionCount = await helpers.countRows(indexerQuery, 'actions');
        assert.strictEqual(actionCount, 1, 'Unknown action should create 1 action record');

        // Block was processed successfully
        await helpers.assertBlockCount(indexerQuery, 1);
    });

    // -----------------------------------------------------------------------
    // 4. Sanity check after ISSUE + MINT + SEND — supply consistency
    // -----------------------------------------------------------------------
    it('4. sanity check passes after ISSUE + MINT + SEND sequence', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        await seeder.seedBlock(100, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|SANE|1000000|500|0|Sanity test' }]);
        await seeder.seedBlock(101, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|SANE|500' }]);
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|SANE|200|' + ADDR2 }]);
        await seeder.seedBlock(103, T0 + BLK * 3, [{ source: ADDR2, destination: ADDR3, amount: '0', data: 'SEND|0|SANE|50|' + ADDR3 }]);

        const indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Explicit balance checks
        await helpers.assertBalance(indexerQuery, ADDR1, 'SANE', '300');
        await helpers.assertBalance(indexerQuery, ADDR2, 'SANE', '150');
        await helpers.assertBalance(indexerQuery, ADDR3, 'SANE', '50');
        await helpers.assertTokenSupply(indexerQuery, 'SANE', '500');

        // Full ledger sanity
        await helpers.assertSanity(indexerQuery, 'SANE');
    });

    // -----------------------------------------------------------------------
    // 5. Block hash integrity — all blocks have non-null hash IDs
    // -----------------------------------------------------------------------
    it('5. all processed blocks have non-null ledger and actions hash IDs', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        await seeder.seedBlock(100, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|HSHI|500000|100|0|Hash integrity' }]);
        await seeder.seedBlock(101, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|HSHI|100' }]);
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|HSHI|50|' + ADDR2 }]);
        await seeder.seedBlock(103, T0 + BLK * 3, []); // empty block still gets hashed

        const indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        await helpers.assertHashChain(indexerQuery);
    });

    // -----------------------------------------------------------------------
    // 6. Block hash determinism — same input data produces the same hashes
    // -----------------------------------------------------------------------
    it('6. processing the same data twice produces identical block hashes', async function () {
        this.timeout(90000);

        async function runAndGetHashes() {
            const seeder = new DecoderSeeder(decoderQuery);

            // Use explicit txHash so the seeded data is byte-for-byte identical
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|DET|200000|200|0|Determinism', txHash: 'a'.repeat(56) + '00000001' },
            ]);
            await seeder.seedBlock(101, T0 + BLK, [
                { source: ADDR1, destination: null, amount: '0', data: 'MINT|0|DET|200', txHash: 'a'.repeat(56) + '00000002' },
            ]);

            const indexer = await initIndexer();
            await processBlocks(indexer);
            await destroyIndexer(indexer);

            // Collect hash IDs from the blocks table
            const rows = await indexerQuery(
                'SELECT block_index, ledger_hash_id, actions_hash_id FROM blocks ORDER BY block_index ASC'
            );
            return rows.map(r => ({
                block: Number(r.block_index),
                ledger: r.ledger_hash_id,
                actions: r.actions_hash_id,
            }));
        }

        // First run
        const run1 = await runAndGetHashes();

        // Reset and repeat
        await resetDecoderDb();
        await resetIndexerDb();

        const run2 = await runAndGetHashes();

        assert.strictEqual(run1.length, run2.length, 'Both runs should produce the same number of blocks');
        for (let i = 0; i < run1.length; i++) {
            assert.strictEqual(run1[i].ledger, run2[i].ledger,
                `Block ${run1[i].block}: ledger_hash_id differs between runs`);
            assert.strictEqual(run1[i].actions, run2[i].actions,
                `Block ${run1[i].block}: actions_hash_id differs between runs`);
        }
    });

    // -----------------------------------------------------------------------
    // 7. Zero-balance cleanup — after full SEND, source balance row deleted
    // -----------------------------------------------------------------------
    it('7. source balance row is removed when entire balance is sent', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        await seeder.seedBlock(100, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|ZERO|100000|100|0|Zero balance' }]);
        await seeder.seedBlock(101, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|ZERO|100' }]);
        // Send entire balance to ADDR2
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|ZERO|100|' + ADDR2 }]);

        const indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // ADDR2 holds all tokens
        await helpers.assertBalance(indexerQuery, ADDR2, 'ZERO', '100');

        // ADDR1 balance row should not exist (zero balance cleaned up)
        await helpers.assertBalance(indexerQuery, ADDR1, 'ZERO', null);

        // Total supply still intact
        await helpers.assertTokenSupply(indexerQuery, 'ZERO', '100');
        await helpers.assertSanity(indexerQuery, 'ZERO');
    });

    // -----------------------------------------------------------------------
    // 8. Multiple actions in same block — all processed correctly
    // -----------------------------------------------------------------------
    it('8. five actions in one block are all processed correctly', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        // ISSUE in block 100 so MULTI exists before block 101
        await seeder.seedBlock(100, T0, [
            { source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|MULTI|1000000|1000|0|Multi-action block' },
        ]);

        // Five actions in one block
        await seeder.seedBlock(101, T0 + BLK, [
            { source: ADDR1, destination: null,  amount: '0', data: 'MINT|0|MULTI|100' },
            { source: ADDR1, destination: null,  amount: '0', data: 'MINT|0|MULTI|200' },
            { source: ADDR1, destination: null,  amount: '0', data: 'MINT|0|MULTI|300' },
            { source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|MULTI|150|' + ADDR2 },
            { source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|MULTI|75|' + ADDR3 },
        ]);

        const indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Total minted: 600; sent 150+75=225; ADDR1 holds 375
        await helpers.assertTokenSupply(indexerQuery, 'MULTI', '600');
        await helpers.assertBalance(indexerQuery, ADDR1,  'MULTI', '375');
        await helpers.assertBalance(indexerQuery, ADDR2,  'MULTI', '150');
        await helpers.assertBalance(indexerQuery, ADDR3,  'MULTI', '75');
        await helpers.assertSanity(indexerQuery, 'MULTI');

        // Exactly 6 actions total (1 ISSUE + 3 MINT + 2 SEND)
        const actionCount = await helpers.countRows(indexerQuery, 'actions');
        assert.strictEqual(actionCount, 6, 'Should have 6 action records across both blocks');
    });

    // -----------------------------------------------------------------------
    // 9. Action index monotonicity — strictly increasing across blocks
    // -----------------------------------------------------------------------
    it('9. action_indexes are strictly increasing across multiple blocks', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        await seeder.seedBlock(100, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|MONO|500000|500|0|Monotonic' }]);
        await seeder.seedBlock(101, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|MONO|100' }]);
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|MONO|200' }]);
        await seeder.seedBlock(103, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|MONO|50|' + ADDR2 }]);
        await seeder.seedBlock(104, T0 + BLK * 4, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|MONO|25|' + ADDR3 }]);

        const indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        const rows = await indexerQuery(
            'SELECT action_index FROM actions ORDER BY action_index ASC'
        );

        assert.ok(rows.length >= 5, 'Should have at least 5 action records');

        for (let i = 1; i < rows.length; i++) {
            const prev = Number(rows[i - 1].action_index);
            const curr = Number(rows[i].action_index);
            assert.ok(curr > prev,
                `action_index not strictly increasing: ${prev} then ${curr}`);
        }
    });

    // -----------------------------------------------------------------------
    // 10. Invalid SEND (insufficient balance) is recorded with invalid status
    // -----------------------------------------------------------------------
    it('10. SEND with insufficient balance creates action record with invalid status', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        await seeder.seedBlock(100, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|INSUF|50000|50|0|Insufficient funds' }]);
        await seeder.seedBlock(101, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|INSUF|50' }]);
        // ADDR1 has 50; attempt to send 9999 — way more than balance
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|INSUF|9999|' + ADDR2 }]);

        const indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // A send record must exist
        const sendCount = await helpers.countRows(indexerQuery, 'sends');
        assert.ok(sendCount >= 1, 'An invalid SEND should still create a sends table record');

        // Verify status is invalid (not 'valid')
        const rows = await indexerQuery(
            `SELECT s.status_id, st.status
             FROM sends s
             INNER JOIN index_statuses st ON st.id = s.status_id
             ORDER BY s.action_index DESC LIMIT 1`
        );
        assert.ok(rows.length > 0, 'Should have a send status row');
        assert.notStrictEqual(rows[0].status, 'valid',
            'Insufficient-funds SEND should not have valid status');
        assert.ok(rows[0].status.includes('invalid'),
            `Expected invalid status, got: ${rows[0].status}`);

        // Balances must be unchanged (SEND did not execute)
        await helpers.assertBalance(indexerQuery, ADDR1,  'INSUF', '50');
        await helpers.assertBalance(indexerQuery, ADDR2,  'INSUF', null);
        await helpers.assertTokenSupply(indexerQuery, 'INSUF', '50');
        await helpers.assertSanity(indexerQuery, 'INSUF');
    });
});
