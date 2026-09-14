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
 * ISSUE wire parse: the three flag days resolved once for the action's block, the
 * FORMAT gate, the positional PARAMS, the ^<id> address references, the storage clone
 * and the number formats.
 *
 * parseWire builds the context object every later part reads and writes (see
 * ./index.js). Each function runs with `this` bound to the Issue handler, called as
 * fn.call(this, ...), so it reads the handler's own config, util and indexerDb.
 *
 ********************************************************************/

'use strict';

// Token-bridge opt-in (ISSUE format 7), the policy-inheritance flag day and the tick
// namespace flag day. Standalone height-keyed modules, not protocol_changes.js entries,
// because the hub, SDK and explorer read the same maps; see the module headers.
const tokenBridgeActivation = require('../../token_bridge_activation.js');
const tokenPolicyActivation = require('../../token_policy_activation.js');
const tickNamespaceActivation = require('../../tick_namespace_activation.js');

// The flag days, the FORMAT gate and the positional PARAMS. Returns the context: the
// FORMAT, the (possibly replaced) data object, the verdict so far and the three flags.
async function parseWire(params, data, error){
    // Validate that format is known
    let format = data['FORMAT'];

    // Token-bridge flag days, resolved once against THIS action's block so every check
    // below sees one activation state. Keyed on the block_index of the chain being
    // parsed, never on a transfer's snapshot_block.
    let tokenBridgeActive = tokenBridgeActivation.isTokenBridgeActive(data['BLOCK_INDEX'], this.config['NETWORK']);
    let policyInheritance = tokenPolicyActivation.isTokenPolicyInheritanceActive(data['BLOCK_INDEX'], this.config['NETWORK']);
    // The tick-namespace flag day has its OWN constant, not the bridge's: the
    // bridge arms only after its own cross-check, and the namespace has to close
    // before anyone squats a future chain root, not after.
    let namespaceActive   = tickNamespaceActivation.isTickNamespaceActive(data['BLOCK_INDEX'], this.config['NETWORK']);

    // Format 7 does not exist below TOKEN_BRIDGE_ACTIVATION: it falls through to the
    // same 'invalid: VERSION (unknown)' an unknown version has always produced, so a
    // from-genesis replay of any chain reproduces every historical ISSUE verdict.
    if(!error && (format===null || this.formats[format] === undefined || (Number(format)===7 && !tokenBridgeActive)))
        error = 'invalid: VERSION (unknown)';

    // Parse PARAMS using given VERSION format and update transaction data object
    if(!error)
        data = this.util.setActionParams(data, params, this.formats, format);

    return { format, data, error, tokenBridgeActive, policyInheritance, namespaceActive };
}

// The ^<id> references, the storage clone (ctx.issue, the pre-merge wire snapshot the
// later rules compare against), the number formats and the two TICK character arrays.
async function resolveRefsAndClone(ctx){
    let data = ctx.data;
    let error = ctx.error;

    // Resolve compacted ^<id> TRANSFER / TRANSFER_SUPPLY references back to their
    // canonical addresses before the clone-for-storage and validation below, so the
    // SDK's default ^<id> wire form validates and is stored/credited identically to
    // the full address. At/after the address-ref resolution flag-day an unresolvable
    // reference is a hard reject here; below it the value is left as-is and rejected
    // by the isCryptoAddress checks (which the IS_GENESIS path skips, so those two
    // fields had no rejection at all on that path). See resolveAddressRefChecked.
    if(!error){
        let transferRef = await this.indexerDb.resolveAddressRefChecked(data['TRANSFER'], data['BLOCK_INDEX']);
        data['TRANSFER'] = transferRef.value;
        let supplyRef = await this.indexerDb.resolveAddressRefChecked(data['TRANSFER_SUPPLY'], data['BLOCK_INDEX']);
        data['TRANSFER_SUPPLY'] = supplyRef.value;
        if(transferRef.rejected)
            error = 'invalid: TRANSFER (unresolvable ^id)';
        else if(supplyRef.rejected)
            error = 'invalid: TRANSFER_SUPPLY (unresolvable ^id)';
    }

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

    Object.assign(ctx, { data, issue, error, allowedCharacters, tickCharacters });
}

module.exports = { parseWire, resolveRefsAndClone };
