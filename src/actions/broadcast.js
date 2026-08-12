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
 * XChain Platform Action - BROADCAST
 * 
 * This action broadcasts a message, and can also be used to create oracles and betting feeds.
 * 
 * PARAMS:
 * - VERSION                - Format Version
 * - MESSAGE                - A text string
 * - VALUE                  - Numerical value
 * - FEE                    - Indicates usage percentage fee (1=1%, 2=2%, etc)
 * - MEMO                   - An optional memo to include
 * - BROADCAST_ACTION_INDEX - `ACTION_INDEX` of broadcast action
 *
 * FORMATS:
 * - 0 = Broadcast Message
 * - 1 = Broadcast Oracle
 * - 2 = Broadcast Feed
 * - 3 = Broadcast Feed Results
 * 
 ********************************************************************/

class Broadcast {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|MESSAGE|VALUE';
        this.formats[1] = 'VERSION|MESSAGE|VALUE|FEE|MEMO';
        this.formats[2] = 'VERSION|MESSAGE|FEE|MEMO';
        this.formats[3] = 'VERSION|BROADCAST_ACTION_INDEX|VALUE|MEMO';
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string to number so comparisons below are mathematical, not lexical.
        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && !this.util.isNull(data['VALUE']) && !this.util.isNumeric(data['VALUE']))
            error = 'invalid: VALUE (format)';

        if(!error && !this.util.isNull(data['FEE']) && !this.util.isNumeric(data['FEE']))
            error = 'invalid: FEE (format)';

        if(!error && !this.util.isNull(data['BROADCAST_ACTION_INDEX']) && !this.util.isNumeric(data['BROADCAST_ACTION_INDEX']))
            error = 'invalid: BROADCAST_ACTION_INDEX (format)';

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        if(!error && !this.util.isNull(data['BROADCAST_ACTION_INDEX']) && await this.indexerDb.isActionIndexValid(data['BROADCAST_ACTION_INDEX']) == false)
            error = 'invalid: BROADCAST_ACTION_INDEX (status)';

        if(!error && String(data['MESSAGE']).length > this.config['MAX_BROADCAST_MESSAGE_LENGTH'])
            error = 'invalid: MESSAGE (length)';

        if(!error && String(data['VALUE']).length > this.config['MAX_BROADCAST_VALUE_LENGTH'])
            error = 'invalid: VALUE (length)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t BROADCAST : " + data['MESSAGE'] + ' : ' +  data['VALUE'] + ' : ' + data['STATUS']);

        await this.indexerDb.createBroadcast(data);

        this.util.addAddressTicker(data['SOURCE']);

        await this.mapper.createMappings(data);

        if(status=='valid'){

            // Resolve any open bets on this feed
            if(format==3){

                // TODO : Add support for resolving bets

            }

        }

    }
}

module.exports = Broadcast;