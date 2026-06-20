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
 * Decoder DB seeder for integration tests.
 *
 * Populates the test decoder database with blocks, transactions, and
 * lookup records that simulate what xchain-decoder would produce.
 *
 * Usage:
 *   const seeder = new DecoderSeeder(decoderQuery);
 *   await seeder.seedBlock(100, 1700000000, [
 *       { source: 'addr1...', destination: null, amount: '0', data: 'ISSUE|0|TEST|1000|100|0' },
 *       { source: 'addr1...', destination: null, amount: '0', data: 'MINT|0|TEST|50' },
 *   ]);
 */

class DecoderSeeder {
    constructor(queryFn) {
        this.query = queryFn;
        this.txCounter = 0;
        this.addressCache = {};   // address string → id
        this.txHashCache = {};    // hash string → id
    }

    /** Reset internal counters (call between tests after DB truncate) */
    reset() {
        this.txCounter = 0;
        this.addressCache = {};
        this.txHashCache = {};
    }

    /** Get or create an address ID in decoder's index_addresses */
    async getOrCreateAddress(address) {
        if (!address) return null;
        if (this.addressCache[address]) return this.addressCache[address];
        // Try insert, ignore duplicate
        await this.query(
            'INSERT IGNORE INTO index_addresses (address) VALUES (?)', [address]
        );
        const rows = await this.query(
            'SELECT id FROM index_addresses WHERE address=?', [address]
        );
        const id = Number(rows[0].id);
        this.addressCache[address] = id;
        return id;
    }

    /** Get or create a tx hash ID in decoder's index_transactions */
    async getOrCreateTxHash(hash) {
        if (!hash) return null;
        if (this.txHashCache[hash]) return this.txHashCache[hash];
        await this.query(
            'INSERT IGNORE INTO index_transactions (hash) VALUES (?)', [hash]
        );
        const rows = await this.query(
            'SELECT id FROM index_transactions WHERE hash=?', [hash]
        );
        const id = Number(rows[0].id);
        this.txHashCache[hash] = id;
        return id;
    }

    /**
     * Generate a deterministic 64-char hex hash for a given index.
     * Produces unique, reproducible hashes like 'aaa...001', 'aaa...002'.
     */
    generateTxHash(index) {
        const suffix = String(index).padStart(8, '0');
        return 'a'.repeat(56) + suffix;
    }

    /**
     * Seed a complete block with its transactions into the decoder DB.
     *
     * @param {number} blockIndex - Block number
     * @param {number} blockTime  - Unix timestamp
     * @param {Array}  txs        - Array of tx objects:
     *   { source, destination, amount, data, txHash?, vout? }
     *   - source: source address string (required)
     *   - destination: destination address string (optional)
     *   - amount: native coin amount string (default '0')
     *   - data: pipe-delimited ACTION string (required)
     *   - txHash: override tx hash (default: auto-generated)
     *   - vout: override vout index (default: 0)
     */
    async seedBlock(blockIndex, blockTime, txs = []) {
        await this.query(
            'INSERT INTO blocks (block_index, block_time) VALUES (?, ?)',
            [blockIndex, blockTime]
        );

        for (const tx of txs) {
            this.txCounter++;
            const txHash = tx.txHash || this.generateTxHash(this.txCounter);
            const vout = tx.vout !== undefined ? tx.vout : 0;
            const amount = tx.amount || '0';

            const txHashId = await this.getOrCreateTxHash(txHash);
            const sourceId = await this.getOrCreateAddress(tx.source);
            const destId = await this.getOrCreateAddress(tx.destination);

            // Insert transaction. The canonical decoder schema's transactions.tx_index is a
            // plain PRIMARY KEY (not AUTO_INCREMENT; the decoder assigns it explicitly), so
            // we supply it from the monotonic counter rather than relying on insertId.
            const txIndex = this.txCounter;
            await this.query(
                `INSERT INTO transactions
                    (tx_index, tx_hash_id, block_index, source_id, destination_id, amount, data)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [txIndex, txHashId, blockIndex, sourceId, destId, amount, tx.data]
            );

            if (tx.destination || vout > 0) {
                const outputDestId = await this.getOrCreateAddress(tx.destination);
                await this.query(
                    `INSERT INTO transaction_outputs
                        (tx_index, vout, destination_id, amount)
                     VALUES (?, ?, ?, ?)`,
                    [txIndex, vout, outputDestId, amount]
                );
            }
        }
    }

    /**
     * Seed a REORG event in the decoder's events table.
     * @param {number[]} blockNumbers - Array of affected block numbers
     */
    async seedReorgEvent(blockNumbers) {
        await this.query(
            `INSERT INTO events (time, code, data) VALUES (NOW(), 'REORG', ?)`,
            [JSON.stringify(blockNumbers)]
        );
    }
}

module.exports = DecoderSeeder;
