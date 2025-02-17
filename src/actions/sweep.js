/*********************************************************************
 * XChain Indexer ACTION - SWEEP
 * 
 * PARAMS:
 * - VERSION     - Broadcast Format Version
 * - DESTINATION - address where `token` shall be swept
 * - BALANCES    - Indicates if address `token` balances should be swept (default=1)
 * - OWNERSHIPS  - Indicates if address `token` ownerships should be swept (default=1)
 * - MEMO        - Optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Sweep {

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
        this.formats[0] = 'VERSION|DESTINATION|BALANCES|OWNERSHIPS|MEMO';

    }

    // Handle parsing the DESTROY transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = '0|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|1|1|memo';
        // params = String(str).split('|');

        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats[format]);

        // Get source address balances, preferences, and token ownerships
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['TX_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['TX_INDEX']);
        let ownerships  = await this.indexerDb.getAddressOwnerships(data['SOURCE']);

        // Create the fees object 
        let fees = this.util.createFeesObject(data, preferences);

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify DESTINATION address format
        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        // Verify BALANCES format is valid (0 or 1)
        if(!error && !this.util.isNull(data['BALANCES']) && !this.util.isValidValue(data['BALANCES'],[0,1]))
            error = "invalid: BALANCES (format)";

        // Verify OWNERSHIPS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['OWNERSHIPS']) && !this.util.isValidLockValue(data['OWNERSHIPS'],[0,1]))
            error = "invalid: OWNERSHIP (format)";

        // Set default values for BALANCES and OWNERSHIP (default = 1)
        data['BALANCES']   = (!this.util.isNull(data['BALANCES'])) ? data['BALANCES'] : 1;
        data['OWNERSHIPS'] = (!this.util.isNull(data['OWNERSHIPS'])) ? data['OWNERSHIPS'] : 1;

        // Clone the raw data for storage in mints table
        let sweep = structuredClone(data);

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Calculate total number of database hits for this SWEEP
        let db_hits = 1;                                                                               // 1 sweeps
            db_hits += (data['BALANCES']) ? this.util.bcmul(Object.keys(balances).length,4,0) : 0;     // 1 debits, 1 credits, 2 balances
            db_hits += (data['OWNERSHIPS']) ? this.util.bcmul(Object.keys(ownerships).length,2,0) : 0; // 1 issue, 1 tokens

        // Determine total transaction FEE based on database hits
        fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);

        // DEBUG
        // console.log('source=',data['SOURCE']);
        // console.log('balances=',balances);
        // console.log('ownerships=',ownerships);
        // console.log('preferences=',preferences);
        // console.log('db_hits=',db_hits);
        // console.log('fees=',fees);

        // Verify SOURCE has enough balances to cover FEE AMOUNT
        if(!error && !this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
            error = 'invalid: insufficient funds (FEE)';

        // Adjust balances to reduce by FEE AMOUNT
        if(!error)
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = sweep['STATUS'] = status;

        // Print status message 
        console.log("\t SWEEP : " + sweep['DESTINATION'] + ' : '+ sweep['STATUS']);

        // Create record in sweeps table
        await this.indexerDb.createSweep(sweep);

        // If this was a valid transaction, then mint any actual supply
        if(status=='valid'){

            // Array of credits and debits
            let credits = [],
                debits  = [];

            // Store the SOURCE and TICK in addresses list
            this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, 'SWEEP', fees);

            // Transfer any balances
            if(data['BALANCES']==1){
                for(let tick_id in balances){
                    let amount = balances[tick_id];
                    let tick   = await this.indexerDb.getTicker(tick_id);

                    // Debit token amount from SOURCE and credit to DESTINATION
                    debits.push([tick,  amount]);
                    credits.push([tick, amount, sweep['DESTINATION']]);

                    // Store the SOURCE, DESTINATION and TICK in addresses and tickers lists
                    this.util.addAddressTicker(data['SOURCE'], tick);
                    this.util.addAddressTicker(data['DESTINATION'], tick);
                }
            }

            // Transfer token ownerships
            if(data['OWNERSHIPS']==1){
                // Copy base BTNS transaction data object into issue object
                let issue = sweep;
                issue['TRANSFER'] = sweep['DESTINATION'];
                for(let tick_id in ownerships){
                    let tick = ownerships[tick_id];
                    issue['TICK'] = tick;

                    // Create issue record for transfer of ownership
                    await this.indexerDb.createIssue(issue);

                    // Store the SOURCE, DESTINATION and TICK in addresses and tickers lists
                    this.util.addAddressTicker(data['SOURCE'], tick);
                    this.util.addAddressTicker(data['DESTINATION'], tick);
                }
            }

            // Process any transaction credit/debit records
            await this.util.processTransactionCreditsDebits(this.indexerDb, credits, debits, 'SWEEP', data);

            // Get a list of tickers from this sweep
            let tickers = this.util.getTickersList();

            // Get a list of addresses associated with this sweep
            let addresses = Object.keys(this.util.getAddressesList());

            // Update balances for addresses
            await this.indexerDb.updateBalances(addresses);

            // Update supplies for tokens
            await this.indexerDb.updateTokens(tickers);

        }
    }
}

module.exports = Sweep;