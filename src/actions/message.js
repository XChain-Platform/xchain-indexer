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
 * XChain Platform Action - MESSAGE
 * 
 * This action allows for the sending of plaintext and encrypted messages between addresses.
 * 
 * PARAMS:
 * - VERSION            - Format Version
 * - DESTINATION        - Address of the message or key recipient
 * - ENCRYPTION_METHOD  - Encryption Method (1=ECDH, 2=AES)
 * - ENCRYPTION_KEY     - public key to be used to exchange messages
 * - ENCRYPTED_MESSAGE  - Message encryted with shared key
 * - PLAINTEXT_MESSAGE  - Plaintext message (visible to all!)
 *
 * FORMATS:
 * - 0 = Sender Key
 * - 0 = Receiver Key
 * - 0 = Encrypted Message
 * - 0 = Plaintext Message
 * 
 ********************************************************************/

class Message {

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
        this.formats[0] = 'VERSION|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY';
        this.formats[1] = 'VERSION|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY';
        this.formats[2] = 'VERSION|DESTINATION|ENCRYPTED_MESSAGE';
        this.formats[3] = 'VERSION|DESTINATION|PLAINTEXT_MESSAGE';
    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = "0|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|PUBLIC_KEY_GOES_HERE";
        // let str = "1|1Donatet2LrNpuWByAnH8gc9Wh9zSzZuLC|1|PUBLIC_KEY_GOES_HERE";
        // let str = "2|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|ENCRYPTED_MESSAGE_GOES_HERE;
        // let str = "3|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Hello";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

        // TODO : Make sure that ENCRYPTION_METHOD is a numeric value or null (stop storing 'u' in database when undefined)

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify DESTINATION address format
        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        // Verify ENCRYPTION_METHOD format
        if(!error && !this.util.isNull(data['ENCRYPTION_METHOD']) && !this.util.isNumeric(data['ENCRYPTION_METHOD']))
            error = 'invalid: ENCRYPTION_METHOD (format)';

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']))
            error = 'invalid: SOURCE (sleeping)';
        
        // Verify ENCRYPTION_METHOD format
        if(!error && !this.util.isNull(data['ENCRYPTION_METHOD']) && !this.config['MESSAGE_ENCRYPTION_METHODS'].includes(data['ENCRYPTION_METHOD']))
            error = 'invalid: ENCRYPTION_METHOD (value)';

        // Verify ENCRYPTION_KEY is shorter than MAX_MESSAGE_KEY_LENGTH
        if(!error && String(data['ENCRYPTION_KEY']).length > this.config['MAX_MESSAGE_KEY_LENGTH'])
            error = 'invalid: ENCRYPTION_KEY (length)';

        // Verify ENCRYPTED_MESSAGE is shorter than MAX_MESSAGE_LENGTH
        if(!error && String(data['ENCRYPTED_MESSAGE']).length > this.config['MAX_MESSAGE_LENGTH'])
            error = 'invalid: ENCRYPTED_MESSAGE (length)';

        // Verify PLAINTEXT_MESSAGE is shorter than MAX_MESSAGE_LENGTH
        if(!error && String(data['PLAINTEXT_MESSAGE']).length > this.config['MAX_MESSAGE_LENGTH'])
            error = 'invalid: PLAINTEXT_MESSAGE (length)';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message 
        console.log("\t MESSAGE : " + data['DESTINATION'] + ' : ' + data['STATUS']);

        // Create record in messages table
        await this.indexerDb.createMessage(data);

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE']);

        // Create action mappings
        await this.mapper.createMappings(data);

    }
}

module.exports = Message;