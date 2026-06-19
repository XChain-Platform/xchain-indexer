/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain - canonical ADDRESS-reference field map
 *
 * The authoritative list of which ACTION params carry a blockchain ADDRESS
 * value. An address can be referenced on the wire either as its full string or
 * by its numeric id with a caret prefix (^57), exactly like a ticker (^1234).
 *
 * CONSENSUS SURFACE. The indexer assigns each new address a deterministic id by
 * walking the NEW addresses an action introduces in BYTE-SORTED VALUE order, so
 * the ORDER of fields in these lists is irrelevant: only the SET matters, and
 * that set per action-version is pinned by the (immutable) wire format. Adding
 * or removing a field here changes which values become consensus-relevant ids,
 * so it is a wire-format-level change, never a routine edit.
 *
 * A byte-identical copy lives at xchain-sdk/src/addressRefFields.js; a
 * conformance test diffs the two. The SDK only COMPACTS the unconditional
 * single-value fields (see SDK_COMPACTABLE), a strict subset, while the indexer
 * must register ids for the FULL set (including multi-value SEND destinations
 * and type-gated LIST items). The invariant is SDK-compacted ⊆ indexer-assigned:
 * the SDK must never emit a ^id the indexer would not recognise.
 *
 * Excluded on purpose:
 *  - SOURCE: the tx sender, registered first in db.createActionIndex; it is
 *    never a wire field and so is never a ^id reference.
 *  - COINPAY recipient: comes from a native-coin tx OUTPUT, not the payload.
 *  - SIGNING_PUBKEY / *_PUBKEY: Ed25519 keys, not addresses.
 *  - *_ACTION_INDEX, CONTRACT_ACTION_INDEX, LIST_ACTION_INDEX: action refs.
 *  - CONTROLLER (ISSUE v6 / ADDRESS v1): the ACTION_INDEX of a guard CONTRACT, not
 *    an address. The indexer validates it via getContract() and stores it as
 *    contract_index (token_controllers / address_controllers); it is never interned
 *    via createAddress, so it carries no index_addresses id and is never a ^<id>
 *    address reference.
 *
 ********************************************************************/

// Per-ACTION address-bearing fields. `multi:true` marks a field that can repeat
// (multi-recipient SEND); `listType:true` marks LIST.ITEM, which holds addresses
// only when the list's TYPE denotes an address list (the indexer gates on the
// same TYPE the LIST handler uses; the SDK does not compact it).
const ADDRESS_REF_FIELDS = {
    SEND:      [{ field: 'DESTINATION', multi: true }],
    MINT:      [{ field: 'DESTINATION' }],
    MESSAGE:   [{ field: 'DESTINATION' }],
    SWEEP:     [{ field: 'DESTINATION' }],
    ISSUE:     [{ field: 'TRANSFER' }, { field: 'TRANSFER_SUPPLY' }],
    DISPENSER: [{ field: 'GET_ADDRESS' }, { field: 'ORACLE_ADDRESS' }],
    ORDER:     [{ field: 'GET_ADDRESS' }],
    SWAP:      [{ field: 'GET_ADDRESS' }],
    DEPLOY:    [{ field: 'SLASH_DESTINATION' }],   // may be the "BURN" sentinel (resolved to the config burn address before id assignment)
    LIST:      [{ field: 'ITEM', multi: true, listType: true }],
};

// The unconditional, single-value fields the SDK may safely compact to ^id.
// Excludes multi-value (array) and type-gated (LIST.ITEM) fields, which the SDK
// leaves as full addresses. A field name appears once even if several actions
// use it (the SDK resolver keys by field name across actions, like tickResolver).
const SDK_COMPACTABLE = (() => {
    const set = new Set();
    for (const action of Object.keys(ADDRESS_REF_FIELDS))
        for (const spec of ADDRESS_REF_FIELDS[action])
            if (!spec.multi && !spec.listType) set.add(spec.field);
    return Array.from(set).sort();
})();

module.exports = { ADDRESS_REF_FIELDS, SDK_COMPACTABLE };
