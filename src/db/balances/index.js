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
 * XChain Indexer - Database mixin: balances
 * 
 * The queries over the balances table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');
const path    = require('path');
const ledgerPrecision = require('../../consensus/ledger_amount_precision_gate');

const { getLogger } = require('../../observability/index.js');
module.exports = {

    // Get token supply for a given ticker from balances table
    async getTokenSupplyBalance(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Sum at the EXACT ledger scale (18 dp) and round ONCE at the tick's own scale,
        // the shape sanityCheck's balances projection uses. A per-row cast to the tick's
        // decimals is round(A)+round(B), which is not round(A+B) once the ledger carries
        // amounts finer than the tick (consensus/ledger_amount_precision_gate.js).
        let query = `SELECT ` + ledgerPrecision.exactSumSql('amount') + ` as supply FROM balances WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        // bcstr keeps the STRING contract this helper always had: a bare bignumber
        // stringifies below 1e-7 as '1e-8', which no consumer of an amount wants.
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = this.util.bcstr(this.util.bcadd(results[0].supply, 0, decimals));
        return supply;
    },

    // Handle updating address balances (credits-debits=balance)
    // @param {address}  boolean Full update
    // @param {address}  string  Address string
    // @param {address}  array   Array of address strings
    // @param {rollback} boolean Rollback
    async updateBalances(address, rollback){
        let addrs = [];
        let type  = typeof address;
        // Handle arrays and objects
        if(type==='object'){
            for(let addr of address){
                if(!this.util.isNull(addr) && addr!='')
                    addrs.push(addr);
            }
        }
        if(type==='string')
            addrs.push(address);
        // Dump full list of addresses
        if(type==='boolean' && address===true){
            getLogger().info('Updating all balances...');
            let query = "SELECT address FROM index_addresses";
            let results = await this.doQuery(query);
            if(results.length > 0)
                for(let row of results)
                    addrs.push(row.address);
        }
        // Loop through addresses and update balances SERIALLY. During block
        // processing these run on the single shared transaction connection
        // (getConnection() returns this.transactionConnection mid-transaction),
        // which cannot serve concurrent queries - a Promise.all here interleaves
        // each address's read-compute-write and corrupts balances (observed:
        // AIRDROP double-counted token supply, 200 != 100, tripping the supply
        // sanity check and crash-looping the indexer). The N+1->UPSERT win in
        // updateAddressBalance still applies; only the parallelism is unsafe.
        for(const addr of addrs)
            await this.updateAddressBalance(addr, rollback);
    },

    // Create/Update/Delete records in the 'balances' table
    async updateAddressBalance(address, rollback){
        let type        = typeof address;
        let address_id  = null;
        let balance     = 0;
        let old_balance = 0;
        let query       = false;
        let results     = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        // Get list of address balances based on credits/debits tables
        let balances = await this.getAddressBalances(address_id);
        // Get list of address balances based on balances table. Only the rollback
        // branch below reads this, so skip the query entirely on the forward path:
        // it is one wasted round-trip per touched address per action, and fan-out
        // actions (DIVIDEND / AIRDROP) run this loop once per holder. Keep the read
        // HERE rather than inside the rollback branch, since it must observe the
        // balances table BEFORE the UPSERT/DELETE loop rewrites it.
        let old_balances = (rollback) ? await this.getAddressTableBalances(address_id) : {};
        // Handle updating any current balances based on credits/debits table records
        for(let tick_id in balances){
            balance = balances[tick_id];
            let args = [];
            if(balance==0){
                query = "DELETE FROM balances WHERE address_id=? AND tick_id=?";
                args.push(address_id, tick_id);
            } else {
                // Convert BigNumber to a plain decimal string so the mariadb driver
                // serializes it correctly. Normal notation is required: String()
                // renders sub-1e-7 balances exponentially ("3e-8"), which the SMT
                // leaf encoder rejects (block wedge) and drifts the byte-form vs sync.
                balance = this.util.bcstr(balance);
                query = "INSERT INTO balances (tick_id, address_id, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)";
                args.push(tick_id, address_id, balance);
            }
            results = await this.doQuery(query, args);
        }
        // If this is a rollback, then handle detecting records in balances table which should not exist and delete them
        // TODO: Test this code a bit better with various random rollbacks and verify all is working without any sanity check issues
        if(rollback){
            for(let tick_id in old_balances){
                old_balance = old_balances[tick_id];
                balance     = balances[tick_id];
                if(!this.util.isNull(old_balance) && (this.util.isNull(balance) || balance==0 )){
                    query   = "DELETE FROM balances WHERE address_id=? AND tick_id=?";
                    results = await this.doQuery(query, [address_id, tick_id]);
                }
            }
        }
    },

    // Get address balances using balances table data
    async getAddressTableBalances(address){
        let type       = typeof address;
        let address_id = null;
        let balances   = {}; // Object to store tick/balance
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        let query = "SELECT tick_id, amount FROM balances WHERE address_id=?";
        let results = await this.doQuery(query, [address_id]);
        if(results.length > 0)
            for(let row of results)
                balances[row.tick_id] = row.amount;
        return balances;
    },

};
