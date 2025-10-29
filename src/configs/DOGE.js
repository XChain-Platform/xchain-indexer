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
 * XChain Indexer - COIN Configuration - Dogecoin (DOGE) 
 * 
 * This config file contains COIN specific configuration information
 * 
 ********************************************************************/
module.exports = {

    // Handle returning the current coin configuration
    getConfig: function(network){

        // Define config objects
        let config  = {};
		let address = {};

        // Set XCHAIN fee required for token issuances
        config['ISSUANCE_FEE_TOKEN']    = '0.25000000';
        config['ISSUANCE_FEE_SUBTOKEN'] = '0.10000000';

        // Set XCHAIN fee required per day for EXPIRATION items (orders, swaps, dispensers)
        config['EXPIRATION_FEE_DEFAULT_DAYS'] = 90;           // 3 month listing is default
        config['EXPIRATION_FEE_FREE_DAYS']    = 182;          // 6 month listing is free (182 days)
        config['EXPIRATION_FEE_PER_DAY']      = '0.00136986'; // 0.5 XCHAIN / 365 days = 0.00136986 XCHAIN per day

		// Set network specific addresses
        switch(network){
            case 'mainnet':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
            case 'testnet':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
            case 'regtest':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
        }
        config['ADDRESS'] = address;

        return config;
    }
}