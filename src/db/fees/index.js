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
 * XChain Indexer - Database mixin: fees
 * 
 * The queries over the fees table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Read the fee row a handler staged for an action (createFeeRecord above). The feequote
    // dry-run calls this INSIDE its still-open forced-rollback transaction to extract the
    // handler-computed XCHAIN-denominated fee before the rollback discards the row; `amount`
    // is XCHAIN-denominated in every payment mode (mode 1 records the native output separately
    // in native_coin_amount). Returns null when the handler recorded no fee (zero-fee action,
    // or it rejected before fee processing).
    async getFeeRecord(actionIndex){
        if(this.util.isNull(actionIndex))
            return null;
        let query   = `SELECT amount, gas_cost, gas_price, xchain_amount, payment_mode FROM fees WHERE action_index=?`;
        let results = await this.doQuery(query, [actionIndex]);
        return (results && results.length > 0) ? results[0] : null;
    },

    // Create/Update record in `fees` table
    async createFeeRecord(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        let method         = data['METHOD'];
        // Unified gas fields (default to legacy values if not present)
        let gas_cost           = data['GAS_COST'] || 0;
        let gas_price          = data['GAS_PRICE'] || '0';
        let xchain_amount      = data['XCHAIN_AMOUNT'] || amount || '0';
        let payment_mode       = data['PAYMENT_MODE'] || 2;
        let fee_preference     = data['FEE_PREFERENCE'] || method || 2;
        let fee_version        = data['FEE_VERSION'] || 1;
        // Native coin fields (Track B - null for XCHAIN balance payments)
        let native_coin_amount = data['NATIVE_COIN_AMOUNT'] || null;
        let native_coin        = data['NATIVE_COIN'] || null;
        let oracle_round       = data['ORACLE_ROUND'] || null;
        // Check if record already exists
        let query = `SELECT action_index FROM fees WHERE action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE fees SET
                        tick_id=?, destination_id=?, amount=?, method=?,
                        gas_cost=?, gas_price=?, xchain_amount=?,
                        payment_mode=?, fee_preference=?, fee_version=?,
                        native_coin_amount=?, native_coin=?, oracle_round=?
                    WHERE action_index=?`;
            args = [tick_id, destination_id, amount, method,
                    gas_cost, gas_price, xchain_amount,
                    payment_mode, fee_preference, fee_version,
                    native_coin_amount, native_coin, oracle_round, action_index];
        } else {
            query = `INSERT INTO fees
                        (tick_id, destination_id, amount, method,
                         gas_cost, gas_price, xchain_amount,
                         payment_mode, fee_preference, fee_version,
                         native_coin_amount, native_coin, oracle_round, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [tick_id, destination_id, amount, method,
                    gas_cost, gas_price, xchain_amount,
                    payment_mode, fee_preference, fee_version,
                    native_coin_amount, native_coin, oracle_round, action_index];
        }
        results = await this.doQuery(query, args);
    },

};
