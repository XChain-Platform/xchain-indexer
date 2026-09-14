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
 * XChain Platform Action - AIRDROP: recipients
 *
 * Who a leg's LIST reaches, and which of them the TICK's own allow and
 * block lists admit.
 *
 ********************************************************************/

// Installed onto Airdrop.prototype by airdrop.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // The addresses a leg's LIST reaches: every current holder of each listed tick for a TICK
    // LIST, exactly the listed addresses for an ADDRESS LIST, none when the leg already failed
    async expandAirdropRecipients(type, list, data, error){
        // Set of addresses that will receive this AIRDROP. A Set, not an array: membership is
        // tested once per holder and a list can carry thousands of addresses (see mapper.js),
        // so an array made dedup O(n^2) on the synchronous per-block path. Set over a plain
        // object (the dividend.js/callback.js idiom) because insertion order is guaranteed,
        // keeping the credit order below deterministic for consensus.
        let recipients = new Set();

        // TICK LIST: expand to all current holders of each listed tick.
        if(!error && this.listTypes.indexOf(type)!=-1){
            let holders = {};
            for(let tick of list){
                if(type==1)
                    holders = await this.indexerDb.getHolders(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                for(let address in holders)
                    recipients.add(address);   // Set.add is already idempotent, so no membership test
            }
        }

        // ADDRESS LIST: recipients are exactly the listed addresses.
        if(!error && type==2)
            recipients = new Set(list);

        return recipients;
    },

    // Build out array of recipient addresses that are allowed to receive the airdrop
    // Fetch TICK's allow/block lists ONCE before the recipient loop, then check membership in
    // memory via Sets (matching isActionAllowed's no-block_index behavior) so each recipient
    // costs an O(1) hash probe instead of an O(n) scan, not O(recipients x list). The
    // approved set is unchanged by this: membership is the only thing asked of the two
    // lists, so their own order never mattered. Determinism rides on `recipients`
    // iteration order, which Sets preserve, and therefore on the insertion order of
    // `approved` and of the credits built from it downstream; an empty list stays truthy
    // as a Set exactly as it was as an array, so an empty ALLOW_LIST still approves
    // nobody.
    async approveAirdropRecipients(recipients, tokenInfo, data){
        let approved = new Set();
        let hasAllowList = tokenInfo && !this.util.isNull(tokenInfo['ALLOW_LIST']) && this.util.isNumeric(tokenInfo['ALLOW_LIST']);
        let hasBlockList = tokenInfo && !this.util.isNull(tokenInfo['BLOCK_LIST']) && this.util.isNumeric(tokenInfo['BLOCK_LIST']);
        let recipientAllowList = hasAllowList ? new Set(await this.indexerDb.getList(tokenInfo['ALLOW_LIST'], data['BLOCK_INDEX'])) : null;
        let recipientBlockList = hasBlockList ? new Set(await this.indexerDb.getList(tokenInfo['BLOCK_LIST'], data['BLOCK_INDEX'])) : null;

        // Verify airdrop is allowed to recipient (allow/block lists)
        for(let address of recipients){
            if(approved.has(address))
                continue;
            let allowed = true;
            // False if we have an ALLOW_LIST and address is NOT on it
            if(allowed && recipientAllowList && !recipientAllowList.has(address))
                allowed = false;
            // False if we have a BLOCK_LIST and address IS on it
            if(allowed && recipientBlockList && recipientBlockList.has(address))
                allowed = false;
            if(allowed)
                approved.add(address);
        }
        return approved;
    }
};
