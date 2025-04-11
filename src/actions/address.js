/*********************************************************************
 * XChain Platform Action - ADDRESS
 * 
 * PARAMS:
 * - VERSION        - Format Version
 * - FEE_PREFERENCE - Set preference for how `FEE` is used
 * - REQUIRE_MEMO   - Require a `MEMO` on any received `SEND`
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Address {

    // Handle constructing a class instance
    constructor(action){
        // Parse in indexer configuration
        this.config    = action.config;

        // Setup alias to the indexer database connections
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;

        // Setup alias to utility class
        this.util = action.util;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|FEE_PREFERENCE|REQUIRE_MEMO';

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
        // let str    = "0|1|1";
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

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message 
        console.log("\t ADDRESS : " + data['SOURCE'] + ' : ' + data['STATUS']);

        // Create record in addresses table
        await this.indexerDb.createAddressOption(data);

    }
}

module.exports = Address;