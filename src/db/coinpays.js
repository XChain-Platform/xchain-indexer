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
 * XChain Indexer - Database mixin: coinpays
 * 
 * The queries over the coinpays table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    //////////////////////////////////////////////////////////////////////////
    // COINPay Methods
    //////////////////////////////////////////////////////////////////////////

    // Create/Update record in `coinpay_obligations` table
    // @param {data} object COINPay obligation data
    async createCoinpayObligation(data){
        data = this.normalizeDataValues(data);
        let action_index     = data['ACTION_INDEX'];
        let payer_address_id = await this.createAddress(data['PAYER_ADDRESS']);
        let payee_address_id = await this.createAddress(data['PAYEE_ADDRESS']);
        let coin_id          = await this.createCoin(data['COIN']);
        let coin_amount      = data['COIN_AMOUNT'];
        let expiration       = data['EXPIRATION'];
        let block_index      = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_obligations
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_obligations
                    SET
                        payer_address_id=?,
                        payee_address_id=?,
                        coin_id=?,
                        coin_amount=?,
                        expiration=?,
                        block_index=?
                    WHERE
                        action_index=?`;
            args = [payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_obligations (action_index, payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index) values (?, ?, ?, ?, ?, ?, ?)`;
            args = [action_index, payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index];
        }
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `coinpay_statuses` table
    // @param {action_index}         integer Action index of action that caused this status change
    // @param {coinpay_action_index} integer Action index of the coinpay obligation (ORDER_MATCH action_index)
    // @param {status}               string  Status value (pending_coinpay/fulfilled/expired/cancelled)
    async createCoinpayStatus(action_index, coinpay_action_index, status){
        let status_id = await this.createStatus(status);
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_statuses
                        WHERE
                            action_index=? AND
                            coinpay_action_index=?`;
        let args = [action_index, coinpay_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_statuses
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        coinpay_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_statuses (status_id, action_index, coinpay_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, coinpay_action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `coinpay_expires` table
    // @param {action_index}            integer Action index of this COINPAY_EXPIRE action
    // @param {obligation_action_index} integer Action index of the coinpay obligation (ORDER_MATCH action_index)
    // @param {status}                  string  Status of the expire (valid/invalid)
    async createCoinpayExpire(action_index, obligation_action_index, status){
        let status_id = await this.createStatus(status);
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_expires
                        WHERE
                            action_index=? AND
                            obligation_action_index=?`;
        let args = [action_index, obligation_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_expires
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        obligation_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_expires (status_id, action_index, obligation_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, obligation_action_index];
        results = await this.doQuery(query, args);
    },

    // Get COINPay obligation info by action_index
    // @param {action_index} integer The ORDER_MATCH action_index that created the obligation
    async getCoinpayObligationInfo(action_index){
        let obligation = false;
        let query = `SELECT
                        co.action_index,
                        a1.address as payer_address,
                        a2.address as payee_address,
                        c1.coin,
                        co.coin_amount,
                        co.expiration,
                        co.block_index,
                        s2.status as coinpay_status
                    FROM
                        coinpay_obligations co
                        INNER JOIN index_addresses a1 ON (a1.id=co.payer_address_id)
                        INNER JOIN index_addresses a2 ON (a2.id=co.payee_address_id)
                        INNER JOIN index_coins     c1 ON (c1.id=co.coin_id)
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        co.action_index=?
                    LIMIT 1`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            obligation = {};
            for(let key in results[0]){
                let name  = String(key).toUpperCase();
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'EXPIRATION'].includes(name))
                    value = Number(value);
                obligation[name] = value;
            }
        }
        return obligation;
    },

    // Get all expired COINPay obligations (status=pending_coinpay and expiration < block_time)
    // @param {block_time} integer Current block timestamp
    async getExpiredCoinpayObligations(block_time){
        let expired = [];
        let query = `SELECT
                        co.action_index,
                        co.expiration
                    FROM
                        coinpay_obligations co
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        s2.status='pending_coinpay' AND
                        co.expiration < ?
                    ORDER BY co.action_index ASC`;
        let args = [block_time];
        let results = await this.doQuery(query, args);
        for(let row of results){
            expired.push({
                action_index: Number(row.action_index),
                expiration:   Number(row.expiration)
            });
        }
        return expired;
    },

    // Get pending COINPay obligations for a given order
    // @param {order_action_index} integer Action index of the order to check
    async getPendingCoinpayObligationsByOrder(order_action_index){
        let pending = [];
        let query = `SELECT
                        co.action_index
                    FROM
                        coinpay_obligations co
                        INNER JOIN order_matches om ON (om.action_index=co.action_index)
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        s2.status='pending_coinpay' AND
                        (om.give_action_index=? OR om.get_action_index=?)
                    ORDER BY co.action_index ASC`;
        let args = [order_action_index, order_action_index];
        let results = await this.doQuery(query, args);
        for(let row of results){
            pending.push(Number(row.action_index));
        }
        return pending;
    },

    // Create/Update record in `coinpays` table (fulfilled COINPay payments)
    // @param {data} object COINPay payment data
    async createCoinpay(data){
        data = this.normalizeDataValues(data);
        let action_index            = data['ACTION_INDEX'];
        let obligation_action_index = data['OBLIGATION_ACTION_INDEX'];
        let coin_amount             = data['COIN_AMOUNT'];
        let txid                    = data['TXID'];
        let vout                    = data['VOUT'];
        let status_id               = await this.createStatus(data['STATUS']);
        let block_index             = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpays
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpays
                    SET
                        obligation_action_index=?,
                        coin_amount=?,
                        txid=?,
                        vout=?,
                        status_id=?,
                        block_index=?
                    WHERE
                        action_index=?`;
            args = [obligation_action_index, coin_amount, txid, vout, status_id, block_index, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO coinpays (action_index, obligation_action_index, coin_amount, txid, vout, status_id, block_index) values (?, ?, ?, ?, ?, ?, ?)`;
            args = [action_index, obligation_action_index, coin_amount, txid, vout, status_id, block_index];
        }
        results = await this.doQuery(query, args);
    },

};
