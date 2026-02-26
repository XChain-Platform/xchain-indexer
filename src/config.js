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
 * XChain Indexer - Configuration
 * 
 * This config file contains indexer specific configuration data
 * 
 * COIN specific configuration data is loaded from configs/<COIN>.js
 *
 ********************************************************************/

// Load required libraries
const fs = require('fs');

module.exports = {

    // Handle returning the current indexer configuration
    getConfig: function(){

        // Set coin and network from environmental variables
        let gas     = 'XCHAIN';                     // TICK to be used as gas token
        let coin    = process.env.INDEXER_COIN;     // BTC / LTC / DOGE
        let network = process.env.INDEXER_NETWORK;  // mainnet / testnet / regtest

        // Define indexer and COIN config objects
        let config     = {};
        let coinConfig = {};

        // Define COIN specific configuration file
        let coinFile   = '/XChainIndexer/src/configs/' + coin + '.js';

        // Load COIN specific configuration file, or throw error
        if(fs.existsSync(coinFile)){
            let cfg    = require(coinFile);
            coinConfig = cfg.getConfig(network);
        } else {
            let error = 'Missing COIN config file : ' + coinFile;
            throw new Error(error);
        }

        // Define list of acceptable COIN networks
        config['COINS'] = ['BTC', 'LTC', 'DOGE'];

        // Define list of acceptable FIAT currencies
        config['FIATS']        = {};
        config['FIATS']['USD'] = 'US Dollar';
        config['FIATS']['CAD'] = 'Canadian Dollar';
        config['FIATS']['AUD'] = 'Austrailian Dollar';
        config['FIATS']['MXN'] = 'Mexican Peso';
        config['FIATS']['GBP'] = 'Great Britian Pound';
        config['FIATS']['JPY'] = 'Japanese Yen';
        config['FIATS']['CNY'] = 'Chinese Yuan';
        config['FIATS']['CHF'] = 'Swiss Franc';
        config['FIATS']['BRL'] = 'Brazillian Real';
        config['FIATS']['INR'] = 'Indian Rupee';

        // Parse in the gas / coin / network information
        config['GAS']     = gas;
        config['COIN']    = coin;
        config['NETWORK'] = network;

        // Native TICK 
        config['NATIVE_TICK']          = coin;
        config['NATIVE_TICK_DECIMALS'] = 8;

        // TICK Length
        config['MIN_TICK_LENGTH'] = 1;
        config["MAX_TICK_LENGTH"] = 250;

        // TICK characters allowed
        config['TICK_CHARACTERS'] = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~!@#$%^&*()_+-={}[]:<>.?';

        // Reserved TICK names (COIN names and GAS token)
        config['RESERVED_TICKS'] = config['COINS'].concat([gas]);

        // Min/Max DECIMALS
        config['MIN_TOKEN_DECIMALS'] = 0;
        config['MAX_TOKEN_DECIMALS'] = 18;

        // Min/Max SUPPLY (stored as strings to preserve full precision beyond Number.MAX_SAFE_INTEGER)
        config['MIN_TOKEN_SUPPLY'] = '0.000000000000000001';
        config['MAX_TOKEN_SUPPLY'] = '1000000000000000000000';

        // Max DESCRIPTION length
        config['MAX_TOKEN_DESCRIPTION'] = 250;

        // Max MEMO length
        config['MAX_MEMO_LENGTH'] = 250;

        // MAX FILE lengths
        config['MAX_FILE_NAME_LENGTH']  = 250;
        config['MAX_FILE_TYPE_LENGTH']  = 255; // MAX MIME type length according to RFC 4288
        config['MAX_FILE_TITLE_LENGTH'] = 250;

        // BROADCAST lengths
        config['MAX_BROADCAST_MESSAGE_LENGTH']  = 250;
        config['MAX_BROADCAST_VALUE_LENGTH']    = 25; 

        // MAX number of dispenses per dispenser
        config['MAX_DISPENSES'] = 1000;

        // MESSAGE encryption methods
        config['MESSAGE_ENCRYPTION_METHODS'] = [
            1, // Elliptic-curve Diffie–Hellman (ECDH) 
            2, // Advanced Encryption Standard (AES)
        ];

        // SLEEP Immediate methods
        config['SLEEP_IMMEDIATE_METHODS'] = [
            -1, // Sleep actions indefinitely
             0, // Resume actions immediately
        ];

        // Delay dispenser list updates by X seconds (1 hour)
        config['DISPENSER_LIST_DELAY'] = 3600;

        // Delay dispenser closing by X seconds (1 hour)
        config['DISPENSER_CLOSE_DELAY'] = 3600;

        // Max MESSAGE lengths
        config['MAX_MESSAGE_LENGTH']     = 1048576; // 1 MB = 1,048,576 Characters
        config['MAX_MESSAGE_KEY_LENGTH'] = 1048576; // 1 MB = 1,048,576 Characters

        // Define list of NUMBER fields
        config['NUMBER_FIELDS'] = [
            'ALLOW_LIST', 
            'AMOUNT', 
            'BALANCES',
            'BLOCK_LIST', 
            'BROADCAST_ACTION_INDEX',
            'CALLBACK_AMOUNT', 
            'CALLBACK_BLOCK', 
            'COIN1_ACTION_INDEX',
            'COIN2_ACTION_INDEX',
            'DECIMALS', 
            'DISPENSER_ACTION_INDEX',
            'EDIT',
            'ENCRYPTION_METHOD',
            'EXPIRATION', 
            'FEE',
            'FIAT_AMOUNT', 
            'GET_AMOUNT', 
            'GIVE_AMOUNT', 
            'GIVE_ESCROW', 
            'LIST_ACTION_INDEX',
            'MAX_SUPPLY', 
            'MAX_MINT', 
            'MINT_ADDRESS_MAX', 
            'MINT_START_BLOCK', 
            'MINT_STOP_BLOCK',
            'MINT_SUPPLY', 
            'ORDER_ACTION_INDEX',
            'OWNERSHIPS',
            'RESUME_BLOCK',
            'SWAP_ACTION_INDEX',
            'TRANSFER_SUPPLY', 
            'TYPE', 
            'VALUE',
        ];

        // Define list of LOCK fields
        config['LOCK_FIELDS'] = [
            'LOCK_MAX_SUPPLY',
            'LOCK_MINT',
            'LOCK_MINT_SUPPLY',
            'LOCK_MAX_MINT',
            'LOCK_DESCRIPTION',
            'LOCK_SLEEP',
            'LOCK_CALLBACK'
        ];        

        // Define list of LIST fields
        config['LIST_FIELDS'] = [
            'ALLOW_LIST',
            'BLOCK_LIST'
        ];

        // Define block parsing interval (10 seconds)
        config['BLOCK_CHECK_INTERVAL'] = 5000; 

        // Merge indexer config and COIN config into a single config object
        let fullConfig = Object.assign({}, config, coinConfig);

        return fullConfig;
    },

}