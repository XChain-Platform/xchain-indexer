/*********************************************************************
 * XChain Indexer Configuration
 * 
 * This config file contains indexer specific configuration data
 * 
 * COIN specific configuration data is loaded from configs/<COIN>.js
 *
 ********************************************************************/

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

        // Reserved TICK names
        config['RESERVED_TICKS'] = [coin, gas];

        // Min/Max DECIMALS
        config['MIN_TOKEN_DECIMALS'] = 0;
        config['MAX_TOKEN_DECIMALS'] = 18;

        // Min/Max SUPPLY
        config['MIN_TOKEN_SUPPLY'] = 0.000000000000000001;
        config['MAX_TOKEN_SUPPLY'] = 1000000000000000000000;

        // Max DESCRIPTION length
        config['MAX_TOKEN_DESCRIPTION'] = 250;

        // Max MEMO length
        config['MAX_MEMO_LENGTH'] = 250;

        // MAX FILE lengths
        config['MAX_FILE_NAME_LENGTH']  = 250;
        config['MAX_FILE_TYPE_LENGTH']  = 255; // MAX MIME type length according to RFC 4288
        config['MAX_FILE_TITLE_LENGTH'] = 250;

        // Merge indexer config and COIN config into a single config object
        let fullConfig = Object.assign({}, config, coinConfig);

        return fullConfig;
    },

}