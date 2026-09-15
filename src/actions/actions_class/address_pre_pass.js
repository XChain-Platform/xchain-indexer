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
 * XChain Indexer - Actions class: deterministic address index-id pre-pass
 *
 * setActionParamHandler and assignActionAddressIds, mixed into Actions.prototype by
 * actions/index.js. processAction runs the pre-pass before every handler so a new
 * wire-field address's index id is pinned to its VALUE, not to handler intern order.
 *
 ********************************************************************/

// Canonical ADDRESS-reference field map (consensus surface; byte-identical copy in xchain-sdk)
const { ADDRESS_REF_FIELDS } = require('../../consensus/address_ref_fields.js');
const { getLogger } = require('../../observability/index.js');

// Collect single-value candidate address strings.
function wireAddressCandidates(util, specs, fields){
    let candidates = [];
    for(let spec of specs){
        if(spec.multi || spec.listType)
            continue;
        let val = fields[spec.field];
        if(util.isNull(val) || val === '')
            continue;
        // DEPLOY's BURN sentinel never reaches here (DEPLOY is not a setActionParams
        // handler), so no BURN resolution is needed in this path.
        candidates.push(String(val));
    }
    return candidates;
}

// Drop already-known references and addresses that already hold an id; dedupe by
// string value.
async function unassignedAddresses(actions, candidates){
    let pending = [];
    let seen    = new Set();
    for(let val of candidates){
        // A wire ^<id> is already a reference to an existing id; never a new assignment.
        if(val.substring(0,1) === '^')
            continue;
        // Only real crypto addresses get index ids (contract C:<CHAIN>:<idx> and
        // config-pinned addresses are created on their own deterministic paths).
        if(!actions.util.isCryptoAddress(val))
            continue;
        if(seen.has(val))
            continue;
        seen.add(val);
        // Already assigned (an earlier block, or SOURCE created in createActionIndex,
        // or an earlier candidate this action) -> skip.
        let existing = await actions.indexerDb.getAddressId(val);
        if(existing != null)
            continue;
        pending.push(val);
    }
    return pending;
}

module.exports = {

    // Map an ACTION name to the handler whose `formats` strings (and setActionParams
    // positional layout) define the wire fields. Only handlers that parse with
    // util.setActionParams are listed: their fixed positional layout lets the pre-pass
    // extract field values IDENTICALLY to the handler. SEND / ISSUE / SWEEP / DEPLOY use
    // bespoke parsing (repeating recipients, variable-length constructor params, etc.),
    // so they are deliberately absent here and their new addresses keep deterministic
    // handler-order assignment (still reorg-safe via the explicit index-id counter).
    // Also the public name of this map, so a caller OUTSIDE this class can ask the same
    // question the address pre-pass asks: "does this ACTION have a fixed positional wire
    // layout I may read a field out of?" batch.js's duration-fee pre-check (nominalDurationFee)
    // is the caller: it reads EXPIRATION's index out of the handler's own format string
    // instead of hardcoding a position, so a format change moves the pre-check with it.
    // This was a private map behind a same-named public delegator until the underscore
    // pass collapsed the pair: two honest names for one seam cost a hop on a consensus
    // path, and the rename the delegator was avoiding is the one that just happened.
    setActionParamHandler(action){
        switch(action){
            case 'MINT':      return this.actionMint;
            case 'MESSAGE':   return this.actionMessage;
            case 'DISPENSER': return this.actionDispenser;
            case 'ORDER':     return this.actionOrder;
            case 'SWAP':      return this.actionSwap;
            // ADDRESS is intentionally absent: ADDRESS_REF_FIELDS has no 'ADDRESS' key,
            // so assignActionAddressIds returns early before ever reaching this switch.
            // A case here would be unreachable dead code.
            default:          return null;
        }
    },

    // Pre-pass: assign deterministic, value-sorted index ids to the NEW wire-field
    // addresses an action introduces. See the call site in processAction and the
    // consensus note in src/consensus/address_ref_fields.js.
    async assignActionAddressIds(action, params, data, error){
        // Only assign during block processing: createAddress only does explicit-counter
        // (deterministic) assignment inside a transaction. Outside one this is a no-op.
        if(this.indexerDb.transactionConnection == null)
            return;
        // Skip pre-handler-rejected actions (unknown / not-yet-activated). Such an
        // action never reaches its handler, so interning its wire-field addresses would mint
        // index ids for an action that does nothing. (A semantic rejection INSIDE the handler
        // still interns, by design: the pre-pass exists to pin id-assignment ORDER, and the
        // cross-version divergence that creates is foreclosed pre-launch by clean reindex.)
        if(error)
            return;
        let specs = ADDRESS_REF_FIELDS[action];
        if(!specs || specs.length === 0)
            return;
        // Resolve the wire fields exactly as the handler will. Multi-value (repeating
        // SEND recipients) and type-gated (LIST.ITEM) fields are skipped here and keep
        // handler-order assignment; the handler interns them in a fixed, cross-node
        // deterministic order. Only handlers with a fixed setActionParams layout are
        // resolved (see setActionParamHandler).
        let handler = this.setActionParamHandler(action);
        if(!handler || !handler.formats)
            return;
        let format = data['FORMAT'];
        if(format === null || format === undefined || handler.formats[format] === undefined)
            return;
        let fields = this.util.setActionParams({}, params, handler.formats, format);
        let candidates = wireAddressCandidates(this.util, specs, fields);
        if(candidates.length === 0)
            return;
        let pending = await unassignedAddresses(this, candidates);
        if(pending.length === 0)
            return;
        // Byte (binary) sort by value: the consensus tiebreak (matches the utf8_bin
        // collation intent; independent of field layout and of any DB collation).
        pending.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
        // Stamp from the SINGLE authoritative block source. createAddress defaults
        // blockIndex to this.indexerDb.blockIndex (= blockToParse), the same source
        // createActionIndex uses to stamp SOURCE, so every id created in a block lands under
        // one block_index value and the rollback "WHERE block_index >= ?" delete cannot split
        // a block's ids. data['BLOCK_INDEX'] equals it today; warn loudly if it ever diverges.
        if(data['BLOCK_INDEX'] != this.indexerDb.blockIndex)
            getLogger().warn('Index id invariant: action BLOCK_INDEX (' + data['BLOCK_INDEX'] +
                ') != indexer blockIndex (' + this.indexerDb.blockIndex + '); stamping from indexer blockIndex.');
        // Assign each the next explicit dense id, in sorted order, stamped at this block.
        for(let addr of pending)
            await this.indexerDb.createAddress(addr);
    }
};
