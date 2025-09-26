/*********************************************************************
 * XChain Platform Action - ADDRESS
 * 
 * This action configures address specific options.
 * 
 * PARAMS:
 * - VERSION        - Format Version
 * - FEE_PREFERENCE - Set preference for how `FEE` is used
 * - REQUIRE_MEMO   - Require a `MEMO` on any received `SEND`
 * - MEMO           - An optional memo to include     
 * 
 * FEE_PREFERENCE Options :
 * - 1 = `FEE` is destroyed, lowering supply
 * - 2 = `FEE` to donated to protocol development (default)
 * - 3 = `FEE` to donated to community development
 *
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Address {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|FEE_PREFERENCE|REQUIRE_MEMO|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['FEE_PREFERENCE', 'REQUIRE_MEMO'];

        // Define lists of valid field values
        this.validValues = {};

        // Define list of valid FEE_PREFERENCE values
        this.validValues['FEE_PREFERENCE'] = [0,1,2];

        // Define list of valid MEMO_PREFERENCE values
        this.validValues['REQUIRE_MEMO'] = [0,1];
    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|1|1|my address update";
        // params = String(str).split('|');

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats[format]);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        for(let name of this.fieldList['NUMBER']){
            let value = data[name];
            if(!this.util.isNull(value))
                data[name] = this.util.bcnum(value);
        }

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify FEE_PREFERENCE is numeric
        if(!error && !this.util.isNull(data['FEE_PREFERENCE']) && !this.util.isNumeric(data['FEE_PREFERENCE']))
            error = "invalid: FEE_PREFERENCE (format)";

        // Verify REQUIRE_MEMO is numeric
        if(!error && !this.util.isNull(data['REQUIRE_MEMO']) && !this.util.isNumeric(data['REQUIRE_MEMO']))
            error = "invalid: REQUIRE_MEMO (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify FEE_PREFERENCE value is valid
        if(!error && !this.util.isNull(data['FEE_PREFERENCE']) && !this.validValues['FEE_PREFERENCE'].includes(data['FEE_PREFERENCE']))
            error = 'invalid: FEE_PREFERENCE (value)';

        // Verify REQUIRE_MEMO value is valid
        if(!error && !this.util.isNull(data['REQUIRE_MEMO']) && !this.validValues['REQUIRE_MEMO'].includes(data['REQUIRE_MEMO']))
            error = 'invalid: REQUIRE_MEMO (value)';

        // Verify SOURCE is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']))
            error = 'invalid: SOURCE (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message 
        console.log("\t ADDRESS : " + data['SOURCE'] + ' : ' + data['STATUS']);

        // Create record in addresses table
        await this.indexerDb.createAddressOption(data);

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE']);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Address;