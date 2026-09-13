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
 * CONSENSUS SURFACE: the indexer assigns each new address a deterministic id by
 * walking the NEW addresses an action introduces in BYTE-SORTED VALUE order, so
 * only the SET of fields here matters, never their order, and that set per
 * action-version is pinned by the immutable wire format. Adding or removing a
 * field here is a wire-format-level change, never a routine edit.
 *
 * A byte-identical copy lives at xchain-sdk/src/addressRefFields.js, checked by
 * a conformance test. The SDK only compacts the unconditional single-value
 * fields (SDK_COMPACTABLE), a strict subset; the indexer registers ids for the
 * full set (including multi-value SEND destinations and type-gated LIST items).
 * Invariant: SDK-compacted must stay a subset of indexer-assigned, the SDK must
 * never emit a ^id the indexer would not recognise.
 *
 * Two single-value fields are held back from compaction even though the indexer
 * assigns them ids: the decoder keys off them but cannot resolve a `^<id>`
 * reference, since its address id space differs from the indexer's.
 *
 *  - DISPENSER.GET_ADDRESS (`noCompact`): the dispenser's operating-address key,
 *    which the decoder gates dispense detection on, so a compacted open would
 *    register a dead dispenser that never matches a payment.
 *  - DISPENSER.ORACLE_ADDRESS (`noCompact`): a Mode B dispenser pays its price
 *    oracle operator up front as a real native-coin output, and the indexer
 *    rejects the create when that output is missing. The indexer only sees
 *    outputs the decoder persisted, and the decoder captures the oracle output
 *    by reading ORACLE_ADDRESS out of this payload, so a compacted reference
 *    means no capture, and the create is rejected however much was paid.
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

// Per-action compactable field sets: the ACTION-AWARE gate the SDK address
// resolver applies. Each action's set is built from THAT ACTION'S OWN specs:
// a field is compactable for an action only if that action declares it
// single-value, non-type-gated and not `noCompact`.
//
// This used to be derived from the FLAT SDK_COMPACTABLE name set minus the
// action's `noCompact` fields, which silently defeated `multi`: MINT/MESSAGE/
// SWEEP each declare a single-value DESTINATION, so that name entered the flat
// set and came back to SEND, which declares DESTINATION as multi-value. The
// SDK then compacted single-recipient SEND destinations, but `src/actions/
// send.js` is the one address-bearing handler with no resolveAddressRef call,
// so those actions were rejected on chain: the first send to any address
// succeeded (before it had an id to compact to) and every subsequent send
// failed, with fees spent and tokens not moved.
//
// Deciding per action rather than by field NAME is the fix: a field name
// shared by two actions can no longer carry one action's permission into
// another. It also strictly narrows every other action's set, since the
// resolver only compacts fields actually present in the params, so SEND is
// the only behavioural change. The invariant restored is the one stated at
// the top of this file: SDK-compacted must stay a subset of
// indexer-resolvable, and must never be widened by accident.
const SDK_COMPACTABLE_BY_ACTION = (() => {
    const map = {};
    for (const action of Object.keys(ADDRESS_REF_FIELDS)) {
        map[action] = ADDRESS_REF_FIELDS[action]
            .filter((spec) => !spec.multi && !spec.listType && !spec.noCompact)
            .map((spec) => spec.field)
            .sort();
    }
    return map;
})();

module.exports = { ADDRESS_REF_FIELDS, SDK_COMPACTABLE, SDK_COMPACTABLE_BY_ACTION };
