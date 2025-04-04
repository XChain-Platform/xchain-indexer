/*********************************************************************
 * XChain Indexer ACTION - AIRDROP
 * 
 * PARAMS:
 * - VERSION - Broadcast Format Version
 * - TICK    - 1 to 250 characters in length
 * - AMOUNT  - Amount of tokens to airdrop
 * - LIST    - `TX_HASH` of a BTNS `LIST`
 * - MEMO    - An optional memo to include
 * 
 * FORMATS:
 * - 0 = Single Airdrop
 * - 1 = Multi-Airdrop (Brief)
 * - 2 = Multi-Airdrop (Full)
 * - 3 = Multi-Airdrop (Full) with Multiple Memos
 * 
 ********************************************************************/

class Airdrop {

    // Handle constructing a class instance
    constructor(action){
        // Parse in indexer configuration
        this.config    = action.config;

        // Setup alias to the indexer database connections
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;

        // Setup alias to utility class
        this.util      = action.util;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|TICK|AMOUNT|LIST|MEMO';
        this.formats[1] = 'VERSION|LIST|TICK|AMOUNT|TICK|AMOUNT|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|LIST|TICK|AMOUNT|LIST|MEMO';
        this.formats[3] = 'VERSION|TICK|AMOUNT|LIST|MEMO|TICK|AMOUNT|LIST|MEMO';

        // Define array of list types (1=Tick, 2=Address)
        this.listTypes = [1,2];

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['AMOUNT'];

    }

    // Handle parsing the AIRDROP transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Single Airdrop
        // let str = '0|AIRDROPTEST1|1|fbe2a4946dfefb232571d56ed1c84dd85299736ba356dc300296d65d59991362|test'; // ADDRESS LIST
        // let str = '0|AIRDROPTEST2|1|55cd98493c0fe46aed95225d909a82793a9ba7b480dccdb3170a9cd1ce081093|test'; // TICK LIST
        // let str = '0|AIRDROPTEST3|1|afd33c2042cd43b229a44c406f03bcc940702f9736f5a222dfa53295b641a00d|test'; // ASSET LIST
        // Multi-Airdrop (brief)
        // let str = '1|fbe2a4946dfefb232571d56ed1c84dd85299736ba356dc300296d65d59991362|AIRDROPTEST1|1|AIRDROPTEST2|2|test brief';
        // Multi-Airdrop (Full)
        // let str = '2|AIRDROPTEST1|1|fbe2a4946dfefb232571d56ed1c84dd85299736ba356dc300296d65d59991362|AIRDROPTEST2|2|55cd98493c0fe46aed95225d909a82793a9ba7b480dccdb3170a9cd1ce081093|test full';
        // Multi-Airdrop (Full) w multiple memos
        // let str = '3|AIRDROPTEST1|1|fbe2a4946dfefb232571d56ed1c84dd85299736ba356dc300296d65d59991362|memo1|AIRDROPTEST2|2|55cd98493c0fe46aed95225d909a82793a9ba7b480dccdb3170a9cd1ce081093|memo2|AIRDROPTEST3|3|afd33c2042cd43b229a44c406f03bcc940702f9736f5a222dfa53295b641a00d|memo3';
        // params = String(str).split('|');

        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Array of airdrops [TICK, AMOUNT, LIST, MEMO]
        let airdrops = []; 

        // Extract memo
        let memo = null;
        let last = params.length - 1;
        for(let idx in params)
            if(idx==last && ((format==0 && idx==4) || (format==1 && idx%2==0) || (format==2 && idx%3==1)))
                memo = params[idx];

        // Build out array of airdrops
        let lastIdx = params.length - 1;        
        for(let idx in params){
            // Force index to integer value
            idx = parseInt(idx);

            // Single Airdrop
            if(format==0 && idx==0)
                airdrops.push([params[1], params[2], params[3], memo]);

            // Multi-Airdrop (brief)
            if(format==1 && idx>1 && idx%2==1)
                airdrops.push([params[1], params[idx-1], params[idx], memo]);

            // Multi-Airdrop (Full)
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                airdrops.push([params[idx], params[(idx+1)], params[idx+2], memo]);

            // Multi-Airdrop (Full) with Multiple Memos
            if(format==3 && idx>0 && idx%4==1 && idx < lastIdx)
                airdrops.push([params[idx], params[idx+1], params[idx+2], params[idx+3]]);
        }

        // Get token data for every TICK (reduces duplicated sql queries)
        let ticks = {};
        for(let airdrop of airdrops){
            let tick = airdrop[0];
            if(!ticks[tick])
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = this.util.createFeesObject(data, preferences);

        // Store original error value
        let origError = error;

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Loop through airdrops and process each
        for(let idx in airdrops){

            // Parse in the airdrop information
            let info = airdrops[idx];

            // Reset error to the original value
            error = origError;

            // Copy base transaction data object
            let airdrop = data;

            // Array of addresses that will receive this AIRDROP
            let recipients = [];

            // Placeholder for list and list type
            let type = false,
                list = null;

            // Update BTNS transaction data object with airdrop values
            airdrop['TICK']   = info[0];
            airdrop['AMOUNT'] = info[1];
            airdrop['LIST']   = info[2];
            airdrop['MEMO']   = info[3];

            // Get information on token
            let tokenInfo = ticks[airdrop['TICK']];

            /*****************************************************************
             * TICK Validations
             ****************************************************************/

            // Validate TICK exists
            if(!error && !tokenInfo)
                error = 'invalid: TICK (unknown)';

            // Determine token divisibility
            let divisible = (tokenInfo && tokenInfo['DECIMALS']==1) ? 1 : 0;

            /*************************************************************
             * FORMAT Validations
             ************************************************************/

            // Verify AMOUNT format
            if(!error && !this.util.isNull(airdrop['AMOUNT']) && !this.util.isValidAmountFormat(divisible, airdrop['AMOUNT']))
                error = "invalid: AMOUNT (format)";

            // Verify LIST format
            if(!error && !this.util.isNull(airdrop['LIST']) && !this.util.isValidTransactionHash(airdrop['LIST']))
                error = "invalid: LIST (format)";

            /*************************************************************
             * General Validations
             ************************************************************/

            // Verify no pipe in MEMO (pipe is field delimiter)
            if(!error && String(airdrop['MEMO']).indexOf('|')!=-1)
                error = 'invalid: MEMO (pipe)';

            // Verify no semicolon in MEMO (semicolon is action delimiter)
            if(!error && String(airdrop['MEMO']).indexOf(';')!=-1)
                error = 'invalid: MEMO (semicolon)';

            // Lookup list information
            if(!error){
                type = await this.indexerDb.getListType(airdrop['LIST']);
                list = await this.indexerDb.getList(airdrop['LIST']);
            }

            // Verify LIST exist
            if(!error && type===false)
                error = 'invalid: LIST (unknown)';

            // Verify LIST type is supported
            if(!error && !this.listTypes.includes(type))
                error = 'invalid: LIST TYPE (unsupported)';

            // Handle TICK LIST by looking up holders and adding to recipients list
            if(!error && this.listTypes.indexOf(type)!=-1){
                let holders = [];
                for(let tick in list){
                    if(type==1)
                        holders = await this.indexerDb.getHolders(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                    for(let address of holders){
                        if(recipients.indexOf(address)==-1)
                            recipients.push(address);
                    }
                }
            }

            // Handle ADDRESS LIST by passing forward addresses to recipients list
            if(!error && type==2)
                recipients = list;

            // Verify action is allowed from SOURCE (ALLOW_LIST & BLOCK_LIST)
            if(!error && !(await this.indexerDb.isActionAllowed(airdrop['TICK'], airdrop['SOURCE'])))
                error = 'invalid: SOURCE (not authorized)';

            // Verify SOURCE has enough balances to cover airdrop AMOUNT
            if(!error && !(await this.util.hasBalance(balances, tokenInfo['TICK_ID'], airdrop['AMOUNT'])))
                error = 'invalid: insufficient funds';

            // Build out array of recipient addresses that are allowed to receive the airdrop
            let approved = [];

            // Verify airdrop is allowed to recipient (ALLOW_LIST & BLOCK_LIST)
            for(let address of recipients){
                if(approved.indexOf(address)==-1 && await this.indexerDb.isActionAllowed(airdrop['TICK'], address))
                    approved.push(address);
            }

            // Update recipients list to only do airdrops to addresses which allow it
            recipients = approved;

            // Determine total DEBIT
            airdrop['DEBIT'] = this.util.bcmul(recipients.length,airdrop['AMOUNT'],tokenInfo['DECIMALS']);

            // Calculate total number of database hits for this AIRDROP
            let db_hits  = recipients.length * 2; // 1 credits, 1 balances
                db_hits += 3;                     // 1 debits,  1 balances, 1 airdrops

            // Determine total transaction FEE based on database hits
            fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);

            // Verify SOURCE has enough balances to cover TICK total DEBIT amount
            if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], airdrop['DEBIT']))
                error = 'invalid: insufficient funds (TICK)';
        
            // Adjust balances to reduce by DEBIT amount
            if(!error)
                balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], airdrop['DEBIT']);

            // Verify SOURCE has enough balances to cover FEE AMOUNT
            if(!error && !this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                error = 'invalid: insufficient funds (FEE)';

            // Adjust balances to reduce by FEE AMOUNT
            if(!error)
                balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

            // Determine final status
            let status = (error) ? error : 'valid';
            data['STATUS'] = airdrop['STATUS'] = status;
    
            // Print status message 
            console.log("\t AIRDROP : " + airdrop['TICK'] + ' : ' + airdrop['AMOUNT'] + ' : ' + airdrop['LIST'] + ' : '+ airdrop['STATUS']);
    
            // Create record in airdrop table
            await this.indexerDb.createAirdrop(airdrop);
    
            // If this was a valid transaction, then add records to the credits and debits array
            if(status=='valid'){

                // Store the DESTINATION and TICK in addresses list
                this.util.addAddressTicker(data['SOURCE'], [airdrop['TICK'], fees['TICK']]);

                // Add ticker, amount, and address to debits array
                debits.push([airdrop['TICK'], airdrop['DEBIT'], data['SOURCE']]);

                // Handle any transaction FEE according the users's ADDRESS preferences
                [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, 'AIRDROP', fees);

                // Loop through recipient addresses
                for(let address of recipients){

                    // Store the recipient ADDRESS and TICK in addresses list
                    this.util.addAddressTicker(address, airdrop['TICK']);
        
                    // Credit address with TICK AMOUNT
                    credits.push([airdrop['TICK'], airdrop['AMOUNT'], address]);
                }
            }

        }

        // Process any transaction credit/debit records
        await this.util.processTransactionCreditsDebits(this.indexerDb, credits, debits, data);

        // TODO: If this is a reparse, bail out before updating balances and token information
        // if(reparse)
        //     return;

        // Get a list of tickers from this airdrop
        let tickers = Object.keys(ticks);

        // Store the SOURCE and TICKERS in addresses list
        this.util.addAddressTicker(data['SOURCE'], tickers);

        // Get a list of addresses associated with this airdrop
        let addresses = Object.keys(this.util.getAddressesList());

        // Update balances for addresses
        await this.indexerDb.updateBalances(addresses);

        // Update supply for tokens
        await this.indexerDb.updateTokens(tickers);

    }
}

module.exports = Airdrop;