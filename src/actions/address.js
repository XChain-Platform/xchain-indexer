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
 * XChain Platform Action - ADDRESS
 * 
 * This action configures address specific options.
 * 
 * PARAMS:
 * - VERSION              - Format Version
 * - FEE_PREFERENCE       - Set preference for how `FEE` is used
 * - REQUIRE_MEMO         - Require a `MEMO` on any received `SEND`
 * - DISPENSER_PREFERENCE - Who may open dispensers on this address
 * - MEMO                 - An optional memo to include
 *
 * FEE_PREFERENCE Options :
 * - 1 = `FEE` is destroyed, lowering supply
 * - 2 = `FEE` to donated to protocol development (default)
 * - 3 = `FEE` to donated to community development
 *
 * DISPENSER_PREFERENCE Options :
 * - 1 = Only owner can open dispenser (default)
 * - 2 = Anyone can open dispenser
 *
 * FORMATS:
 * - 0 = Full (address preferences)
 * - 1 = Controller bind/unbind — VERSION|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO
 *       Self-gate one action-class of this account with a guard contract (address_controllers).
 *
 ********************************************************************/

class Address {

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
        this.formats[0] = 'VERSION|FEE_PREFERENCE|REQUIRE_MEMO|DISPENSER_PREFERENCE|MEMO';
        // Programmable policy layer — self-gate one action-class of THIS account by binding a guard
        // contract (address_controllers table model). Self-signed (SOURCE is the account). One binding
        // change per action; UNBIND=1 drops the live binding for ACTION_CLASS. COOLDOWN_BLOCKS is
        // committed at bind time and is the friction on a later drop. See Controller_Bound_Tokens.md.
        this.formats[1] = 'VERSION|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['FEE_PREFERENCE', 'REQUIRE_MEMO', 'DISPENSER_PREFERENCE'];

        // Define lists of valid field values
        this.validValues = {};

        // Define list of valid FEE_PREFERENCE values
        this.validValues['FEE_PREFERENCE'] = [0,1,2];

        // Define list of valid REQUIRE_MEMO values
        this.validValues['REQUIRE_MEMO'] = [0,1];

        // Define list of valid DISPENSER_PREFERENCE values
        this.validValues['DISPENSER_PREFERENCE'] = [1,2];
    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = "0|1|1|my address update";
        // params  = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical
        for(let name of this.fieldList['NUMBER']){
            let value = data[name];
            if(!this.util.isNull(value) && this.util.isNumeric(value))
                data[name] = this.util.bcnum(value);
        }

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify FEE_PREFERENCE is numeric
        if(!error && !this.util.isNull(data['FEE_PREFERENCE']) && !this.util.isNumeric(data['FEE_PREFERENCE']))
            error = "invalid: FEE_PREFERENCE (format)";

        // Verify REQUIRE_MEMO is numeric
        if(!error && !this.util.isNull(data['REQUIRE_MEMO']) && !this.util.isNumeric(data['REQUIRE_MEMO']))
            error = "invalid: REQUIRE_MEMO (format)";

        // Verify DISPENSER_PREFERENCE is numeric
        if(!error && !this.util.isNull(data['DISPENSER_PREFERENCE']) && !this.util.isNumeric(data['DISPENSER_PREFERENCE']))
            error = "invalid: DISPENSER_PREFERENCE (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify FEE_PREFERENCE value is valid
        if(!error && !this.util.isNull(data['FEE_PREFERENCE']) && !this.validValues['FEE_PREFERENCE'].includes(Number(data['FEE_PREFERENCE'])))
            error = 'invalid: FEE_PREFERENCE (value)';

        // Verify REQUIRE_MEMO value is valid
        if(!error && !this.util.isNull(data['REQUIRE_MEMO']) && !this.validValues['REQUIRE_MEMO'].includes(Number(data['REQUIRE_MEMO'])))
            error = 'invalid: REQUIRE_MEMO (value)';

        // Verify DISPENSER_PREFERENCE value is valid
        if(!error && !this.util.isNull(data['DISPENSER_PREFERENCE']) && !this.validValues['DISPENSER_PREFERENCE'].includes(Number(data['DISPENSER_PREFERENCE'])))
            error = 'invalid: DISPENSER_PREFERENCE (value)';

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

        // Programmable policy layer — verify CONTROLLER references an existing, active contract on
        // this chain (BIND only; on UNBIND the CONTROLLER field is empty and ignored). Mirrors the
        // ISSUE/execute contract-active check; a guard whose `guard` method is missing/throws is
        // fail-closed at runtime, not here.
        if(!error && format === 1 && !this.util.isNull(data['CONTROLLER'])){
            let controllerInfo = await this.indexerDb.getContract(data['CONTROLLER']);
            if(!controllerInfo){
                error = 'invalid: CONTROLLER (unknown)';
            } else {
                let controllerStatus = await this.indexerDb.getStatusString(controllerInfo.status_id);
                if(controllerStatus !== 'valid')
                    error = 'invalid: CONTROLLER (not active)';
            }
        }

        // Programmable policy layer — address controller bind/unbind semantics (format 1, self-signed).
        if(!error && format === 1){
            let actionClass = (this.util.isNull(data['ACTION_CLASS'])) ? null : String(data['ACTION_CLASS']).toLowerCase();
            let isUnbind    = (String(data['UNBIND']) === '1');
            if(this.config['CONTROLLER_BINDABLE_CLASSES'].indexOf(actionClass) === -1){
                error = 'invalid: ACTION_CLASS (unknown)';
            } else {
                let addressId = await this.indexerDb.getAddressId(data['SOURCE']);
                let effective = (addressId === null) ? null : await this.indexerDb.getEffectiveAddressController(addressId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                if(isUnbind){
                    // UNBIND: an effective (still-gating) controller must exist, and it must be a live
                    // bind — a second unbind while one is already in its cooldown window is rejected.
                    if(!effective)
                        error = 'invalid: ACTION_CLASS (not bound)';
                    else if(Number(effective.is_unbind) === 1)
                        error = 'invalid: ACTION_CLASS (already unbinding)';
                } else {
                    // BIND: CONTROLLER required, no controller may already gate this class (no stacking;
                    // replace = unbind-then-bind), and any COOLDOWN_BLOCKS given is a non-negative integer.
                    if(this.util.isNull(data['CONTROLLER']))
                        error = 'invalid: CONTROLLER (null)';
                    else if(effective)
                        error = 'invalid: ACTION_CLASS (already bound)';
                    else if(!this.util.isNull(data['COOLDOWN_BLOCKS']) && !/^\d+$/.test(String(data['COOLDOWN_BLOCKS'])))
                        error = 'invalid: COOLDOWN_BLOCKS (format)';
                }
            }
        }

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message 
        console.log("\t ADDRESS : " + data['SOURCE'] + ' : ' + data['STATUS']);

        // Persist the action. Format 0 writes address preferences; format 1 (controller binding)
        // writes address_controllers and must NOT touch the preferences row (a null-preference
        // write would be read back by getAddressPreferences as fee_preference=0). The CONTROLLER /
        // COOLDOWN_BLOCKS fields are not in this action's NUMBER list, so they remain raw strings
        // that map cleanly onto the BIGINT/INT columns.
        if(format === 1){
            if(status === 'valid'){
                let addressId   = await this.indexerDb.createAddress(data['SOURCE']);
                let actionClass = String(data['ACTION_CLASS']).toLowerCase();
                if(String(data['UNBIND']) === '1'){
                    // effective is non-null + a live bind (validated above); drop schedules at
                    // block + its committed cooldown.
                    let effective   = await this.indexerDb.getEffectiveAddressController(addressId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                    let cooldown    = Number(effective.cooldown_blocks) || 0;
                    let cooldownEnd = parseInt(data['BLOCK_INDEX']) + cooldown;
                    await this.indexerDb.recordAddressControllerEvent({
                        action_index: data['ACTION_INDEX'], address_id: addressId, action_class: actionClass,
                        contract_index: effective.contract_index, is_unbind: 1,
                        cooldown_blocks: cooldown, cooldown_end_block: cooldownEnd, block_index: data['BLOCK_INDEX']
                    });
                } else {
                    let cooldown = (this.util.isNull(data['COOLDOWN_BLOCKS'])) ? 0 : parseInt(data['COOLDOWN_BLOCKS']);
                    await this.indexerDb.recordAddressControllerEvent({
                        action_index: data['ACTION_INDEX'], address_id: addressId, action_class: actionClass,
                        contract_index: data['CONTROLLER'], is_unbind: 0,
                        cooldown_blocks: cooldown, cooldown_end_block: null, block_index: data['BLOCK_INDEX']
                    });
                }
            }
        } else {
            // Create record in addresses table
            await this.indexerDb.createAddressOption(data);
        }

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE']);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Address;