// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const { isAddressRefItem } = require('./address_ref_parse.js');

const LIST_ADDRESS_REF_KEY = 'list_address_ref_activation.LIST_ADDRESS_REF_ACTIVATION';

module.exports = {
    async resolveAddressItem(item, data){
        if(data['TYPE']==2 && isAddressRefItem(item) &&
           gateRegistry.activeAt(LIST_ADDRESS_REF_KEY, this.config['NETWORK'],
               this.config['COIN'], data['BLOCK_INDEX'], null))
            return await this.indexerDb.resolveAddressRef(item);
        return item;
    },
};
