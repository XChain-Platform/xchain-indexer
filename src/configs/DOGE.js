/*********************************************************************
 * XChain COIN Configuration - Dogecoin (DOGE) 
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