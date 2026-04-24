/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Indexer - Actions class
 * 
 * This class loads up all action classes and sets up handlers to process transactions
 *
 * The XChain Indexer actions are defined in the specifications at :
 * https://github.com/XChain-platform/xchain-documentation/blob/master/actions/README.md
 * 
 ********************************************************************/

// Load indexer actions
const address          = require('./actions/address.js');
const airdrop          = require('./actions/airdrop.js');
const batch            = require('./actions/batch.js');
// const bet              = require('./actions/bet.js');
const broadcast        = require('./actions/broadcast.js');
const callback         = require('./actions/callback.js');
const coinpay          = require('./actions/coinpay.js');
const coinpay_expire   = require('./actions/coinpay_expire.js');
const destroy          = require('./actions/destroy.js');
const dispenser        = require('./actions/dispenser.js');
const dispenser_close  = require('./actions/dispenser_close.js');
const dispenser_expire = require('./actions/dispenser_expire.js');
const dispense         = require('./actions/dispense.js');
const dividend         = require('./actions/dividend.js');
const file             = require('./actions/file.js');
const issue            = require('./actions/issue.js');
const link             = require('./actions/link.js');
const list             = require('./actions/list.js');
const message          = require('./actions/message.js');
const mint             = require('./actions/mint.js');
const order            = require('./actions/order.js');
const order_expire     = require('./actions/order_expire.js');
const order_match      = require('./actions/order_match.js');
const sleep            = require('./actions/sleep.js');
const send             = require('./actions/send.js');
const swap             = require('./actions/swap.js');
const swap_expire      = require('./actions/swap_expire.js');
const swap_match       = require('./actions/swap_match.js');
const sweep            = require('./actions/sweep.js');
const unknown          = require('./actions/unknown.js');

// VM actions
const deploy             = require('./actions/deploy.js');
const execute            = require('./actions/execute.js');
const deposit            = require('./actions/deposit.js');
const withdraw           = require('./actions/withdraw.js');

// VM runtime
let XChainVM;
try {
    XChainVM = require('xchain-vm');
} catch(e) {
    console.log('WARNING: xchain-vm not available — DEPLOY/EXECUTE will not run contract code');
}

// Staking actions
const stake              = require('./actions/stake.js');
const unstake            = require('./actions/unstake.js');
const delegate           = require('./actions/delegate.js');
const revoke_delegation  = require('./actions/revoke_delegation.js');
const claim_rewards      = require('./actions/claim_rewards.js');

// PRICE action (validator snapshots and user oracle prices)
const price              = require('./actions/price.js');

class Actions {

    // Handle constructing a class instance
    constructor(indexer){
        // Parse in indexer configuration
        this.config    = indexer.config;

        // Setup alias to the utility class instance
        this.util      = indexer.util;

        // Setup alias to the mapper class instance
        this.mapper    =  indexer.mapper;

        // Setup alias to the indexer database connection
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;
        this.hubDb     = indexer.hubDb || null;

        // Setup alias to the hub client (for pushing PRICE data to xchain-hub)
        this.hubClient = indexer.hubClient || null;

        // Setup alias to the indexer protocol changes instance
        this.protocolChanges = indexer.protocolChanges;

        // Setup alias to the xchain-utxo-tracker client (used by DISPENSER fresh-address check)
        this.utxoTracker = indexer.utxoTracker || null;

        // Create action instances and pass database connections
        this.actionAddress         = new address(this);
        this.actionAirdrop         = new airdrop(this);
        this.actionBatch           = new batch(this);
        // this.actionBet             = new bet(this);
        this.actionBroadcast       = new broadcast(this);
        this.actionCallback        = new callback(this);
        this.actionCoinpay         = new coinpay(this);
        this.actionCoinpayExpire   = new coinpay_expire(this);
        this.actionDestroy         = new destroy(this);
        this.actionDispenser       = new dispenser(this);
        this.actionDispenserClose  = new dispenser_close(this);
        this.actionDispenserExpire = new dispenser_expire(this);
        this.actionDispense        = new dispense(this);
        this.actionFile            = new file(this);
        this.actionDividend        = new dividend(this);
        this.actionIssue           = new issue(this);
        this.actionLink            = new link(this);
        this.actionList            = new list(this);
        this.actionMessage         = new message(this);
        this.actionMint            = new mint(this);
        this.actionOrder           = new order(this);
        this.actionOrderExpire     = new order_expire(this);
        this.actionOrderMatch      = new order_match(this);
        this.actionSleep           = new sleep(this);
        this.actionSend            = new send(this);
        this.actionSwap            = new swap(this);
        this.actionSwapExpire      = new swap_expire(this);
        this.actionSwapMatch       = new swap_match(this);
        this.actionSweep           = new sweep(this);
        this.actionUnknown         = new unknown(this);

        // VM runtime
        if(XChainVM){
            this.vm = new XChainVM({
                gasSchedule: this.config['GAS_SCHEDULE'],
                gasCeiling:  1000000,
                limits: {
                    maxCpuTimeMs:      30000,
                    maxMemory:         8,
                    maxEmissions:      50,
                    maxStateKeys:      10000,
                    maxStateValueSize: 65536,
                    maxCodeSize:       65536
                }
            });
        } else {
            this.vm = null;
        }

        // VM action instances
        this.actionDeploy           = new deploy(this);
        this.actionExecute          = new execute(this);
        this.actionDeposit          = new deposit(this);
        this.actionWithdraw         = new withdraw(this);

        // Staking action instances
        this.actionStake            = new stake(this);
        this.actionUnstake          = new unstake(this);
        this.actionDelegate         = new delegate(this);
        this.actionRevokeDelegation = new revoke_delegation(this);
        this.actionClaimRewards     = new claim_rewards(this);

        // PRICE action instance
        this.actionPrice            = new price(this);

        // Define ACTION aliases
        this.actionAliases = {};

        // Legacy BRC20 formats
        this.actionAliases['TRANSFER'] = 'SEND';

        // Short aliases
        this.actionAliases['ADDR'] = 'ADDRESS';
        this.actionAliases['DROP'] = 'AIRDROP';
        this.actionAliases['CAST'] = 'BROADCAST';
        this.actionAliases['MSG']  = 'MESSAGE';

    }

    // Generalized function to handle processing a transaction
    // @param tx             object     Transaction object
    // @param tx.source      string     Source address
    // @param tx.data        string     Action `data`
    // @param tx.tx_hash     string     Transaction hash
    // @param tx.block_index integer    Block index of tx
    async processTransaction(tx){
        let error       = false;
        let params      = String(tx.data).split('|');
        let source      = tx.source;
        let destination = tx.destination;
        let amount      = tx.amount;
        let tx_hash     = tx.tx_hash;
        let tx_data     = tx.data;
        let tx_vout     = tx.vout;
        let coin        = this.config['COIN'];
        let block_index = tx.block_index;
        let block_time  = tx.block_time;

        // Create database records and get ids for tx_hash and source address
        await Promise.all([
            this.indexerDb.createAddress(source),
            this.indexerDb.createAddress(destination),
            this.indexerDb.createTransaction(tx_hash)
        ]);

        // Trim whitespace from any PARAMS
        params.forEach(function(value, idx){
            params[idx] = String(value).trim();
        });

        // Extract ACTION from PARAMS
        let action = String(params.shift()).toUpperCase();

        // Set correct ACTION for any aliases
        for(var alias in this.actionAliases){
            if(action==alias)
                action = this.actionAliases[alias];
        }

        // Support legacy ACTION format with no VERSION (default to VERSION 0)
        // TODO: Disable this hack before release (LEGACY version is only in BTNS)
        if(['ISSUE','MINT','SEND'].includes(action) && this.util.isLegacyActionFormat(params))
            params.splice(0,0,0);

        // Extract FORMAT from PARAMS
        let format = this.util.getFormatVersion(params[0]);

        // Define basic ACTION transaction data object
        let data = {};
        data['ACTION']           = action;      // Action (ISSUE, MINT, SEND, etc)
        data['FORMAT']           = format;      // Action FORMAT (0-255)
        data['BLOCK_INDEX']      = block_index; // Block index 
        data['BLOCK_TIME']       = block_time;  // Block time (seconds since epoch) 
        data['SOURCE']           = source;      // Source address
        data['COIN']             = coin;        // COIN network
        data['COIN_DESTINATION'] = destination; // COIN Destination address
        data['COIN_AMOUNT']      = amount;      // Amount of native COIN
        data['TX_HASH']          = tx_hash;     // Transaction Hash
        data['TX_VOUT']          = tx_vout;     // Transaction vout index
        data['TX_DATA']          = tx_data;     // Raw tx data string

        // Validate Action is known
        if(!this.protocolChanges.isDefined(action)){
            error = 'invalid: Unknown ACTION';
            data['ACTION'] = action = 'UNKNOWN';
        }

        // Verify ACTION is activated
        if(!error && await this.protocolChanges.isEnabled(action, tx.block_index) == false)
            error = 'invalid: ACTION is not yet activated';

        // Create a record of this transaction in the transactions table
        data['TX_INDEX'] = await this.indexerDb.createTxIndex(data);

        // Create a record of this action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(data);

        // DEBUG : Force a specific action
        // action = 'DIVIDEND';

        // Process the specific ACTION commands
        await this.processAction(action, params, data, error);
    }

    // Generalized function to handle parsing and processing a specific ACTION
    // NOTE: If the action is UNKNOWN, fail silently (prevent crashing indexer on unsupported actions)
    async processAction(action, params, data, error){
        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // Process the action with the correct handler
        if(action=='ADDRESS')            await this.actionAddress.parse(params, data, error);
        if(action=='AIRDROP')            await this.actionAirdrop.parse(params, data, error);
        if(action=='BATCH')              await this.actionBatch.parse(params, data, error);
        // if(action=='BET')                await this.actionBet.parse(params, data, error);
        if(action=='BROADCAST')          await this.actionBroadcast.parse(params, data, error);
        if(action=='CALLBACK')           await this.actionCallback.parse(params, data, error);
        if(action=='COINPAY')             await this.actionCoinpay.parse(params, data, error);
        if(action=='COINPAY_EXPIRE')     await this.actionCoinpayExpire.parse(params, data, error);
        if(action=='DESTROY')            await this.actionDestroy.parse(params, data, error);
        if(action=='DISPENSER')          await this.actionDispenser.parse(params, data, error);
        if(action=='DISPENSER_CLOSE')    await this.actionDispenserClose.parse(params, data, error);
        if(action=='DISPENSER_EXPIRE')   await this.actionDispenserExpire.parse(params, data, error);
        if(action=='DISPENSE')           await this.actionDispense.parse(params, data, error);
        if(action=='DIVIDEND')           await this.actionDividend.parse(params, data, error);
        if(action=='FILE')               await this.actionFile.parse(params, data, error);
        if(action=='ISSUE')              await this.actionIssue.parse(params, data, error);
        if(action=='LIST')               await this.actionList.parse(params, data, error);
        if(action=='LINK')               await this.actionLink.parse(params, data, error);
        if(action=='MINT')               await this.actionMint.parse(params, data, error);
        if(action=='MESSAGE')            await this.actionMessage.parse(params, data, error);
        if(action=='ORDER')              await this.actionOrder.parse(params, data, error);
        if(action=='ORDER_EXPIRE')       await this.actionOrderExpire.parse(params, data, error);
        if(action=='ORDER_MATCH')        await this.actionOrderMatch.parse(params, data, error);
        if(action=='SLEEP')              await this.actionSleep.parse(params, data, error);
        if(action=='SEND')               await this.actionSend.parse(params, data, error);
        if(action=='SWAP')               await this.actionSwap.parse(params, data, error);
        if(action=='SWAP_EXPIRE')        await this.actionSwapExpire.parse(params, data, error);
        if(action=='SWAP_MATCH')         await this.actionSwapMatch.parse(params, data, error);
        if(action=='SWEEP')              await this.actionSweep.parse(params, data, error);
        if(action=='UNKNOWN')            await this.actionUnknown.parse(params, data, error);

        // VM actions
        if(action=='DEPLOY')             await this.actionDeploy.parse(params, data, error);
        if(action=='EXECUTE')            await this.actionExecute.parse(params, data, error);
        if(action=='DEPOSIT')            await this.actionDeposit.parse(params, data, error);
        if(action=='WITHDRAW')           await this.actionWithdraw.parse(params, data, error);

        // Staking actions
        if(action=='STAKE')              await this.actionStake.parse(params, data, error);
        if(action=='UNSTAKE')            await this.actionUnstake.parse(params, data, error);
        if(action=='DELEGATE')           await this.actionDelegate.parse(params, data, error);
        if(action=='REVOKE_DELEGATION')  await this.actionRevokeDelegation.parse(params, data, error);
        if(action=='CLAIM_REWARDS')      await this.actionClaimRewards.parse(params, data, error);

        // PRICE action (validator snapshots and user oracles)
        if(action=='PRICE')              await this.actionPrice.parse(params, data, error);
    }

}

module.exports = Actions;
