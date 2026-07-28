/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * PRICE v0 signature-tally ordering flag-day .
 *
 * WHAT CHANGES. The PRICE v0 tally walks the round's signature list, keeps at
 * most one signature per pubkey, and counts the survivors toward quorum. Below
 * this gate the pubkey enters the dedupe set on FIRST ENCOUNTER, ahead of the
 * capability check and ahead of the ed25519 verify (mark-then-verify). At/above
 * it the pubkey enters the dedupe set only AFTER its signature verifies
 * (verify-then-mark). The one-per-pubkey cap is unchanged in both eras.
 *
 * WHY. Mark-then-verify is order-dependent: a garbage signature carrying a
 * qualified oracle's pubkey, placed AHEAD of that oracle's real signature,
 * consumes the pubkey's dedupe slot. The real signature is then skipped as a
 * duplicate, the round under-counts, and a legitimately quorate round is
 * rejected on chain. Anyone who can see a round before it is broadcast can mint
 * that list; the sigs are public. Every other tally site in the platform
 * (nodeproof, xcall, xexec, cross_settle, anchor, recovery, hub_db_sync, and
 * their hub twins) is verify-then-mark already; PRICE was the last pair, found
 * by the  Pkg 13 twin-parity audit 2026-07-27.
 *
 * WHY IT NEEDS A GATE AT ALL, when the Pkg 13 sites shipped ungated. Those sites
 * were provably dormant on mainnet (empty capability sets, no history, or a
 * flag-day still in the future), so a from-genesis reindex could not observe the
 * change. PRICE is the opposite: genesis-active on mainnet with a NON-EMPTY
 * price-capability validator set and live rounds already on chain. Changing the
 * tally without a gate would change which historical PRICE actions tally quorate
 * on reindex, so replay would diverge from the chain the fleet already agreed on.
 * Below the gate the legacy ordering is preserved verbatim, so replay of every
 * pre-flag-day round stays bit-identical.
 *
 * THE CHANGE IS MONOTONE, WHICH IS *WHY* IT IS CONSENSUS-VISIBLE. Post-gate the
 * qualified-signer set is a SUPERSET of the pre-gate set: any pubkey that had a
 * verifying, capability-qualified signature anywhere in the list now counts,
 * where before only its first occurrence was considered. Nothing that tallied
 * quorate becomes non-quorate. Three things move with it, all consensus state:
 *   1. count quorum: validSigs is non-decreasing, so accept-set only grows;
 *   2. stake-weighted quorum: the summed signer stake is non-decreasing
 *      (weights are non-negative, source-deduped), so likewise;
 *   3. the oracle_round REWARD split, which divides the round budget over the
 *      qualified signer set: a round can stay valid yet pay a DIFFERENT split.
 * (3) is why "it only ever accepts more" is not on its own an argument for
 * shipping ungated: the reward rows are consensus state too.
 *
 * HEIGHT-KEYED ON THE ROUND'S BTC ANCHOR, exactly like
 * STAKE_WEIGHTED_QUORUM_ACTIVATION and for the same reason. PRICE v0 is
 * publishable on any chain (DOGE is recommended for fees), and BTC/LTC/DOGE
 * heights diverge by millions, so keying on the landing chain's local height
 * would make the comparison vacuously true on LTC/DOGE and flip the rule there
 * months before BTC. The round's BTC_BLOCK_HEIGHT is inside the signed payload
 * (ed25519.buildPriceV0Payload), so it cannot be forged, and the hub push
 * carries and validates the same field (PriceAggregator: `btc_block_height`).
 * Both sides therefore key on the IDENTICAL number, with none of the
 * timestamp-vs-block-time asymmetry price_pair_activation.js has to live with.
 *
 * DEPLOY ORDER. Indexers and hubs are peers here, not producer and consumer: a
 * hub that tallies verify-first while an indexer still tallies mark-first would
 * finalize and store a round the chain rejects (and vice versa). Deploy every
 * indexer AND every hub before the activation height; the gate itself then flips
 * them all on the same BTC anchor.
 *
 * LOCAL COPY of the canonical map in
 * xchain-documentation/protocol/constants.js (PRICE_SIG_TALLY_ACTIVATION), kept
 * value-identical by test/unit/activationConstantsParity.test.js and
 * byte-identical to the hub copy by the hub's price_sig_tally_activation.test.js.
 * A one-sided edit forks PRICE v0 accept/reject at the flag-day.
 *
 ********************************************************************/

'use strict';

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Keyed on the round's BTC-anchored
// BTC_BLOCK_HEIGHT, NOT the landing chain's local height, so the hub and the BTC,
// LTC and DOGE indexers all flip on the same anchor.
//
// mainnet is ARMED to 969500, the BTC snapshot_block the operator already
// ratified on 2026-07-16 for RETRACTION_SIGNING_ACTIVATION (~2026-10-01, derived
// from tip 957062 on 07-07 at ~144 blocks/day). Reusing a ratified anchor rather
// than minting a new one, and deliberately NOT the nearer 961000 anchor: that
// train shipped on 2026-07-23 and its BTC anchor is ~2026-08-04, so arming here
// would demand a second fleet-wide indexer+hub deploy inside a week, and any node
// that missed it would fork on the first round carrying a garbage signature ahead
// of a real one. 969500 leaves the usual "deploy every consumer before this era"
// runway.
//
// testnet/regtest activate at genesis (same convention as
// STAKE_WEIGHTED_QUORUM_ACTIVATION and ATTEST_ADMISSION_ACTIVATION, which are
// also verdict-changing): the test venues run the corrected tally from block 0.
const PRICE_SIG_TALLY_ACTIVATION = {
    mainnet: 969500,      // ARMED : BTC anchor ~2026-10-01, ratified for RETRACTION_SIGNING; deploy ALL indexers + hubs before this height
    testnet: 0,
    regtest: 0,
};

// Whether the corrected verify-then-mark tally is in effect for a round whose
// signed BTC anchor is `btcBlockHeight` on `network`. Below it -> the legacy
// mark-then-verify ordering, preserved verbatim.
//
// Fails CLOSED on anything it cannot evaluate: an unparseable height, an
// unrecognized network, or a null/disarmed threshold yields false, i.e. the
// legacy ordering. Closed is the safe direction because the legacy ordering is
// what the deployed fleet already enforces, so a node that cannot evaluate the
// gate stays with the majority instead of unilaterally accepting a round nobody
// else will.
function isPriceSigTallyVerifyFirstActive(btcBlockHeight, network){
    // Reject the empty-ish values BEFORE parseInt(): on a genesis-on network
    // (threshold 0) a coerced 0 would read as ACTIVE, silently flipping the tally
    // on a round whose anchor could not be read instead of failing closed.
    if(btcBlockHeight === null || btcBlockHeight === undefined ||
       btcBlockHeight === '' || typeof btcBlockHeight === 'boolean')
        return false;
    let h = parseInt(btcBlockHeight);
    if(!Number.isFinite(h)) return false;
    let threshold = PRICE_SIG_TALLY_ACTIVATION[network];
    // undefined -> unknown network; null -> deliberately disarmed. Both off.
    if(threshold === undefined || threshold === null) return false;
    return h >= threshold;
}

module.exports = {
    PRICE_SIG_TALLY_ACTIVATION,
    isPriceSigTallyVerifyFirstActive,
};
