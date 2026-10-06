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
 * - NAME               -  An optional list name
 * - DESCRIPTION        -  An optional list description
 * - MEMO               -  An optional memo to include
 * - ITEM               -  Any valid `TICK` or `ADDRESS`
 * - EDIT               -  Edit action (1=ADD, 2=REMOVE)
 * - LIST_ACTION_INDEX  -  `ACTION_INDEX` of existing `LIST`
 * - DESTINATION        -  New owner address for a transferred list
 *
 * FORMATS:
 * - 0 = Create LIST
 * - 1 = Edit LIST
 * - 2 = Share LIST
 * - 3 = Transfer LIST
 * - 4 = Create LIST with metadata
 * - 5 = Set LIST metadata
 *
 * MEMO sits BEFORE the ITEM tail rather than last, where every other action
 * puts it. That placement is forced, not a style choice: ITEM is variadic, so a
 * trailing memo cannot be told apart from one more item. It costs an empty
 * segment on a memo-less LIST (`LIST|0|1||JDOG|BRRR`), which is the price of
 * having the field at all.
 *
 ********************************************************************/

// The flag day at which a LIST format 1 must come from the address that created
// the list: the height-keyed registry row list_owner_activation.LIST_OWNER_ACTIVATION,
// which the SDK and the wallet read as the same map when they decide whether to offer
// an edit form.
const gateRegistry = require('../consensus/gate_registry');
const { getOpenOrdersByList, getOpenSwapsByList } = require('../db/lists/rematch.js');
const { planListRematch } = require('../consensus/list_rematch/plan.js');

const addressRefPart = require('./list/address_ref.js');
const feesPart       = require('./list/fees.js');
const itemsPart      = require('./list/items.js');
const metaPart       = require('./list/meta.js');
const ownerPart      = require('./list/owner.js');
const sharePart      = require('./list/share.js');
const storePart      = require('./list/store.js');
const transferPart   = require('./list/transfer.js');
const unionPart      = require('./list/union.js');

const { getLogger } = require('../observability/index.js');
class List {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|TYPE|MEMO|ITEM';
        this.formats[1] = 'VERSION|EDIT|LIST_ACTION_INDEX|MEMO|ITEM';

        this.formatGates = {};

        // First params index carrying an ITEM, per format. ITEM is a variadic tail,
        // so the item loop below cannot read its position from the format string the
        // way a fixed field does - it has to know where the fixed prefix ends. Kept
        // beside the formats so the two cannot drift: inserting a field above without
        // moving these silently swallows the first item as a fixed field, or reads a
        // fixed field back as an item.
        this.itemStartIndex = {};
        this.itemStartIndex[0] = 3;   // VERSION|TYPE|MEMO|...
        this.itemStartIndex[1] = 4;   // VERSION|EDIT|LIST_ACTION_INDEX|MEMO|...

        for(const spec of [this.shareFormat(), this.transferFormat(),
                           this.createMetaFormat(), this.setMetaFormat()]){
            if(!spec) continue;
            if(spec.format==4 || spec.format==5)
                this.deferFormat(spec);
            else
                this.installFormat(spec);
        }

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

    // Handle parsing the LIST transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && !this.isFormatActive(format, data))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        if(format!=4 && format!=5){
            delete data['NAME'];
            delete data['DESCRIPTION'];
        }

        // Convert NUMBER fields from string value to number value so comparisons are mathematical
        if(!error)
            data = this.util.setNumberFormats(data);

        // Define some placeholders
        let edit    = {};
        let list    = [];
        let invalid = {};

        // Load the list this action edits, which also decides TYPE and the stored index
        let loaded = await this.validateAndLoadList(data, format, error);
        error = loaded.error;
        list  = loaded.list;

        error = await this.validateEditAuthority(data, format, error);

        error = await this.validateFields(data, error);

        error = await this.validateFormatRules(data, format, list, error);

        let changes = 0;

        // Handle building out some data arrays using list items
        if(!error && (this.isCreateFormat(format) || this.isEditFormat(format))){

            await this.collectEditItems(data, format, params, edit);

            changes = this.applyEditItems(data, format, edit, list, invalid);

        }

        error = await this.validateResult(data, format, list, changes, error);

        let fee = await this.chargeFee(data, format, changes, error);
        error = fee.error;
        fee = fee.fees;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        getLogger().info("\t LIST : " + data['STATUS']);

        await this.storeList(data, status, edit, list, invalid, fee);

        await this.rematchMarkets(data, format, status);

    }

    async rematchMarkets(data, format, status){
        if((!this.isCreateFormat(format) && !this.isEditFormat(format)) ||
           status!='valid' || data['TYPE']!=2 ||
           !gateRegistry.activeAt('list_change_rematch_activation.LIST_CHANGE_REMATCH_ACTIVATION', this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null))
            return;
        let listRoot = this.isCreateFormat(format) ? data['ACTION_INDEX'] : data['LIST_ACTION_INDEX'];
        let orders = [...await getOpenOrdersByList(this.indexerDb, listRoot), ...await this.getOpenMarketsByTokenList('order', listRoot)];
        let swaps = [...await getOpenSwapsByList(this.indexerDb, listRoot), ...await this.getOpenMarketsByTokenList('swap', listRoot)];
        for(let step of planListRematch(data, orders, swaps))
            await this.actions.processAction(step.action, null, step.data, null);
    }

    // Open markets trading a token whose allow or block list is this list or an edit of it
    async getOpenMarketsByTokenList(kind, root){
        let ref = '(SELECT ? UNION SELECT action_index FROM lists WHERE list_action_index=?)';
        let rows = await this.indexerDb.doQuery(`SELECT DISTINCT m.action_index FROM ${kind}s m
             INNER JOIN ${kind}_statuses ms ON (ms.${kind}_action_index=m.action_index) INNER JOIN index_statuses st ON (st.id=ms.status_id)
             INNER JOIN tokens tk ON (tk.tick_id IN (m.give_tick_id, m.get_tick_id))
             WHERE ms.action_index=(SELECT MAX(l.action_index) FROM ${kind}_statuses l WHERE l.${kind}_action_index=m.action_index) AND st.status='open' AND (tk.allow_list IN ${ref} OR tk.block_list IN ${ref})`, [root, root, root, root]);
        return rows.map(row => Number(row.action_index));
    }

    isFormatActive(format, data){
        if(format===null)
            return false;
        let fields = this.formats[format];
        if(fields === undefined && (format==4 || format==5)){
            let spec = format==4 ? this.createMetaFormat() : this.setMetaFormat();
            if(gateRegistry.activeAt(spec.gate, this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null)){
                this.installFormat(spec);
                fields = spec.fields;
            }
        }
        if(fields === undefined)
            return false;
        let gate = this.formatGates[format];
        return !gate || gateRegistry.activeAt(gate, this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null);
    }

    isCreateFormat(format){
        return [0, 4].includes(Number(format));
    }

    isEditFormat(format){
        return Number(format) === 1;
    }

    isTypeActive(type, data){
        type = Number(type);
        return this.listTypes.includes(type) || (type==3 && this.unionTypeActive(data));
    }

    async validateFormatRules(data, format, list, error){
        error = await this.validateShare(data, format, list, error);
        error = await this.validateTransfer(data, format, list, error);
        return this.validateMeta(data, format, error);
    }

    async validateResult(data, format, list, changes, error){
        if(format==5)
            return error;
        error = await this.validateSharedEdit(data, format, list, changes, error);
        return this.validateUnionResult(data, format, list, changes, error);
    }

    // FORMAT Validations
    async validateAndLoadList(data, format, error){

        // The list's current membership, empty until an edit loads it
        let type = null;
        let list = [];

        // Validate TYPE
        if(!error && this.isCreateFormat(format) && !this.isTypeActive(data['TYPE'], data))
            error = 'invalid: TYPE (unknown)';

        // Validate EDIT
        if(!error && format==1 && !this.editTypes.includes(Number(data['EDIT'])))
            error = 'invalid: EDIT (unknown)';

        // Parse in the list type (if any)
        if(!error && !this.isCreateFormat(format)){
            let getStoredType = this.indexerDb.getListStoredType || this.indexerDb.getListType;
            type = await getStoredType.call(this.indexerDb, data['LIST_ACTION_INDEX'], data['BLOCK_INDEX']);
        }

        // Validate LIST_ACTION_INDEX
        if(!error && !this.isCreateFormat(format) && type===false){
            error = 'invalid: LIST_ACTION_INDEX (unknown)';
            data['LIST_ACTION_INDEX'] = null;
        }

        // Lookup list information
        if(!error && !this.isCreateFormat(format)){
            data['TYPE'] = type;
            // Normalize LIST_ACTION_INDEX to the CREATE that roots the edit chain,
            // so every edit of a list hangs off the same parent and the "newest
            // valid edit" lookup in getList is exact. Without it an edit naming an
            // earlier EDIT's index would start a side chain that getList(createIndex)
            // never sees, and the change would be silently lost. Flag-day gated with
            // the resolution change itself: below the height the wire value is
            // stored verbatim, as it always was.
            if(format==5 || this.indexerDb.isListEditResolutionActive(data['BLOCK_INDEX']))
                data['LIST_ACTION_INDEX'] = await this.indexerDb.getListRootIndex(data['LIST_ACTION_INDEX']);
            // Reads the CURRENT membership (the head of the edit chain), so edits
            // compose: an ADD after a REMOVE builds on the removal, not on the
            // create-time item set.
            if(format!=5)
                list = await this.loadListMembers(data);
        }

        return { error, list };
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
    async validateEditAuthority(data, format, error){
        if(!error && format==1 && !data['IS_GENESIS']){

            let bridgeRoles = this.bridgeRoleAddresses();
            let ownerCheck  = gateRegistry.activeAt('list_owner_activation.LIST_OWNER_ACTIVATION', this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null);

            // Spend no read when neither rule can fire: a chain with no bridge role address
            // configured holds no bridge-owned list, and below LIST_OWNER_ACTIVATION the
            // editor is compared to nobody. This also keeps the resolution the edit-chain
            // flag day governs untouched, since the root resolved here is a LOCAL value and
            // the stored LIST_ACTION_INDEX is still whatever that flag day decided above.
            if(bridgeRoles.length || ownerCheck){

                let rootIndex  = await this.indexerDb.getListRootIndex(data['LIST_ACTION_INDEX']);
                let listSource  = await this.listOwner(rootIndex, data);

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

        if(!error && format==5 && !data['IS_GENESIS']){
            let rootIndex = await this.indexerDb.getListRootIndex(data['LIST_ACTION_INDEX']);
            let listSource = await this.listOwner(rootIndex, data);
            if(listSource && this.bridgeRoleAddresses().indexOf(listSource) !== -1)
                error = 'invalid: LIST_ACTION_INDEX (bridge-owned)';
            if(!error && listSource && listSource != data['SOURCE'])
                error = this.metaOwnerVerdict();
        }

        return error;
    }

    // General Validations
    async validateFields(data, error){

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

        return error;
    }

}

for(const part of [addressRefPart, feesPart, itemsPart, metaPart, ownerPart, sharePart,
                   storePart, transferPart, unionPart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(List.prototype, descriptors);
}

module.exports = List;
