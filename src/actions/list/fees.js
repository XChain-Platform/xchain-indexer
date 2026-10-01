'use strict';

const { isListShared } = require('../../db/lists/sharing.js');

module.exports = {
    async chargeFee(data, format, changes, error){
        if(error || data['IS_GENESIS'])
            return { error, fees: null };

        if(!this.isFormatActive(2, data))
            return { error, fees: null };

        let gasCost = null;
        if(format==2){
            gasCost = this.util.resolveGasScheduleCost('LIST_SHARE');
        } else if(format==1 && await isListShared(this.indexerDb, data['LIST_ACTION_INDEX'])){
            gasCost = this.util.getUnifiedBaseItemFee(
                changes,
                'LIST_SHARED_EDIT_BASE',
                'LIST_SHARED_EDIT_PER_ITEM'
            ).gasCost;
        }

        if(gasCost===null)
            return { error, fees: null };

        let balances = await this.indexerDb.getAddressBalances(
            data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']
        );
        let preferences = await this.indexerDb.getAddressPreferences(
            data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']
        );
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        fees['GAS_COST']    = gasCost;
        fees['AMOUNT']      = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);
        fees['FEE_VERSION'] = 2;

        if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(paymentMode === 'native'){
                let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    fees['PAYMENT_MODE']       = 1;
                    fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    fees['NATIVE_COIN']        = validation.nativeCoin;
                    fees['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(paymentMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        return { error, fees };
    },

    async settleFee(data, fee){
        if(!fee) return;

        let credits = [],
            debits  = [];

        this.util.addAddressTicker(data['SOURCE'], fee['TICK']);
        [credits, debits] = await this.util.processTransactionFees(
            this.indexerDb, credits, debits, fee
        );
        await this.util.processTransactionLedgerChanges(
            this.indexerDb, data, credits, debits
        );

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);
    },
};
