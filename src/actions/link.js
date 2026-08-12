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
 * XChain Platform Action - LINK
 * 
 * This action links actions using `ACTION_INDEX`, including linking actions across blockchains
 * 
 * PARAMS:
 * - VERSION            - Format Version
 * - COIN1              - `COIN` name (BTC, LTC, DOGE, etc)
 * - COIN1_ACTION_INDEX - `ACTION_INDEX` of action on `COIN1` network
 * - COIN2              - `COIN` name (BTC, LTC, DOGE, etc)
 * - COIN2_ACTION_INDEX - `ACTION_INDEX` of action on `COIN2` network
 * - MEMO               - An optional memo to include
 *
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Link {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|COIN1|COIN1_ACTION_INDEX|COIN2|COIN2_ACTION_INDEX|MEMO';
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        if(!error)
            data = this.util.setNumberFormats(data);

        // COIN Validations

        // Validate COIN1 is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['COIN1']))
            error = 'invalid: COIN1 (unsupported COIN network)';

        // Validate COIN2 is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['COIN2']))
            error = 'invalid: COIN2 (unsupported COIN network)';

        // FORMAT Validations

        // Verify COIN1_ACTION_INDEX format
        if(!error && (this.util.isNull(data['COIN1_ACTION_INDEX']) || !this.util.isNumeric(data['COIN1_ACTION_INDEX'])))
            error = 'invalid: COIN1_ACTION_INDEX (format)';

        // Verify COIN2_ACTION_INDEX format
        if(!error && (this.util.isNull(data['COIN2_ACTION_INDEX']) || !this.util.isNumeric(data['COIN2_ACTION_INDEX'])))
            error = 'invalid: COIN2_ACTION_INDEX (format)';

        // General Validations

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify COIN1_ACTION_INDEX is valid (only validate links on current COIN network)
        if(!error && data['COIN1']==this.config['COIN'] && await this.indexerDb.isActionIndexValid(data['COIN1_ACTION_INDEX']) == false)
            error = 'invalid: COIN1_ACTION_INDEX (status)';

        // Verify COIN2_ACTION_INDEX is valid (only validate links on current COIN network)
        if(!error && data['COIN2']==this.config['COIN'] && await this.indexerDb.isActionIndexValid(data['COIN2_ACTION_INDEX']) == false)
            error = 'invalid: COIN2_ACTION_INDEX (status)';

        // When COIN2_ACTION_INDEX resolves to a local ISSUE (i.e. linking against a TICK),
        // the LINK must be authored by the current owner AND the tick's ownership must
        // not be currently sitting in protocol-held escrow (e.g. listed for sale via
        // ORDER/SWAP/DISPENSER with GIVE_OWNERSHIP=1). Cross-chain ISSUE targets cannot
        // be validated locally and are deliberately skipped.
        if(!error && data['COIN2']==this.config['COIN']){
            let tick = await this.indexerDb.getIssueTick(data['COIN2_ACTION_INDEX']);
            if(tick){
                let tokenInfo = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                if(tokenInfo && tokenInfo['OWNER'] !== data['SOURCE'])
                    error = 'invalid: SOURCE (not current TICK owner)';
                if(!error && await this.indexerDb.isOwnershipEscrowed(tick))
                    error = 'invalid: TICK (ownership escrowed)';
            }
        }

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t LINK : " + data['COIN1'] + ':' + data['COIN1_ACTION_INDEX'] + '->' + data['COIN2'] + ':' + data['COIN2_ACTION_INDEX'] + ' : ' + data['STATUS']);

        await this.indexerDb.createLink(data);

        this.util.addAddressTicker(data['SOURCE']);

        await this.mapper.createMappings(data);

    }
}

module.exports = Link;