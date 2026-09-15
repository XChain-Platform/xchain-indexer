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
 *
 * XChain Indexer - Database mixin part: transactions (decoder block data)
 *
 * The read of one block's transactions and outputs from the xchain-decoder database.
 * A part of the transactions mixin: src/db/transactions/index.js merges it into the one method
 * set that db/index.js installs onto Database.prototype, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// One row per (transaction, output) of the block, text unchanged from getDecoderBlockData.
const DECODER_BLOCK_SQL = `SELECT
                        t1.data,
                        t1.raw_data,
                        t2.hash as tx_hash,
                        a1.address as source,
                        a2.address as destination,
                        t1.fee,
                        t1.block_index,
                        b1.block_time,
                        t3.vout,
                        t3.amount as coin_amount,
                        a3.address as output_destination,
                        p1.pubkey as source_pubkey
                    FROM
                        transactions t1
                        INNER JOIN blocks              b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_transactions  t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN transaction_outputs t3 ON (t3.tx_index=t1.tx_index)
                        LEFT  JOIN index_addresses     a1 ON (a1.id=t1.source_id)
                        LEFT  JOIN index_addresses     a2 ON (a2.id=t1.destination_id)
                        LEFT  JOIN index_addresses     a3 ON (a3.id=t3.destination_id)
                        LEFT  JOIN pubkeys             p1 ON (p1.address_id=t1.source_id)
                    WHERE
                        t1.block_index=?
                    ORDER BY
                        t1.tx_index ASC,
                        t3.vout ASC`;

// First pass: collect the stored outputs for each transaction so every emitted row can
// carry the full output set. The indexer uses this for native-coin fee detection
// (xchain-indexer/src/utility.js detectFeePaymentMode / validateNativeCoinFee). The
// decoder persists the fee-destination output (and COINPAY/dispense outputs) to
// transaction_outputs. A module function over the Database instance, kept off the
// exported object so Database.prototype gains no method.
function collectOutputsByTx(db, results){
    let outputsByTx = {};
    for(let row of results){
        if(db.util.isNull(row.output_destination))
            continue;
        let key = row.tx_hash;
        if(!outputsByTx[key])
            outputsByTx[key] = [];
        outputsByTx[key].push({
            vout:    db.util.isNull(row.vout) ? 0 : row.vout,
            address: row.output_destination,
            value:   row.coin_amount
        });
    }
    for(let key in outputsByTx)
        outputsByTx[key].sort((a, b) => Number(a.vout) - Number(b.vout));
    return outputsByTx;
}

module.exports = {

    // Handle getting block transaction data for a given block from xchain-decoder database
    async getDecoderBlockData(block_index){
        let data = [];
        // doQueryStrict (not doQuery): this reads block transactions from decoderDb, which
        // never opens a transaction, so doQuery would collapse a transient read fault to []
        // - indistinguishable from a genuinely empty block. The caller would then commit an
        // empty block and advance lastIndexerBlock, permanently dropping every action in the
        // block and forking the hash chain. Throwing instead lets the block-level catch roll
        // back and retry (lastIndexerBlock stays un-advanced). A genuinely empty block still
        // returns [] via the length check below; only a failed query throws.
        let results = await this.doQueryStrict(DECODER_BLOCK_SQL, [block_index]);
        if(results.length > 0){
            let outputsByTx = collectOutputsByTx(this, results);

            for(let row of results){
                if(!this.util.isNull(row.output_destination))
                    row.destination = row.output_destination;
                row.amount = this.util.isNull(row.coin_amount) ? null : row.coin_amount;
                if(this.util.isNull(row.vout))
                    row.vout = 0;
                // Full output set for this transaction (used by native-coin fee validation)
                row.tx_outputs = outputsByTx[row.tx_hash] || [];
                delete row.output_destination;
                delete row.coin_amount;
                data.push(row);
            }
        }
        return data;
    },

};
