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
 * XChain Platform Action - LIST
 * 
 * This action creates a list of items for use in actions.
 * 
 * PARAMS:
 * - VERSION            -  Format Version
 * - TYPE               -  List type (1=TICK, 2=ADDRESS)
 * - MEMO               -  An optional memo to include
 * - ITEM               -  Any valid `TICK` or `ADDRESS`
 * - EDIT               -  Edit action (1=ADD, 2=REMOVE)
 * - LIST_ACTION_INDEX  -  `ACTION_INDEX` of existing `LIST`
 *
 * FORMATS:
 * - 0 = Create LIST
 * - 1 = Edit LIST
 *
 * MEMO sits BEFORE the ITEM tail rather than last, where every other action
 * puts it. That placement is forced, not a style choice: ITEM is variadic, so a
 * trailing memo cannot be told apart from one more item. It costs an empty
 * segment on a memo-less LIST (`LIST|0|1||JDOG|BRRR`), which is the price of
 * having the field at all.
 *
 ********************************************************************/

// The flag day at which a LIST format 1 must come from the address that created
// the list. Standalone height-keyed module rather than a protocol_changes entry, because the
// SDK and the wallet read the same map when they decide whether to offer an edit form.
const listOwnerActivation = require('../list_owner_activation.js');

class List {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|TYPE|MEMO|ITEM';
        this.formats[1] = 'VERSION|EDIT|LIST_ACTION_INDEX|MEMO|ITEM';

        // First params index carrying an ITEM, per format. ITEM is a variadic tail,
        // so the item loop below cannot read its position from the format string the
        // way a fixed field does - it has to know where the fixed prefix ends. Kept
        // beside the formats so the two cannot drift: inserting a field above without
        // moving these silently swallows the first item as a fixed field, or reads a
        // fixed field back as an item.
        this.itemStartIndex = {};
        this.itemStartIndex[0] = 3;   // VERSION|TYPE|MEMO|...
        this.itemStartIndex[1] = 4;   // VERSION|EDIT|LIST_ACTION_INDEX|MEMO|...

        // Define array of list types (1=Tick, 2=Address)
        this.listTypes = [1,2];

        // Define array of edit types (1=Add, 2=Remove)
        this.editTypes = [1,2];
    }

    // Every bridge role address configured for THIS chain. Policy inheritance materializes
    // an origin token's list onto a bridged copy as an ordinary local LIST owned by this
    // chain's ADDRESS.BRIDGE_<ORIGIN>, one per origin chain, so the set is read off the coin
    // bundle by role-name prefix rather than named coin by coin here. An unconfigured chain
    // yields an empty set and the guard below is inert, which is the pre-bridge behaviour.
    bridgeRoleAddresses(){
        let addresses = this.config['ADDRESS'] || {};
        let roles     = [];
        for(let role in addresses)
            if(String(role).indexOf('BRIDGE_') === 0 && addresses[role])
                roles.push(addresses[role]);
        return roles;
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        if(!error)
            data = this.util.setNumberFormats(data);

        let type    = null;
        let edit    = {};
        let list    = [];
        let invalid = {};

        // FORMAT Validations

        // Validate TYPE
        if(!error && format==0 && !this.listTypes.includes(Number(data['TYPE'])))
            error = 'invalid: TYPE (unknown)';

        // Validate EDIT
        if(!error && format==1 && !this.editTypes.includes(Number(data['EDIT'])))
            error = 'invalid: EDIT (unknown)';

        // Parse in the list type (if any)
        if(!error && format==1)
            type = await this.indexerDb.getListType(data['LIST_ACTION_INDEX']);

        // Validate LIST_ACTION_INDEX
        if(!error && format==1 && type===false){
            error = 'invalid: LIST_ACTION_INDEX (unknown)';
            data['LIST_ACTION_INDEX'] = null;
        }

        // Lookup list information
        if(!error && format==1){
            data['TYPE'] = type;
            // Normalize LIST_ACTION_INDEX to the CREATE that roots the edit chain,
            // so every edit of a list hangs off the same parent and the "newest
            // valid edit" lookup in getList is exact. Without it an edit naming an
            // earlier EDIT's index would start a side chain that getList(createIndex)
            // never sees, and the change would be silently lost. Flag-day gated with
            // the resolution change itself: below the height the wire value is
            // stored verbatim, as it always was.
            if(this.indexerDb.isListEditResolutionActive(data['BLOCK_INDEX']))
                data['LIST_ACTION_INDEX'] = await this.indexerDb.getListRootIndex(data['LIST_ACTION_INDEX']);
            // Reads the CURRENT membership (the head of the edit chain), so edits
            // compose: an ADD after a REMOVE builds on the removal, not on the
            // create-time item set.
            list = await this.indexerDb.getList(data['LIST_ACTION_INDEX'], data['BLOCK_INDEX']);
        }

        // ── Who may EDIT this list (two rules, one read) ──────────────────────────────────
        //
        // Both rules judge the ROOT CREATE's source, never the last edit's: the authority
        // over an edit chain belongs to the address that created the list, and reading the
        // newest edit would let the first unauthorized edit launder authority for every edit
        // after it. Resolved here rather than leaning on the normalization above, which is
        // itself flag-gated.
        //
        // Injected edits are exempt through IS_GENESIS: policy inheritance rewrites the
        // copy's membership from a signed snapshot through processTransaction(tx, true), and
        // the bridge role address that owns the list holds no key to broadcast with.
        if(!error && format==1 && !data['IS_GENESIS']){

            let bridgeRoles = this.bridgeRoleAddresses();
            let ownerCheck  = listOwnerActivation.isListOwnerCheckActive(data['BLOCK_INDEX'], this.config['NETWORK']);

            // Spend no read when neither rule can fire: a chain with no bridge role address
            // configured holds no bridge-owned list, and below LIST_OWNER_ACTIVATION the
            // editor is compared to nobody. This also keeps the resolution the edit-chain
            // flag day governs untouched, since the root resolved here is a LOCAL value and
            // the stored LIST_ACTION_INDEX is still whatever that flag day decided above.
            if(bridgeRoles.length || ownerCheck){

                let rootIndex  = await this.indexerDb.getListRootIndex(data['LIST_ACTION_INDEX']);
                let listSource = await this.indexerDb.getListSource(rootIndex);

                // BRIDGE-OWNED LISTS. A materialized policy list on a bridged copy is the
                // issuer's policy carried from the origin chain and signed by the federation;
                // the destination chain must never let a broadcast rewrite it, or any address
                // could edit an issuer's allow or block list on every chain holding a copy.
                // Unconditional, not activation-keyed: no bridge-owned list can exist before
                // the first snapshot applies, so no historical edit changes status on replay.
                if(listSource && bridgeRoles.indexOf(listSource) !== -1)
                    error = 'invalid: LIST_ACTION_INDEX (bridge-owned)';

                // THE GENERAL OWNER CHECK. LIST edits had no owner check anywhere on
                // the platform: any address could edit any issuer's list, and those lists gate
                // SEND, ORDER, DISPENSER, AIRDROP, DIVIDEND, BET and SWAP on every listed
                // token. Flag gated because it re-verdicts historical third-party edits, which
                // the unconditional rule above cannot: below LIST_OWNER_ACTIVATION every edit
                // is judged exactly as it was, so a from-genesis replay is byte-identical.
                if(!error && ownerCheck && listSource && listSource != data['SOURCE'])
                    error = 'invalid: LIST_ACTION_INDEX (not owner)';
            }
        }

        // General Validations

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        if(!error){

            // Build out array of edit items and status for each
            let firstItemIndex = this.itemStartIndex[format];
            for(let idx in params){
                let status = 'valid';
                let item   = params[idx];
                // Get list items (everything from the end of the fixed prefix onward).
                // `idx` is a string here (for..in over an array), so compare numerically
                // rather than leaning on coercion.
                if(Number(idx) >= firstItemIndex){

                    // Verify TICK 
                    if(data['TYPE']==1){
                        let tokenInfo = await this.indexerDb.getTokenInfo(item);
                        if(!tokenInfo)
                            status = 'invalid: TICK (unknown)';
                    }

                    // Verify ADDRESS.
                    //
                    // ANY-COIN ITEMS at/above TOKEN_POLICY_INHERITANCE_ACTIVATION: a bridged
                    // copy inherits ONE list from its origin row, so that list has to be able
                    // to name holders on every chain a copy lives on. isAnyCoinAddress loops
                    // the existing coin-and-network-aware validator over COINS rather than
                    // introducing a second address validator. Below the flag it is the
                    // one-argument call this line has always made.
                    //
                    // The widening is hash-visible, which is why it is gated at all: an
                    // admitted item writes a list_items row and that table is hashed DERIVED.
                    // The ACTION's own status never moved either way (a bad item is recorded
                    // in list_items_invalid and the LIST stays valid), so only the membership
                    // is at stake.
                    if(data['TYPE']==2 && !this.indexerDb.isAnyCoinAddress(item, data['BLOCK_INDEX']))
                        status = 'invalid: ADDRESS (format)';

                    // Add item and status to edits array
                    edit[item] = status;
                }
            }

            // Build out final array of list items
            for(let item in edit){
                let status = edit[item];

                // VALID items
                if(status=='valid'){

                    // ADD items
                    if((format==0 || (format==1 && data['EDIT']==1)) && !list.includes(item))
                        list.push(item);

                    // REMOVE items
                    if(format==1 && data['EDIT']==2 && list.includes(item))
                        list.splice(list.indexOf(item),1);

                } else {
                    // INVALID items
                    invalid[item] = status;
                }
            }

        }

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t LIST : " + data['STATUS']);

        await this.indexerDb.createList(data);

        this.util.addAddressTicker(data['SOURCE']);

        // If this was a valid transaction, then create the list and edit records
        if(status=='valid'){

            // Create record of edits and status for each
            for(let item in edit)
                await this.indexerDb.createListEdit(data, item, edit[item]);

            // Create record of items on list
            for(let item of list)
                await this.indexerDb.createListItem(data, item);

            // Create record of invalid list items
            for(let item in invalid)
                await this.indexerDb.createListItemInvalid(data, item, invalid[item]);
        }

        await this.mapper.createMappings(data);

    }
}

module.exports = List;