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
 * XChain Indexer - COIN Configuration - Bitcoin (BTC) 
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
        config['ISSUANCE_FEE_TOKEN']    = '1.00000000';
        config['ISSUANCE_FEE_SUBTOKEN'] = '0.50000000';

        // Set XCHAIN fee required per day for EXPIRATION items (orders, swaps, dispensers)
        config['EXPIRATION_FEE_FREE_DAYS'] = 182;          // 6 month listing is free (182 days)
        config['EXPIRATION_FEE_PER_DAY']   = '0.00547945'; // 2 XCHAIN / 365 days = 0.00547945 XCHAIN per day

		// Set network specific addresses
        switch(network){
            case 'mainnet':
                address['BURN']    = "1Muhahahahhahahahahahhahahauxh9QX";
                address['GAS']     = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8";
                address['DONATE1'] = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8"; // Protocol Development
                address['DONATE2'] = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8"; // Community Develoment
                break;
            case 'testnet':
                address['BURN']    = "mvCounterpartyXXXXXXXXXXXXXXW24Hef";
                address['GAS']     = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt";
                address['DONATE1'] = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt"; // Protocol Development
                address['DONATE2'] = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt"; // Community Develoment
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