/* XChain Indexer Configuration */

module.exports = {

    // Handle returning the current indexer configuration
    getConfig: function(){

        // Set coin and network from environmental variables
        let gas     = 'XCHAIN';                     // TICK to be used as gas token
        let coin    = process.env.INDEXER_COIN;     // BTC / LTC / DOGE
        let network = process.env.INDEXER_NETWORK;  // mainnet / testnet / regtest

        // Define basic config object
        let config = {};

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

        // Reserved BTNS TICK names
        config['RESERVED_TICKS'] = [coin];

        // Min/Max DECIMALS
        config['MIN_TOKEN_DECIMALS'] = 0;
        config['MAX_TOKEN_DECIMALS'] = 18;

        // Min/Max SUPPLY
        config['MIN_TOKEN_SUPPLY'] = 0.000000000000000001;
        config['MAX_TOKEN_SUPPLY'] = 1000000000000000000000;

        // Max DESCRIPTION length
        config['MAX_TOKEN_DESCRIPTION'] = 250;

        // Address configurations
        // TODO : Generate BURN/GAS/DONATE addresses before launching XChain platform
        var coinNet = coin + '-' +  network,
            address = {};
        switch(coinNet){
            // Bitcoin
            case 'BTC-mainnet':
                address['BURN']    = "1Muhahahahhahahahahahhahahauxh9QX";
                address['GAS']     = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8";
                address['DONATE1'] = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8"; // Protocol Development
                address['DONATE2'] = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8"; // Community Develoment
                break;
            case 'BTC-testnet':
                address['BURN']    = "mvCounterpartyXXXXXXXXXXXXXXW24Hef";
                address['GAS']     = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt";
                address['DONATE1'] = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt"; // Protocol Development
                address['DONATE2'] = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt"; // Community Develoment
                break;
            case 'BTC-regtest':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
            // Litecoin
            case 'LTC-mainnet':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
            case 'LTC-testnet':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
            case 'LTC-regtest':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
            // Dogecoin
            case 'DOGE-mainnet':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
            case 'DOGE-testnet':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                break;
            case 'DOGE-regtest':
                address['BURN']    = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']     = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
        }
        config['ADDRESS'] = address;

        return config;
    },

}