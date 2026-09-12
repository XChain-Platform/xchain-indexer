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
 * STAKE v1 signing-key REUSE flag day: a key whose every stake row is
 * deactivated and past cooldown may STAKE v1 again.
 *
 * THE GAP. STAKE v1 refuses a SIGNING_PUBKEY that already holds a stake. The
 * check is getActiveStakeByPubkey(pubkey, null), and in db.js the whole
 * activation/deactivation clause of that predicate is gated on a non-null
 * blockIndex, so null reduces the query to "does this pubkey have ANY valid
 * stakes row, EVER". Those rows are never deleted: UNSTAKE stamps
 * deactivation_block on them (setStakeDeactivationByPubkey) and a ROLLCALL
 * eviction stamps the same column through the same mechanism
 * (setStakeDeactivationBySourceAndPubkey). So a key that unstaked voluntarily,
 * sat out its cooldown and was credited, or that ROLLCALL evicted for absence,
 * answers 'invalid: SIGNING_PUBKEY (already in use)' for the rest of the
 * chain's life. Nothing holds that key and no stake weight rests on it: it is
 * simply burned, and the operator has to mint and publish a fresh key to come
 * back. That is a cost the protocol never meant to charge, and the validator
 * liveness/eviction design assumes the opposite (an evicted operator re-stakes
 * and rejoins, with the key the fleet already knows).
 *
 * WHY THE NULL WAS THERE, AND WHY THE OBVIOUS FIX IS WRONG. The null
 * blockIndex was avoiding a narrower hole. Pass the real block instead and the
 * legacy predicate adds `activation_block <= blockIndex`, which HIDES a row
 * staked moments ago that has not cleared its ACTIVATION_DELAY_BLOCKS window:
 * two STAKE v1 actions on one key inside the activation delay would both be
 * accepted, and the same key would carry two independent bonds. The db opts
 * flag `undeactivatedOnly` has the identical defect for the identical reason.
 * That is why this gate selects a THIRD query mode rather than reusing either
 * of them. The reuse question is not "is this key ACTIVE" but "is this key
 * FREE", and a pending-activation row means it is not free.
 *
 * THE RULE. At and above the flag day a SIGNING_PUBKEY is admissible for
 * STAKE v1 when EVERY valid stakes row it has ever held satisfies BOTH of:
 *
 *     deactivation_block IS NOT NULL
 *     deactivation_block + COOLDOWN_BLOCKS <= the block being parsed
 *
 * Any row that is active, pending activation, or deactivated but still inside
 * cooldown refuses the action, under the SAME verdict string the legacy path
 * emits: the gate moves WHICH keys are admitted, never how a refusal reads.
 * Voluntary unstake and ROLLCALL eviction are treated alike, deliberately:
 * both write deactivation_block through the same setter with the same
 * arithmetic, so the predicate cannot tell them apart and does not try.
 *
 * WHY THE COOLDOWN IS ANCHORED ON THE STAKES ROW, NOT ON THE UNSTAKES ROW.
 * The exact cooldown end is `unstakes.cooldown_end_block`
 * (= B + COOLDOWN_BLOCKS), while this predicate computes
 * deactivation_block + COOLDOWN_BLOCKS (= B + ACTIVATION_DELAY_BLOCKS +
 * COOLDOWN_BLOCKS). The gate therefore frees a key exactly
 * ACTIVATION_DELAY_BLOCKS after the credit lands, never before, and three
 * things are bought with those blocks: the predicate stays ONE row set with no
 * join, so it is expressible in SQL against `stakes` alone; it needs no
 * `unstakes` row to exist, which matters because the two writes are separate
 * statements and only the stakes stamp is what makes a key unusable; and every
 * error in the arithmetic falls on the REFUSING side, which is the legacy
 * behaviour. A tighter anchor would have to justify the join and the
 * fail-open direction, and nothing needs the six blocks.
 *
 * DIRECTION OF SAFETY. Below the gate the predicate is the legacy one, byte
 * for byte: every key the deployed fleet refuses is still refused and every
 * key it admits is still admitted, so a from-genesis replay of every STAKE in
 * hashed history is unchanged. At and above it the predicate only ever
 * ADMITS keys the legacy rule refused; it never refuses a key the legacy rule
 * admitted (a key with no rows at all has no row to fail the new clause, and
 * the legacy rule admitted exactly those). So the gate is a strict widening in
 * one direction, and the failure mode of an unevaluable gate is the legacy
 * refusal.
 *
 * CONSENSUS-AFFECTING, so gated. The verdict on a STAKE v1 action decides
 * whether a bond is debited and escrowed and whether the key joins the
 * capability set, all of which land in hashed history. A one-sided deploy
 * forks the fleet on the first re-stake of a retired key. Gating is what lets
 * the new branch ship, sit dark, and flip on one height that every node agrees
 * on.
 *
 * HEIGHT-KEYED per network AND coin, not time-keyed. Stake rows, their
 * activation delay and their cooldown are all counted in the PROCESSING
 * CHAIN'S OWN blocks (config STAKING.COOLDOWN_BLOCKS is 1000 on BTC, 4032 on
 * LTC, 10080 on DOGE, each sized to about seven days at that chain's block
 * time), so the quantity this rule reasons about is a height, and a wall-clock
 * cutover would arm mid-cooldown at a different point on each chain. Capability
 * STAKE v1 is BTC-only today, so only the BTC rows can ever bite; the LTC and
 * DOGE keys are carried anyway, because the map's shape is what a later
 * multi-chain capability stake would read and a missing key is an inert gate
 * rather than a decision.
 *
 * SIZING (method, so a later re-pin can be re-derived rather than guessed).
 *   regtest 0: genesis-active, so the e2e venue exercises the armed rule from
 *   block 0 rather than leaving it dark until a flag day. Regtest stacks are
 *   rebuilt from genesis, so nothing in a regtest ledger is re-graded.
 *
 *   mainnet null: the INERT sentinel. Mainnet writes are held and the instant
 *   is the operator's, sized on the train that arms it and strictly above the
 *   fleet's deploy tip at that moment. A height already passed is not a flag
 *   day: a node replaying from genesis would apply the rule where a
 *   long-running node never did, and the two diverge at the first hash
 *   comparison.
 *
 *   testnet armed per coin, at the measured tip plus 21 days of that chain's
 *   blocks, rounded up to a clean number. This is the headroom the height-keyed
 *   gates in this directory already use (caret_ref_strict,
 *   list_edit_resolution, ledger_amount_precision all read "tip + 21d" at the
 *   chain's target rate) and the three weeks the newest sized gate,
 *   price_zero_validity, allowed itself on testnet. Testnet carries live public
 *   ledgers with real staking history, so it is armed ahead rather than at
 *   genesis: a genesis arming there would re-grade STAKE v1 actions already in
 *   testnet history (every refused re-stake of a retired key would become
 *   valid), which is a rewrite, not a flag day.
 *
 *   Tips measured 2026-09-11 off the platform's own testnet explorer status
 *   endpoint (/TBTC|/TLTC|/TDOGE api/status, field chain_tip), never a mainnet
 *   service. Rates are each chain's target block time, the same figures the
 *   gates above used: BTC 144/day, LTC 576/day, DOGE 1440/day.
 *
 *     BTC  tip    151,991 + 3,024  (21d @144/day)  =    155,015 ->    156,000
 *     LTC  tip  4,883,971 + 12,096 (21d @576/day)  =  4,896,067 ->  4,897,000
 *     DOGE tip 67,887,900 + 30,240 (21d @1440/day) = 67,918,140 -> 67,920,000
 *
 * NOT VENDORED into xchain-sync. This is an execution-path admission decision
 * during action processing, not a hashing-path change: the sync follower's
 * BlockHasher reads already-materialized action rows and never re-runs STAKE
 * validation, and xchain-sync carries no copy of getActiveStakeByPubkey nor of
 * the 'already in use' verdict. The shared armed-map fingerprint list is built
 * to tolerate a carrier only one repo has, and no parity test or sync guard
 * asks for a twin of this file.
 *
 ********************************************************************/

'use strict';

// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height a SIGNING_PUBKEY whose every stake row is
// deactivated and past cooldown is admissible for STAKE v1; below it the
// legacy "any valid stakes row ever" refusal runs unchanged.
const STAKE_KEY_REUSE_ACTIVATION = {
    'BTC:mainnet':  null,         // INERT: operator-owned, sized above the deploy tip on the arming train
    'LTC:mainnet':  null,         // INERT: capability STAKE is BTC-only; carried for shape
    'DOGE:mainnet': null,         // INERT: capability STAKE is BTC-only; carried for shape
    mainnet:        null,         // INERT: a coin with no entry above inherits the unarmed posture
    'BTC:testnet':  156000,       // SIZED 2026-09-11: chain_tip 151,991 + 3,024 (21d @144/day) = 155,015, rounded up
    'LTC:testnet':  4897000,      // SIZED 2026-09-11: chain_tip 4,883,971 + 12,096 (21d @576/day) = 4,896,067, rounded up
    'DOGE:testnet': 67920000,     // SIZED 2026-09-11: chain_tip 67,887,900 + 30,240 (21d @1440/day) = 67,918,140, rounded up
    testnet:        null,         // INERT: a testnet coin with no entry above stays on the legacy refusal
    regtest:        0,            // genesis-active so the e2e venue exercises the armed rule
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown network -> undefined -> inert/off.
function _activationThreshold(network, coin){
    if(coin != null && STAKE_KEY_REUSE_ACTIVATION[coin + ':' + network] !== undefined)
        return STAKE_KEY_REUSE_ACTIVATION[coin + ':' + network];
    return STAKE_KEY_REUSE_ACTIVATION[network];
}

// Whether the narrowed reuse predicate binds at `blockIndex` on `network` for
// `coin`, rather than the legacy "any valid stakes row ever" refusal.
//
// Fails CLOSED on anything it cannot evaluate (inert network, unknown network,
// unusable height): false means the LEGACY predicate runs, which is the rule
// the deployed fleet already enforces, so a node that cannot evaluate the gate
// stays with the majority instead of unilaterally admitting a key.
//
// null is the INERT sentinel and must read as off: without the explicit null
// test `b >= null` coerces to `b >= 0` and arms the widening on every block of
// an unratified chain, the inverse of what the sentinel means. The same
// coercion is why the height itself goes through the empty-ish guard before
// Number(): Number(null), Number('') and Number(false) are all a perfectly
// finite 0, which on a genesis-armed network would read as ACTIVE and widen the
// predicate for an action carrying no block index at all.
function isStakeKeyReuseActive(blockIndex, network, coin){
    let threshold = _activationThreshold(network, coin);
    if(threshold === null || threshold === undefined) return false;
    if(blockIndex === null || blockIndex === undefined || blockIndex === '' || typeof blockIndex === 'boolean')
        return false;
    let b = Number(blockIndex);
    if(!Number.isFinite(b)) return false;
    return b >= threshold;
}

module.exports = {
    STAKE_KEY_REUSE_ACTIVATION,
    isStakeKeyReuseActive
};
