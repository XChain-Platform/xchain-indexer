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
 * XChain Platform Action - UNKNOWN
 * 
 * This is a generalized action class for any unknown ACTION commands
 * 
 ********************************************************************/

class Unknown {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    async parse(params, data, error){
        // The dispatcher always sets `error` before routing here ('UNKNOWN' is never
        // a defined action), so the fallback is defensive only.
        // 'invvalid' is a historical misspelling that is load-bearing: deployed
        // indexers have written it since genesis and status strings feed the
        // state hash, so correcting it is a flag-day consensus change, not a typo fix.
        let status = (error) ? error : 'invvalid';
        data['STATUS'] = status;

        console.log("\t UNKNOWN : " + data['STATUS']);

        this.util.addAddressTicker(data['SOURCE']);

        await this.mapper.createMappings(data);
    }
}

module.exports = Unknown;