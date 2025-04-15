/*********************************************************************
 * XChain COIN Configuration - Bitcoin (BTC) 
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