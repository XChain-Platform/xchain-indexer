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
const { getListOwner } = require('../../db/lists/sharing.js');

module.exports = {
    async listOwner(rootIndex, data){
        if(gateRegistry.activeAt('list_transfer_activation.LIST_TRANSFER_ACTIVATION',
            this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null))
            return getListOwner(this.indexerDb, rootIndex);
        return this.indexerDb.getListSource(rootIndex);
    },
};
