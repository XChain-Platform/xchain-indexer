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
 * Strict `^<id>` address-reference rejection flag-day .
 *
 * db.resolveAddressRef turns a wire `^<id>` address reference back into its
 * canonical address string. When the reference is malformed (`^007`, `^0x10`,
 * `^abc`, `^-1`, `^`) or dangling (no row in the deterministic set) it returns
 * the value UNCHANGED, and every handler is expected to notice because its own
 * isCryptoAddress check rejects a string starting with `^`.
 *
 * That is fail-OPEN by construction: the resolver never states a verdict, so
 * safety depends on each of the ~10 call sites remembering to validate the
 * field afterwards. Three places already do not:
 *
 *  - DISPENSER.ORACLE_ADDRESS is only format-checked when the dispenser is
 *    actually using an oracle (`usingOracle`); otherwise an unresolvable
 *    reference rides through untouched.
 *  - DEPLOY.SLASH_DESTINATION is only format-checked once the separate
 *    DEPLOY_SLASH_DEST_ADDRESS_VALID flag-day is live.
 *  - ISSUE.TRANSFER / TRANSFER_SUPPLY skip their checks on the genesis path.
 *
 * The same shape is what  cost on SEND: one address-bearing handler
 * without the follow-up check, and the failure was silent and on chain. The
 * fix is to make the RESOLVER state the verdict (db.resolveAddressRefChecked)
 * and have every call site reject on it, so a future field cannot fail open by
 * omission.
 *
 * WHY A FLAG-DAY. Turning an unresolvable reference into a hard reject changes
 * a historic accept verdict into an invalid one at the three sites above, which
 * moves the block's credits/debits and therefore the ledger hash. Replaying
 * history under the new rule would diverge from every node that already
 * processed those blocks under the old one, so the rule is keyed on the chain's
 * OWN local block_index exactly like the sibling execution-path gates. Below the
 * threshold, and whenever the caller has no block context, the legacy fail-open
 * behaviour runs and historical replay stays byte-identical.
 *
 * WHAT DELIBERATELY DOES NOT CHANGE. resolveAddressRef still returns the
 * unresolvable value UNCHANGED in both eras. Substituting a sentinel would
 * drift persisted rows: handlers clone `data` into their table row (mints,
 * issues, ...) and write it even for an invalid action, so the stored
 * destination/transfer column would silently stop being the bytes that were on
 * the wire. The verdict therefore travels beside the value, never inside it.
 * Nothing new is interned either: createAddress already refuses to mint a row
 * for a literal '^...' string.
 *
 * EXECUTION-PATH gate (which actions validate), NOT a hashing-path change, so
 * this is INDEXER-ONLY with no xchain-sync twin: xchain-sync replicates
 * materialized rows and never runs an action handler.
 *
 ********************************************************************/

// Per-chain activation heights, interpreted against the chain's own block_index.
// Pinned to the  pre-freeze activation train, the SAME cohort and the same
// values as LIST_EDIT_RESOLUTION_ACTIVATION in list_edit_resolution_activation.js
// (which in turn rides BET_STATUS_STATE_HASH_ACTIVATION in stateHash.js): all three
// are execution-path validity changes on the same deploy train, so operators reason
// about one boundary rather than three. caret-ref-strict.test.js asserts this map is
// value-equal to that one, so a re-pin of the train has to move both or fail CI.
// CONFIRM again at train assembly: heights are only as good as the day measured.
const CARET_REF_STRICT_ACTIVATION = {
    'BTC:mainnet':  963000,     // tip 959,853 (2026-07-27) + 21d @144/day = 962,877
    'LTC:mainnet':  3162000,    // tip 3,149,481 + 21d @576/day = 3,161,577
    'DOGE:mainnet': 6338000,    // tip 6,307,307 + 21d @1440/day = 6,337,547
    // Testnet is genesis-active as of the 2026-08-10 fresh testnet genesis: the
    // chain restarts at firstBlock (BTC 147500 / LTC 4855000 / DOGE 67815000) with
    // no pre-rule history to preserve, so a mid-chain boundary would gate nothing
    // and only risk a fleet-split at a height nobody needs.
    'BTC:testnet':  0,
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the reject end to end
};

// Per-chain threshold with a network-wide fallback, byte-for-byte the lookup
// stateHash.js and list_edit_resolution_activation.js use. A coin-less caller
// (unit fixtures) falls through to the bare network key and stays inert on
// mainnet/testnet, which is the safe side.
function _activationThreshold(map, network, coin){
    if(coin != null && map[coin + ':' + network] !== undefined) return map[coin + ':' + network];
    return map[network];
}

// Whether an unresolvable `^<id>` reference is a hard reject for a block on
// `network`/`coin`. Below the threshold, an unparseable/absent block_index, or an
// unknown network -> off (legacy fail-open; historical replay byte-identical).
function isCaretRefStrictActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(CARET_REF_STRICT_ACTIVATION, network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

// Whether a POST-resolution value is still a wire reference, i.e. resolution
// failed. resolveAddressRef only ever returns either a canonical address (never
// caret-prefixed: createAddress refuses to intern a '^...' string) or the input
// unchanged, so a leading '^' after resolution means exactly "malformed or
// dangling reference". Null/undefined are not references (an absent optional
// field stays absent and is handled by the field's own null checks).
function isUnresolvedCaretRef(value){
    if(value === null || value === undefined) return false;
    return String(value).substring(0,1) === '^';
}

module.exports = {
    CARET_REF_STRICT_ACTIVATION,
    isCaretRefStrictActive,
    isUnresolvedCaretRef
};
