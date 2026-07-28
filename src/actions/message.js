/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform Action - MESSAGE
 * 
 * This action allows for the sending of plaintext and encrypted messages between addresses.
 * 
 * PARAMS:
 * - VERSION            - Format Version
 * - COIN               - Destination coin network (BTC, LTC, DOGE)
 * - DESTINATION        - Address of the message or key recipient
 * - ENCRYPTION_METHOD  - Encryption Method (1=ECIES, 2=ECDH, 3=AES)
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
        this.formats[0] = 'VERSION|COIN|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY';
        this.formats[1] = 'VERSION|COIN|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY';
        this.formats[2] = 'VERSION|COIN|DESTINATION|ENCRYPTED_MESSAGE';
        this.formats[3] = 'VERSION|COIN|DESTINATION|PLAINTEXT_MESSAGE';
    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
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

        // Resolve a compacted ^<id> DESTINATION back to its canonical address
        // before validation/use (see resolveAddressRefChecked). At/after the 
        // flag-day an unresolvable reference is a hard reject; below it the value is
        // left as-is and rejected by isCryptoAddress.
        if(!error){
            let destRef = await this.indexerDb.resolveAddressRefChecked(data['DESTINATION'], data['BLOCK_INDEX']);
            data['DESTINATION'] = destRef.value;
            if(destRef.rejected)
                error = 'invalid: DESTINATION (unresolvable ^id)';
        }

        // MESSAGE v2 (VERSION|COIN|DESTINATION|ENCRYPTED_MESSAGE) carries no
        // ENCRYPTION_METHOD on the wire; absence implies ECIES (1) by protocol.
        // Stamp it so v2 rows persist a concrete method rather than null and the
        // reader's decrypt gate stays reachable.
        if(!error && format===2 && this.util.isNull(data['ENCRYPTION_METHOD']))
            data['ENCRYPTION_METHOD'] = 1;

        // TODO : Make sure that ENCRYPTION_METHOD is a numeric value or null (stop storing 'u' in database when undefined)

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify COIN is a valid coin
        if(!error && !this.util.isNull(data['COIN']) && !this.config['COINS'].includes(String(data['COIN']).toUpperCase()))
            error = "invalid: COIN (value)";

        // Verify DESTINATION address format against the COIN network, NOT this
        // indexer's broadcast chain: a MESSAGE may be broadcast on any chain
        // regardless of the destination's chain (e.g. a BTC-addressed message
        // sent over DOGE for cheap fees; see protocol/actions/MESSAGE.md). So a
        // BTC destination must be validated with BTC's address params even on a
        // DOGE node. Fall back to the node's own coin when COIN is absent.
        let destCoin = this.util.isNull(data['COIN']) ? null : String(data['COIN']).toUpperCase();
        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION'], destCoin))
            error = "invalid: DESTINATION (format)";

        // Verify ENCRYPTION_METHOD format
        if(!error && !this.util.isNull(data['ENCRYPTION_METHOD']) && !this.util.isNumeric(data['ENCRYPTION_METHOD']))
            error = 'invalid: ENCRYPTION_METHOD (format)';

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';
        
        // Verify ENCRYPTION_METHOD format
        if(!error && !this.util.isNull(data['ENCRYPTION_METHOD']) && !this.config['MESSAGE_ENCRYPTION_METHODS'].includes(Number(data['ENCRYPTION_METHOD'])))
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