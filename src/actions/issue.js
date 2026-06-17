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
 * XChain Platform Action - ISSUE
 * 
 * This action creates or updates a `TICK`
 * 
 * PARAMS:
 * - VERSION          - Format Version
 * - TICK             - Ticker name or Ticker ID
 * - MAX_SUPPLY       - Maximum token supply 
 * - MAX_MINT         - Maximum amount of supply a `MINT` transaction can issue
 * - DECIMALS         - Number of decimal places token should have (max: 18, default: 0)
 * - DESCRIPTION      - Description of token (max 249 chars)
 * - MINT_SUPPLY      - Amount of token supply to mint in immediately (default:0)
 * - TRANSFER         - Address to transfer ownership of the `token` to (owner can perform future actions on token)
 * - TRANSFER_SUPPLY  - Address to transfer `MINT_SUPPLY` to (mint initial supply and transfer to address)
 * - LOCK_MAX_SUPPLY  - Lock `MAX_SUPPLY` permanently (cannot increase `MAX_SUPPLY`)
 * - LOCK_MINT        - Lock `token` against `MINT` command
 * - LOCK_MAX_MINT    - Lock `MAX_MINT` permanently (cannot edit `MAX_MINT`)
 * - LOCK_DESCRIPTION - Lock `token` against `DESCRIPTION` changes
 * - LOCK_SLEEP       - Lock `token` against `SLEEP` command
 * - LOCK_CALLBACK    - Lock `token` `CALLBACK` info
 * - CALLBACK_BLOCK   - Enable `CALLBACK` command after `CALLBACK_BLOCK` 
 * - CALLBACK_TICK    - `TICK` `token` users get when `CALLBACK` command is used
 * - CALLBACK_AMOUNT  - `TICK` `token` amount that users get when `CALLBACK` command is used
 * - ALLOW_LIST       - `ACTION_INDEX` of a LIST of addresses allowed to interact with this token
 * - BLOCK_LIST       - `ACTION_INDEX` of a LIST of addresses NOT allowed to interact with this token
 * - MINT_ADDRESS_MAX - Maximum amount of supply any address can mint via `MINT` transactions
 * - MINT_START_BLOCK - `BLOCK_INDEX` when `MINT` transactions are allowed (begin mint)
 * - MINT_STOP_BLOCK` - `BLOCK_INDEX` when `MINT` transactions are NOT allowed (end mint)
 * - CONTROLLER       - (format 6 only) `ACTION_INDEX` of a deployed contract whose `guard`
 *                      method gates one ACTION_CLASS of this token (programmable policy layer)
 * - ACTION_CLASS     - (format 6 only) which class to gate: transfer|trade|burn|mint|stake
 * - COOLDOWN_BLOCKS  - (format 6 only) drop-cooldown committed at bind; the friction on a later unbind
 * - UNBIND           - (format 6 only) 1 = drop the live binding for ACTION_CLASS
 *
 * FORMATS :
 * - 0 = Full
 * - 1 = Brief
 * - 2 = Edit MINT PARAMS
 * - 3 = Edit LOCK PARAMS
 * - 4 = Edit CALLBACK PARAMS
 * - 5 = Edit LIST PARAMS
 * - 6 = Bind/unbind a controller (programmable policy layer)
 *
 ********************************************************************/

class Issue {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO';
        this.formats[1] = 'VERSION|TICK|DESCRIPTION|MEMO';
        this.formats[2] = 'VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|MEMO';
        this.formats[3] = 'VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO';
        this.formats[4] = 'VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|MEMO';
        this.formats[5] = 'VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO';
        // Programmable policy layer: bind/unbind a guard contract to one action-class of this token
        // (append-only token_controllers model). One binding change per action; UNBIND=1 drops the
        // live binding for ACTION_CLASS (CONTROLLER then ignored). COOLDOWN_BLOCKS is committed at
        // bind time and is the friction on a later drop. See Controller_Bound_Tokens.md.
        this.formats[6] = 'VERSION|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of AMOUNT, LOCK fields (used in validations)
        this.fieldList['AMOUNT'] = ['MAX_SUPPLY', 'MAX_MINT', 'MINT_SUPPLY', 'CALLBACK_AMOUNT', 'MINT_ADDRESS_MAX', 'MINT_START_BLOCK', 'MINT_STOP_BLOCK'];
        this.fieldList['LOCK']   = ['LOCK_MAX_SUPPLY', 'LOCK_MINT', 'LOCK_MINT_SUPPLY', 'LOCK_MAX_MINT', 'LOCK_DESCRIPTION', 'LOCK_SLEEP', 'LOCK_CALLBACK'];
    }

    // Handle parsing the ISSUE transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|JDOG|1000||18";
        // params = String(str).split('|');
        // data['SOURCE'] = this.config['ADDRESS']['BURN'];
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // TODO: Decode any base64 tickers
        // if(this.util.isBase64(data['TICK']))
        //     $data['TICK'] = this.util.base64Decode(data['TICK']);

        // Clone the raw data for storage in issues table
        let issue = Object.assign({}, data);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

        // Build out arrays of allowed characters and tick characters
        let allowedCharacters = String(this.config['TICK_CHARACTERS']).split('');
        let tickCharacters    = String(data['TICK']).split('');

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        /*****************************************************************
         * TICK Validations
         ****************************************************************/

        // Verify TICK is not null/empty
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (null)';

        // Verify TICK does not begin or end with period (.)
        let str = String(data['TICK']);
        if(!error && (str.substring(0,1)=='.' || str.slice(-1)=='.'))
            error = 'invalid: TICK (period)';

        // Determine if this is a parent/child issuance using full TICK name
        let parts      = String(data['TICK']).split('.');
        let parent     = false;
        let parentInfo = false;
        if(parts.length>1){
            parent = parts.slice(0,-1).join('.');

            // Get information on parent TICK
            parentInfo = await this.indexerDb.getTokenInfo(parent, data['BLOCK_INDEX'], data['ACTION_INDEX']);

            // Verify parent TICK exists
            if(!error && !parentInfo)
                error = 'invalid: TICK (parent unknown)';

            // Verify ISSUE is coming from PARENT TICK owner
            if(!error && parentInfo && parentInfo['OWNER']!=data['SOURCE'])
                error = 'invalid: TICK (parent issued by another address)';

            // Reject child issuance while the parent's ownership is escrowed in an open offer
            if(!error && parentInfo && await this.indexerDb.isOwnershipEscrowed(parent))
                error = 'invalid: TICK (parent ownership escrowed)';
        }

        // Verify TICK contains only allowed characters
        for(let char of tickCharacters){
            if(!error && !allowedCharacters.includes(char))
                error = 'invalid: TICK (character)';
        }

        // Verify any TICK ID given is valid tick ID
        let tid = str.substring(1,str.length-1); // Possible TICK ID
        if(!error && str.substring(0,1)=='^' && !this.util.isNumeric(tid))
            error = 'invalid: TICK (id)';

        // Verify TICK length is within acceptable range
        let len = String(data['TICK']).length,
            min = parseInt(this.config['MIN_TICK_LENGTH']),
            max = parseInt(this.config['MAX_TICK_LENGTH']);
        if(!error && (len < min || len > max))
            error = 'invalid: TICK (length)';

        // Verify no pipe in TICK (pipe is field delimiter)
        if(!error && String(data['TICK']).indexOf('|')!=-1)
            error = 'invalid: TICK (pipe)';

        // Verify no semicolon in TICK (semicolon is action delimiter)
        if(!error && String(data['TICK']).indexOf(';')!=-1)
            error = 'invalid: TICK (semicolon)';

        // Verify TICK is not on RESERVED_TICKS list (GAS address can issue GAS token; any address can on regtest)
        if(!error && this.config['RESERVED_TICKS'].indexOf(data['TICK'])!=-1 && !(data['TICK']==this.config['GAS'] && data['SOURCE']==this.config['ADDRESS']['GAS']) && this.config['NETWORK']!='regtest')
            error = 'invalid: TICK (reserved)';

        // Verify only GAS address can issue on GAS token
        if(!error && String(data['TICK']).toUpperCase()==this.config['GAS'] && data['SOURCE']!=this.config['ADDRESS']['GAS'] && this.config['NETWORK']!='regtest')
            error = 'invalid: GAS Address';

        // Get information on token, then check distribution passing tokenInfo to avoid a second getTokenInfo call
        let tokenInfo     = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let isDistributed = await this.indexerDb.isDistributed(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'], tokenInfo);

        // Populate empty PARAMS with current setting
        if(tokenInfo){
            for(let key in tokenInfo){
                if(this.util.isNull(data[key]))
                    data[key] = tokenInfo[key];
            }
        }

        // Get information on CALLBACK_TICK
        let cbInfo = false;
        if(data['CALLBACK_TICK'])
            cbInfo = await this.indexerDb.getTokenInfo(data['CALLBACK_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Set decimal precision for TICK and CALLBACK_TICK 
        let tick_decimals     = (!this.util.isNull(tokenInfo) && !this.util.isNull(tokenInfo['DECIMALS'])) ? tokenInfo['DECIMALS'] : data['DECIMALS'],
            callback_decimals = (!this.util.isNull(cbInfo) && !this.util.isNull(cbInfo['DECIMALS'])) ? cbInfo['DECIMALS'] : 0;

        // Verify AMOUNT field formats
        for(let name of this.fieldList['AMOUNT']){
            let value    = issue[name],
                decimals = (name=='CALLBACK_AMOUNT') ? callback_decimals : tick_decimals;
            if(!error && !this.util.isNull(value) && !this.util.isValidAmountFormat(decimals, value))
                error = "invalid: " + name + " (format)";
        }

        // Verify LOCK field formats
        for(let name of this.fieldList['LOCK']){
            let value = issue[name];
            if(!error && !this.util.isNull(value) && !this.util.isValidLockValue(value))
                error = "invalid: " + name + " (format)";
        };

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify ISSUE is coming from TICK owner
        if(!error && tokenInfo && tokenInfo['OWNER']!=data['SOURCE'])
            error = 'invalid: issued by another address';

        // Reject any ISSUE that edits an existing tick while its ownership is escrowed
        // (covers v1 description edit, v2 mint params, v3 lock params, v4 callback params,
        // v5 list params, and v0 re-issuance from the existing owner). The escrow itself
        // was opened by a successful ORDER/SWAP/DISPENSER from the same SOURCE; only
        // closing the offer (via cancel/expire/match/sweep) releases this lock.
        if(!error && tokenInfo && await this.indexerDb.isOwnershipEscrowed(data['TICK']))
            error = 'invalid: TICK (ownership escrowed)';

        // Verify LOCK fields cannot be changed once enabled/locked
        for(let name of this.fieldList['LOCK']){
            let value = issue[name];
            if(!error && tokenInfo && !this.util.isNull(value) && !this.util.isValidLock(tokenInfo, issue, name))
                error = "invalid: " + name + " (locked)";
        }

        // Verify MAX_SUPPLY min/max
        if(!error && !this.util.isNull(data['MAX_SUPPLY']) && this.util.bcgt(data['MAX_SUPPLY'], 0) && (this.util.bclt(data['MAX_SUPPLY'], this.config.MIN_TOKEN_SUPPLY) || this.util.bcgt(data['MAX_SUPPLY'], this.config.MAX_TOKEN_SUPPLY)))
            error = 'invalid: MAX_SUPPLY (min/max)';

        // Verify MAX_SUPPLY is not set below current SUPPLY
        if(!error && !this.util.isNull(data['MAX_SUPPLY']) && this.util.bcgt(data['MAX_SUPPLY'], 0) && this.util.bclt(data['MAX_SUPPLY'], await this.indexerDb.getTokenSupply(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'])))
            error = 'invalid: MAX_SUPPLY < SUPPLY';

        // Verify a MAX_SUPPLY cap is declared before allowing LOCK_MAX_SUPPLY. The cap is taken from
        // this action when present, else the existing token record. Minted supply is NOT
        // required (a fair-mint token locks its cap at issuance, before any supply exists);
        // locking with no declared cap would permanently brick the TICK at a cap of zero.
        //
        // Gate: LOCK_MAX_SUPPLY_EXACT changes the guard from a truthy check to a strict ==1
        // check, fixing a false-positive where an explicit LOCK_MAX_SUPPLY=0 field (a no-op
        // lock intent) triggered the cap validation and produced an invalid outcome. The change
        // is gated so that a heterogeneous fleet and any from-genesis replay all switch over at
        // the same coordinated block, avoiding a ledger fork on any block carrying an explicit
        // LOCK_MAX_SUPPLY=0 field. Pre-launch chains activate at genesis (all zeros), so the
        // strict check is in force from block 0.
        let lockMaxSupplyExact = await this.actions.protocolChanges.isEnabled('LOCK_MAX_SUPPLY_EXACT', data['BLOCK_INDEX']);
        let lockMaxSupplySet   = lockMaxSupplyExact ? (data['LOCK_MAX_SUPPLY']==1) : data['LOCK_MAX_SUPPLY'];
        if(!error && lockMaxSupplySet){
            let lockCap = (!this.util.isNull(data['MAX_SUPPLY'])) ? data['MAX_SUPPLY'] : ((tokenInfo) ? tokenInfo['MAX_SUPPLY'] : null);
            if(this.util.isNull(lockCap) || this.util.bclt(lockCap, this.config.MIN_TOKEN_SUPPLY))
                error = 'invalid: LOCK_MAX_SUPPLY (no max supply)';
        }

        // Verify DECIMAL min/max
        if(!error && !this.util.isNull(data['DECIMALS']) && (this.util.bclt(data['DECIMALS'], this.config.MIN_TOKEN_DECIMALS) || this.util.bcgt(data['DECIMALS'], this.config.MAX_TOKEN_DECIMALS)))
            error = 'invalid: DECIMALS (min/max)';

        // Verify DECIMALS cannot be changed after supply has been issued
        if(!error && !this.util.isNull(data['DECIMALS']) && tokenInfo && this.util.bcgt(tokenInfo['SUPPLY'], 0) && String(data['DECIMALS'])!=String(tokenInfo['DECIMALS']))
            error = 'invalid: DECIMALS (locked)';

        // Verify TRANSFER addresses
        if(!error && !this.util.isNull(data['TRANSFER']) && !this.util.isCryptoAddress(data['TRANSFER']))
            error = 'invalid: TRANSFER (bad address)';

        // Verify TRANSFER_SUPPLY and SOURCE are different
        if(data['TRANSFER_SUPPLY'] == data['SOURCE'])
            delete data['TRANSFER_SUPPLY'];

        // Verify TRANSFER_SUPPLY addresses
        if(!error && !this.util.isNull(data['TRANSFER_SUPPLY']) && !this.util.isCryptoAddress(data['TRANSFER_SUPPLY']))
            error = 'invalid: TRANSFER_SUPPLY (bad address)';

        // Verify MINT_SUPPLY is allowed and LOCK_MINT_SUPPLY is not set
        if(!error && !this.util.isNull(data['MINT_SUPPLY']) && tokenInfo && tokenInfo['LOCK_MINT_SUPPLY']==1)
            error = 'invalid: MINT_SUPPLY (locked)';

        // Verify MINT_SUPPLY is less than MAX_SUPPLY
        if(!error && !this.util.isNull(data['MINT_SUPPLY']) && this.util.bcgt(data['MINT_SUPPLY'], data['MAX_SUPPLY']))
            error = 'invalid: MINT_SUPPLY > MAX_SUPPLY';

        // Verify MINT_ADDRESS_MAX is less than MAX_SUPPLY
        if(!error && !this.util.isNull(data['MINT_ADDRESS_MAX']) && this.util.bcgt(data['MINT_ADDRESS_MAX'], 0) && this.util.bcgt(data['MINT_ADDRESS_MAX'], data['MAX_SUPPLY']))
            error = 'invalid: MINT_ADDRESS_MAX > MAX_SUPPLY';

        // Verify MINT_ADDRESS_MAX is greater than than MAX_MINT
        if(!error && !this.util.isNull(data['MINT_ADDRESS_MAX']) && this.util.bcgt(data['MINT_ADDRESS_MAX'], 0) && this.util.bclt(data['MINT_ADDRESS_MAX'], data['MAX_MINT']))
            error = 'invalid: MINT_ADDRESS_MAX < MAX_MINT';

        // Verify MAX_SUPPLY can not be changed if LOCK_MAX_SUPPLY is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_MAX_SUPPLY'] && !this.util.isNull(data['MAX_SUPPLY']) && String(data['MAX_SUPPLY']) != String(tokenInfo['MAX_SUPPLY']))
            error = 'invalid: MAX_SUPPLY (locked)';

        // Verify MAX_MINT can not be changed if LOCK_MAX_MINT is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_MAX_MINT'] && !this.util.isNull(data['MAX_MINT']) && String(data['MAX_MINT']) != String(tokenInfo['MAX_MINT']))
            error = 'invalid: MAX_MINT (locked)';

        // Verify DESCRIPTION is under MAX_TOKEN_DESCRIPTION (rejects at exactly 250; effective max is 249 chars)
        if(!error && data['DESCRIPTION'] && String(data['DESCRIPTION']).length >= this.config.MAX_TOKEN_DESCRIPTION)
            error = 'invalid: DESCRIPTION (length)';

        // Verify DESCRIPTION can not be changed if LOCK_DESCRIPTION is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_DESCRIPTION'] && !this.util.isNull(data['DESCRIPTION']) && data['DESCRIPTION'] != tokenInfo['DESCRIPTION'])
            error = 'invalid: DESCRIPTION (locked)';

        // Verify CALLBACK_BLOCK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_BLOCK']) && String(data['CALLBACK_BLOCK']) != String(tokenInfo['CALLBACK_BLOCK']))
            error = 'invalid: CALLBACK_BLOCK (locked)';

        // Verify CALLBACK_TICK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_TICK']) && data['CALLBACK_TICK'] != tokenInfo['CALLBACK_TICK'])
            error = 'invalid: CALLBACK_TICK (locked)';

        // Verify CALLBACK_TICK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_AMOUNT']) && String(data['CALLBACK_AMOUNT']) != String(tokenInfo['CALLBACK_AMOUNT']))
            error = 'invalid: CALLBACK_AMOUNT (locked)';

        // Verify CALLBACK_BLOCK is greater than current block index
        if(!error && tokenInfo && !this.util.isNull(issue['CALLBACK_BLOCK']) && this.util.bclt(data['CALLBACK_BLOCK'], data['BLOCK_INDEX']))
            error = 'invalid: CALLBACK_BLOCK (block index)';

        // Verify CALLBACK_BLOCK can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_BLOCK']) && tokenInfo && String(data['CALLBACK_BLOCK']) != String(tokenInfo['CALLBACK_BLOCK']) && isDistributed)
            error = 'invalid: CALLBACK_BLOCK (supply distributed)';

        // Verify CALLBACK_TICK can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_TICK']) && tokenInfo && data['CALLBACK_TICK'] != tokenInfo['CALLBACK_TICK'] && isDistributed)
            error = 'invalid: CALLBACK_TICK (supply distributed)';

        // // Verify CALLBACK_AMOUNT can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_AMOUNT']) && tokenInfo && data['CALLBACK_AMOUNT'] != tokenInfo['CALLBACK_AMOUNT'] && isDistributed)
            error = 'invalid: CALLBACK_AMOUNT (supply distributed)';

        // Verify ALLOW_LIST is a valid list of addresses
        if(!error && !this.util.isNull(data['ALLOW_LIST']) && await this.indexerDb.isValidList(data['ALLOW_LIST'],2) == false)
            error = 'invalid: ALLOW_LIST (bad list)';

        // Verify BLOCK_LIST is a valid list of addresses
        if(!error && !this.util.isNull(data['BLOCK_LIST']) && await this.indexerDb.isValidList(data['BLOCK_LIST'],2) == false)
            error = 'invalid: BLOCK_LIST (bad list)';

        // Verify CONTROLLER references an existing, active contract on this chain.
        // The bound contract's `guard` method is consulted before guarded native
        // actions on this token settle (see Controller_Bound_Tokens.md). Mirrors the
        // contract-active check in actions/execute.js so a token can only bind to a
        // contract the indexer can actually execute. A guard whose `guard` method is
        // missing/throws is fail-closed at runtime (denies the action), not here.
        if(!error && !this.util.isNull(data['CONTROLLER'])){
            let controllerInfo = await this.indexerDb.getContract(data['CONTROLLER']);
            if(!controllerInfo){
                error = 'invalid: CONTROLLER (unknown)';
            } else {
                let controllerStatus = await this.indexerDb.getStatusString(controllerInfo.status_id);
                if(controllerStatus !== 'valid')
                    error = 'invalid: CONTROLLER (not active)';
            }
        }

        // Programmable policy layer: token controller bind/unbind (format 6). The CONTROLLER-active
        // check above already validated the bound contract (when CONTROLLER is set); here we validate
        // the per-action-class binding semantics. SOURCE-is-owner is enforced by the generic
        // "issued by another address" check above (tokenInfo is required, so it always applies).
        if(!error && format === 6){
            let actionClass = (this.util.isNull(data['ACTION_CLASS'])) ? null : String(data['ACTION_CLASS']).toLowerCase();
            let isUnbind    = (String(data['UNBIND']) === '1');
            if(!tokenInfo){
                // Can only bind a controller to an existing token you own
                error = 'invalid: TICK (unknown)';
            } else if(this.config['CONTROLLER_BINDABLE_CLASSES'].indexOf(actionClass) === -1){
                error = 'invalid: ACTION_CLASS (unknown)';
            } else {
                let tickId    = await this.indexerDb.getTickerId(data['TICK']);
                let effective = await this.indexerDb.getEffectiveTokenController(tickId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                if(isUnbind){
                    // UNBIND: an effective (still-gating) controller must exist for this class, and
                    // it must be a live bind. A second unbind while one is already in its cooldown
                    // window is rejected (the drop is already scheduled).
                    if(!effective)
                        error = 'invalid: ACTION_CLASS (not bound)';
                    else if(Number(effective.is_unbind) === 1)
                        error = 'invalid: ACTION_CLASS (already unbinding)';
                } else {
                    // BIND: CONTROLLER required, no controller may already gate this class (no
                    // stacking; replace = unbind-then-bind, which preserves the cooldown's teeth),
                    // and any COOLDOWN_BLOCKS given must be a non-negative integer.
                    if(this.util.isNull(data['CONTROLLER']))
                        error = 'invalid: CONTROLLER (null)';
                    else if(effective)
                        error = 'invalid: ACTION_CLASS (already bound)';
                    else if(!this.util.isNull(issue['COOLDOWN_BLOCKS']) && !/^\d+$/.test(String(issue['COOLDOWN_BLOCKS'])))
                        error = 'invalid: COOLDOWN_BLOCKS (format)';
                }
            }
        }

        // Verify MINT_START_BLOCK is greater than or equal to current block
        if(!error && !this.util.isNull(data['MINT_START_BLOCK']) && this.util.bcgt(data['MINT_START_BLOCK'], 0) && this.util.bclt(data['MINT_START_BLOCK'], data['BLOCK_INDEX']))
            error = 'invalid: MINT_START_BLOCK < BLOCK_INDEX';

        // Verify MINT_STOP_BLOCK is greater than or equal to current block
        if(!error && !this.util.isNull(data['MINT_STOP_BLOCK']) && this.util.bcgt(data['MINT_STOP_BLOCK'], 0) && this.util.bclt(data['MINT_STOP_BLOCK'], data['BLOCK_INDEX']))
            error = 'invalid: MINT_STOP_BLOCK < BLOCK_INDEX';

        // Verify MINT_STOP_BLOCK is greater than or equal to MINT_START_BLOCK
        if(!error && !this.util.isNull(data['MINT_STOP_BLOCK']) && this.util.bcgt(data['MINT_START_BLOCK'], 0) && this.util.bcgt(data['MINT_STOP_BLOCK'], 0) && this.util.bclt(data['MINT_STOP_BLOCK'], data['MINT_START_BLOCK']))
            error = 'invalid: MINT_STOP_BLOCK < MINT_START_BLOCK';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // The GAS token itself cannot pay an XCHAIN issuance fee to come into
        // existence (chicken-and-egg), so its genesis issuance is fee-exempt.
        // Only the exact GAS tick qualifies (subtokens like XCHAIN.foo do not),
        // and only its first issuance (!tokenInfo). Off regtest, GAS issuance is
        // restricted to the GAS address (checked above), so this cannot be abused.
        let gasBootstrap = (String(data['TICK']).toUpperCase() === String(this.config['GAS']).toUpperCase());

        // Determine if an issuance FEE is required, and what that fee is.
        // VM-emitted ISSUEs (IS_EMISSION) are fee-exempt by design: the deployer
        // already paid DEPLOY/EXECUTE gas (base + per-byte + per-emission gas) and
        // emissions are bounded by maxEmissions, so this is not a spam vector. This
        // mirrors the per-tx db_hits fee, which already skips emissions. The
        // exemption is gated by its own ISSUANCE_FEE_EMISSION_EXEMPT activation so
        // the change in fee behaviour switches over at a coordinated flag-day rather
        // than implicitly the moment a node upgrades (which would fork the ledger
        // between node versions on the first constructor that emits an ISSUE).
        // Before activation every node charges the fee (old behaviour); after it
        // every node exempts.
        let issuanceFeeActive = await this.actions.protocolChanges.isEnabled('ISSUANCE_FEE', data['BLOCK_INDEX']);
        let emissionExempt    = await this.actions.protocolChanges.isEnabled('ISSUANCE_FEE_EMISSION_EXEMPT', data['BLOCK_INDEX']);
        if(!error && !tokenInfo && !gasBootstrap && !(data['IS_EMISSION'] && emissionExempt) && issuanceFeeActive){
            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                // Unified gas schedule
                let schedule = this.config['GAS_SCHEDULE'];
                let gasCost  = parentInfo ? schedule.ISSUE_SUBTOKEN : schedule.ISSUE;
                fees['GAS_COST']     = gasCost;
                fees['AMOUNT']       = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);
                fees['FEE_VERSION']  = 2;
            } else {
                // Legacy per-chain fee
                if(parentInfo)
                    fees['AMOUNT'] = this.config['ISSUANCE_FEE_SUBTOKEN'];
                else
                    fees['AMOUNT'] = this.config['ISSUANCE_FEE_TOKEN'];
            }
        }

        // Validate fee payment (native coin or XCHAIN balance)
        if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(paymentMode === 'native'){
                // Native coin fee: validate against oracle price
                let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    fees['PAYMENT_MODE']       = 1;
                    fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    fees['NATIVE_COIN']        = validation.nativeCoin;
                    fees['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(paymentMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                // XCHAIN balance deduction (default)
                if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = issue['STATUS'] = status;

        // Print status message 
        console.log("\t ISSUE : " + data['TICK'] + ' : ' + data['STATUS']);

        // Create record in issues table
        await this.indexerDb.createIssue(issue);

        // Store the SOURCE and TICK in addresses list
        this.util.addAddressTicker(data['SOURCE'], data['TICK']);

        // Store the TRANSFER_SUPPLY and TICK in addresses list
        if(!this.util.isNull(data['TRANSFER_SUPPLY']))
            this.util.addAddressTicker(data['TRANSFER_SUPPLY'], data['TICK']);

        // If this was a valid transaction, then create the token record, and perform any additional actions
        if(status=='valid'){

            // Array of credits and debits
            let credits = [],
                debits  = [];

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Support token ownership transfers
            data['OWNER']  = (!this.util.isNull(data['TRANSFER'])) ? data['TRANSFER'] : data['SOURCE'];

            // Create/Update record in tokens table
            await this.indexerDb.createToken(data);

            // Programmable policy layer: append the token controller bind/unbind event (format 6).
            // The binding lives in token_controllers (not the token record); the issues row above is
            // the audit trail. issue['CONTROLLER']/['COOLDOWN_BLOCKS'] are the raw (pre-numeric)
            // values, which map cleanly onto the BIGINT/INT columns.
            if(format === 6){
                let tickId      = await this.indexerDb.getTickerId(data['TICK']);
                let actionClass = String(data['ACTION_CLASS']).toLowerCase();
                let boundById   = await this.indexerDb.createAddress(data['SOURCE']);
                if(String(data['UNBIND']) === '1'){
                    // The drop schedules at block + the live bind's committed cooldown; the controller
                    // keeps gating until then. effective is non-null + a live bind (validated above).
                    let effective   = await this.indexerDb.getEffectiveTokenController(tickId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                    let cooldown    = Number(effective.cooldown_blocks) || 0;
                    let cooldownEnd = parseInt(data['BLOCK_INDEX']) + cooldown;
                    await this.indexerDb.recordTokenControllerEvent({
                        action_index: data['ACTION_INDEX'], tick_id: tickId, action_class: actionClass,
                        contract_index: effective.contract_index, bound_by_id: boundById, is_unbind: 1,
                        cooldown_blocks: cooldown, cooldown_end_block: cooldownEnd, block_index: data['BLOCK_INDEX']
                    });
                } else {
                    let cooldown = (this.util.isNull(issue['COOLDOWN_BLOCKS'])) ? 0 : parseInt(issue['COOLDOWN_BLOCKS']);
                    await this.indexerDb.recordTokenControllerEvent({
                        action_index: data['ACTION_INDEX'], tick_id: tickId, action_class: actionClass,
                        contract_index: issue['CONTROLLER'], bound_by_id: boundById, is_unbind: 0,
                        cooldown_blocks: cooldown, cooldown_end_block: null, block_index: data['BLOCK_INDEX']
                    });
                }
            }

            // Credit MINT_SUPPLY to source address
            if(data['MINT_SUPPLY'])
                credits.push([data['TICK'], data['MINT_SUPPLY'], data['SOURCE']]);

            // Transfer MINT_SUPPLY to TRANSFER_SUPPLY address
            if(data['MINT_SUPPLY'] && data['TRANSFER_SUPPLY']){
                debits.push([data['TICK'],  data['MINT_SUPPLY'], data['SOURCE']]);
                credits.push([data['TICK'], data['MINT_SUPPLY'], data['TRANSFER_SUPPLY']]);
            }

            // Process any transaction ledger changes (credits / debits)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

            // Get a list of tickers & addresses
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            // Update address balances and token supply
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }

        // Create action mappings
        await this.mapper.createMappings(data);

    }
}

module.exports = Issue;