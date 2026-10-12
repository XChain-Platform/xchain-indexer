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
 * BET format 4 feed-list edit validation. Empty fields retain the current
 * reference, zero detaches it, and a positive action index replaces it.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');

const EDIT_GATE = 'bet_feed_list_edit_activation.BET_FEED_LIST_EDIT_ACTIVATION';

module.exports = {

    validateEditListsGate(data, format, error){
        if(format!=4)
            return error;

        if(!error && !gateRegistry.activeAt(EDIT_GATE, this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null))
            error = 'invalid: VERSION (unknown)';

        return error;
    },

    async validateEditLists(data, format, feedInfo, error){
        if(format!=4 || error)
            return error;

        let allow = data['ALLOW_LIST'];
        let block = data['BLOCK_LIST'];
        if(this.util.isNull(allow) && this.util.isNull(block))
            error = 'invalid: ALLOW_LIST/BLOCK_LIST (empty)';

        if(!error){
            for(let name of ['ALLOW_LIST', 'BLOCK_LIST']){
                let value = data[name];
                if(this.util.isNull(value))
                    continue;
                if(!/^\d+$/.test(String(value)))
                    error = 'invalid: ' + name + ' (format)';
                else if(String(value).replace(/^0+/, '') !== ''){
                    let type = await this.indexerDb.getListType(value, data['BLOCK_INDEX']);
                    if(type===false)
                        error = 'invalid: ' + name + ' (unknown)';
                    else if(!this.listTypes.includes(type))
                        error = 'invalid: ' + name + ' (unsupported)';
                }
                if(error)
                    break;
            }
        }

        let effectiveAllow = this.util.isNull(allow) ? feedInfo['ALLOW_LIST'] : allow;
        let effectiveBlock = this.util.isNull(block) ? feedInfo['BLOCK_LIST'] : block;
        let allowKey = this.util.isNull(effectiveAllow) ? '' : String(effectiveAllow).replace(/^0+/, '');
        let blockKey = this.util.isNull(effectiveBlock) ? '' : String(effectiveBlock).replace(/^0+/, '');
        if(!error && allowKey !== '' && blockKey !== '' && allowKey===blockKey)
            error = 'invalid: BLOCK_LIST (same as ALLOW_LIST)';

        return error;
    }
};
