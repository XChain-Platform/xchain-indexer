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
 * BET format 4 feed-list edit storage. Each action owns an append-only row;
 * effective feed reads fold valid rows in action order, so rollback only has
 * to remove the orphan action's row.
 *
 ********************************************************************/

'use strict';

module.exports = {

    async applyEditLists(data, format){
        if(format!=4 || typeof this.indexerDb.createBetEdit !== 'function')
            return;
        await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'BET_EDIT');
        await this.indexerDb.createBetEdit(data);
    }
};
