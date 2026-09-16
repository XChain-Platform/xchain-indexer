const { getLogger } = require('../../observability/index.js');
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
 * COINPAY validation: the obligation a payment output names must exist and still
 * be pending. Any other output is a no-op: logged, its action index deleted.
 *
 ********************************************************************/

// Installed onto Coinpay.prototype by coinpay.js; each method runs with `this` bound to
// the handler, exactly as the class method it was.
module.exports = {

    // The pending obligation this output pays, or null once the output has been skipped
    async loadPendingObligation(data, error){

        // Look up the COINPay obligation by ORDER_MATCH_ACTION_INDEX
        let obligationInfo = false;
        if(!error)
            obligationInfo = await this.indexerDb.getCoinpayObligationInfo(data['ORDER_MATCH_ACTION_INDEX']);

        // Each on-chain output is processed independently; only the output that actually
        // matches a pending obligation settles. Every other output early-exits as a no-op.
        if(!obligationInfo || obligationInfo['COINPAY_STATUS'] != 'pending_coinpay'){
            getLogger().info("\t COINPAY (skip): obligation " + data['ORDER_MATCH_ACTION_INDEX'] + " " + (obligationInfo ? "status=" + obligationInfo['COINPAY_STATUS'] : "not found"));
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return null;
        }
        return obligationInfo;
    }
};
