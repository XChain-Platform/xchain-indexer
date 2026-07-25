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
 * Two single-value fields are held back from compaction even though the indexer
 * assigns them ids, and for the same underlying reason: the DECODER keys work off
 * them but has no way to resolve a `^<id>` reference (its index_addresses id space
 * differs from the indexer's).
 *
 *  - DISPENSER.GET_ADDRESS (`noCompact`): the dispenser's operating-address key,
 *    which the decoder gates dispense detection on, so a compacted open would
 *    register a dead dispenser that never matches a payment.
 *  - DISPENSER.ORACLE_ADDRESS (`noCompact`): a Mode B dispenser pays its PRICE v1
 *    oracle operator up front as a real native-coin output, and the indexer rejects
 *    the create when that output is missing (validateOracleFee, ). The indexer
 *    only sees outputs the DECODER persisted, and the decoder captures the oracle
 *    output by reading ORACLE_ADDRESS out of this payload  - so a compacted
 *    reference means no capture, and the create is rejected however much was paid.
 *
 * The SDK therefore emits the full address for both; the per-action compactable sets
 * live in SDK_COMPACTABLE_BY_ACTION.
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
// same TYPE the LIST handler uses; the SDK does not compact it). `noCompact:true`
// marks a single-value field the indexer still assigns an id for but the SDK must
// NOT emit in `^<id>` form: DISPENSER.GET_ADDRESS and DISPENSER.ORACLE_ADDRESS
// (see the consensus note above).
const ADDRESS_REF_FIELDS = {
    SEND:      [{ field: 'DESTINATION', multi: true }],
    MINT:      [{ field: 'DESTINATION' }],
    MESSAGE:   [{ field: 'DESTINATION' }],
    SWEEP:     [{ field: 'DESTINATION' }],
    ISSUE:     [{ field: 'TRANSFER' }, { field: 'TRANSFER_SUPPLY' }],
    DISPENSER: [{ field: 'GET_ADDRESS', noCompact: true }, { field: 'ORACLE_ADDRESS', noCompact: true }],
    ORDER:     [{ field: 'GET_ADDRESS' }],
    SWAP:      [{ field: 'GET_ADDRESS' }],
    DEPLOY:    [{ field: 'SLASH_DESTINATION' }],   // may be the "BURN" sentinel (resolved to the config burn address before id assignment)
    LIST:      [{ field: 'ITEM', multi: true, listType: true }],
};

// The single-value fields the SDK may compact to ^id, as a flat field-name set
// (the union across actions, IGNORING per-action `noCompact` exemptions). Excludes
// multi-value (array) and type-gated (LIST.ITEM) fields, which the SDK leaves as
// full addresses. This flat set documents the eligible field names and is the
// consensus-drift guard; the ACTION-AWARE gate the resolver actually applies is
// SDK_COMPACTABLE_BY_ACTION below.
const SDK_COMPACTABLE = (() => {
    const set = new Set();
    for (const action of Object.keys(ADDRESS_REF_FIELDS))
        for (const spec of ADDRESS_REF_FIELDS[action])
            if (!spec.multi && !spec.listType) set.add(spec.field);
    return Array.from(set).sort();
})();

// Per-action compactable field sets — the ACTION-AWARE gate the SDK address
// resolver applies. Each action's set is the flat SDK_COMPACTABLE MINUS the fields
// that action marks `noCompact`. Basing it on the flat set preserves the existing
// field-name compaction (e.g. a single-recipient SEND DESTINATION is still
// compacted; a multi-recipient array value is skipped by the resolver's runtime
// array guard), while the per-action subtraction lets one action hold a field back
// that another still compacts — DISPENSER.GET_ADDRESS is emitted in full while
// ORDER/SWAP.GET_ADDRESS stay compacted. The union stays ⊆ the indexer-assigned set.
const SDK_COMPACTABLE_BY_ACTION = (() => {
    const map = {};
    for (const action of Object.keys(ADDRESS_REF_FIELDS)) {
        const held = new Set();
        for (const spec of ADDRESS_REF_FIELDS[action])
            if (spec.noCompact) held.add(spec.field);
        map[action] = SDK_COMPACTABLE.filter((f) => !held.has(f));
    }
    return map;
})();

module.exports = { ADDRESS_REF_FIELDS, SDK_COMPACTABLE, SDK_COMPACTABLE_BY_ACTION };
