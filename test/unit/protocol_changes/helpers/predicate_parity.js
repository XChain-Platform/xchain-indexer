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
 * The predicate-parity engine behind predicate_parity.test.js: every gate
 * row's own predicate (kept byte-for-byte at W3, D69) against the registry's
 * one generic activeAt() over the same table, at the boundary of every
 * committed threshold, at the sentinels, and on an unknown network. The test
 * pins which predicates differ; the report the lane writes reads the same
 * table, so the two can never disagree about what W4 has to learn.
 *
 ********************************************************************/

'use strict';

const path = require('path');

const { SRC, modulePathFor } = require('../../../helpers/gate_modules.js');
const ProtocolChanges = require(path.join(SRC, 'protocol_changes.js'));

// [row key, the module's predicate, its argument order]. A token names what
// each positional argument receives: the clock (height or time by the row's
// unit), the network, or the coin. The rows whose predicate W4 replaced with
// activeAt() itself are not here: there is no second implementation left to
// compare, and the suite lists them as REPLACED instead.
const TABLE = [
    ['amount_representability_activation.AMOUNT_REPRESENTABILITY_ACTIVATION', 'isAmountRepresentabilityActive', ['time', 'network']],
    ['anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION', 'isAnchorAttestBarrierHorizonActive', ['network', 'height']],
    ['anchor_reward_activation.ANCHOR_REWARD_ACTIVATION', 'isAnchorRewardActive', ['height', 'network']],
    ['anchor_reward_activation.ANCHOR_REWARD_DERIVE_ACTIVATION', 'isAnchorRewardDeriveActive', ['height', 'network']],
    ['anchor_reward_activation.ARCHIVE_REWARD_ACTIVATION', 'isArchiveRewardActive', ['height', 'network']],
    ['archive_rollback_author_scope_activation.ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION', 'isArchiveRollbackAuthorScopeActive', ['height', 'network']],
    ['attest_broadcast_fee_activation.ATTEST_BROADCAST_FEE_ACTIVATION', 'isAttestBroadcastFeeActive', ['height', 'network']],
    ['attest_relay_activation.ATTEST_RELAY_ACTIVATION', 'isAttestRelayActive', ['height', 'network']],
    ['attest_relay_reject_slot_activation.ATTEST_RELAY_REJECT_SLOT_ACTIVATION', 'isAttestRelayRejectSlotActive', ['time', 'network']],
    ['attest_request_cap_activation.ATTEST_REQUEST_CAP_ACTIVATION', 'isAttestRequestCapActive', ['height', 'network']],
    ['attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION', 'isResponseMirrorActive', ['height', 'network']],
    ['attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION', 'isZeroConfActive', ['height', 'network']],
    ['caret_ref_strict_activation.CARET_REF_STRICT_ACTIVATION', 'isCaretRefStrictActive', ['height', 'network', 'coin']],
    ['checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION', 'isCheckpointCommitmentActive', ['height', 'network']],
    ['cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION', 'isCrossChainRoyaltyActive', ['height', 'network']],
    ['dispense_payment_tally_scale_activation.DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION', 'isDispensePaymentTallyScaleActive', ['time', 'network']],
    ['dispenser_send_amount_compare_activation.DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION', 'isDispenserSendAmountCompareActive', ['height', 'network', 'coin']],
    ['equivocation_header.EQUIV_HEADER_ACTIVATION', 'isEquivHeaderActive', ['height', 'network']],
    ['ledger_amount_precision_activation.LEDGER_AMOUNT_PRECISION_ACTIVATION', 'isLedgerAmountPrecisionActive', ['height', 'network', 'coin']],
    ['list_edit_resolution_activation.LIST_EDIT_RESOLUTION_ACTIVATION', 'isListEditResolutionActive', ['height', 'network', 'coin']],
    ['mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION', 'isMirrorAdmissionProducerActive', ['coin', 'network', 'height']],
    ['mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION', 'isMirrorAdmissionConsumerActive', ['coin', 'network', 'height']],
    ['oracle_preload_causality_activation.ORACLE_PRELOAD_CAUSALITY_ACTIVATION', 'isOraclePreloadCausalityActive', ['height', 'network', 'coin']],
    ['price_batching_floor_activation.PRICE_BATCHING_FLOOR_ACTIVATION', 'isPriceBarrierRequired', ['time', 'network', 'coin']],
    ['price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION', 'isPricePairWideningActive', ['time', 'network']],
    ['price_scale_activation.PRICE_SCALE_ACTIVATION', 'isPriceScaleCanonicalActive', ['time', 'network']],
    ['price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION', 'isPriceSigTallyVerifyFirstActive', ['height', 'network']],
    ['price_zero_validity_activation.PRICE_ZERO_VALIDITY_ACTIVATION', 'isPriceZeroValidityActive', ['time', 'network']],
    ['retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION', 'isRetractionSigningActive', ['height', 'network']],
    ['rollcall_activation.ROLLCALL_ACTIVATION', 'isRollcallActive', ['height', 'network']],
    ['rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION', 'isRollcallGatesActive', ['height', 'network']],
    ['slash_grid_activation.SLASH_GRID_ACTIVATION', 'isSlashGridActive', ['height', 'network', 'coin']],
    ['snapshot_reorg_buffer.SNAPSHOT_BURIAL_ACTIVATION', 'isSnapshotBurialActive', ['height', 'network']],
    ['stake_weight_collation_activation.STAKE_WEIGHT_COLLATION_ACTIVATION', 'isStakeWeightBinCollationActive', ['height', 'network', 'coin']],
    ['stake_weighted_quorum.STAKE_WEIGHTED_QUORUM_ACTIVATION', 'isStakeWeightedQuorumActive', ['height', 'network']],
    ['stateHash.ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION', 'isArchiveInvalidHeightKeyActive', ['height', 'network', 'coin']],
    ['stateHash.ARCHIVE_INVALID_STATE_HASH_ACTIVATION', 'isArchiveInvalidStateHashActive', ['height', 'network', 'coin']],
    ['stateHash.BET_STATUS_STATE_HASH_ACTIVATION', 'isBetStatusStateHashActive', ['height', 'network', 'coin']],
    ['stateHash.INDEX_MAP_STATE_HASH_ACTIVATION', 'isIndexMapStateHashActive', ['height', 'network']],
    ['stateHash.POLL_FINALIZE_STATE_HASH_ACTIVATION', 'isPollFinalizeStateHashActive', ['height', 'network', 'coin']],
    ['stateHash.TOKEN_SUPPLY_STATE_HASH_ACTIVATION', 'isTokenSupplyStateHashActive', ['height', 'network', 'coin']],
    ['state_commitment_activation.STATE_COMMITMENT_ACTIVATION', 'isStateCommitmentActive', ['height', 'network', 'coin']],
    ['state_key_collation_activation.STATE_KEY_COLLATION_ACTIVATION', 'isStateKeyBinCollationActive', ['height', 'network', 'coin']],
    ['state_subtree_activation.ESCROW_LOCKED_LEAF_ACTIVATION', 'isEscrowLockedLeafActive', ['height', 'network', 'coin']],
    ['state_subtree_activation.ESCROW_LOCKED_LEAF_SHADOW', 'isEscrowLockedLeafShadowActive', ['height', 'network', 'coin']],
    ['swq_source_cap_activation.SWQ_SOURCE_CAP_ACTIVATION', 'isSwqSourceCapActive', ['height', 'network', 'coin']],
    ['token_bridge_activation.TOKEN_BRIDGE_ACTIVATION', 'isTokenBridgeActive', ['height', 'network']],
    ['token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION', 'isTokenPolicyInheritanceActive', ['height', 'network']],
    ['xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION', 'isXchainBridgeActive', ['height', 'network', 'coin']],
];

const NETWORKS = ['mainnet', 'testnet', 'regtest', 'devnet'];
const COINS = [null, 'BTC', 'LTC', 'DOGE'];
const UNARMED = 9999999999;

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// The threshold activeAt() would resolve: the coin key first, then the network.
function thresholdOf(table, network, coin) {
    if (coin !== null && hasOwn(table, coin + ':' + network)) return table[coin + ':' + network];
    return hasOwn(table, network) ? table[network] : undefined;
}

// Every committed threshold's neighbours plus the sentinels, deduplicated.
function clocksFor(table, network, coin) {
    const out = new Set([0, 1, UNARMED - 1, UNARMED, UNARMED + 1]);
    const t = thresholdOf(table, network, coin);
    if (typeof t === 'number' && Number.isFinite(t)) { out.add(t - 1); out.add(t); out.add(t + 1); }
    for (const v of Object.values(table)) {
        if (typeof v === 'number' && Number.isFinite(v)) { out.add(v - 1); out.add(v); out.add(v + 1); }
    }
    return [...out].filter((c) => c >= 0).sort((a, b) => a - b);
}

function callPredicate(fn, args, clock, network, coin) {
    return fn(...args.map((a) => (a === 'network' ? network : a === 'coin' ? coin : clock)));
}

function unitOf(key) { return ProtocolChanges.registry.unitOf(key); }

/**
 * Compares one row's predicate against activeAt() over every sample input.
 * @returns {{key: string, predicate: string, verdict: 'EQUAL'|'DIFFERS'|'THROWS', first: ?object, inputs: number}}
 */
function compareRow([key, predicate, args]) {
    const stem = key.slice(0, key.lastIndexOf('.'));
    const mod = require(modulePathFor(stem));
    const fn = mod[predicate];
    if (typeof fn !== 'function') throw new Error(stem + ' does not export ' + predicate);
    const unit = unitOf(key);
    const table = ProtocolChanges.get(key);
    const takesCoin = args.includes('coin');
    let inputs = 0;
    const flat = unit === 'ruleset' ? {} : table;
    for (const network of NETWORKS) {
        for (const coin of takesCoin ? COINS : [null]) {
            for (const clock of clocksFor(flat, network, coin)) {
                inputs += 1;
                let expected;
                let actual;
                try {
                    expected = ProtocolChanges.activeAt(key, network, coin, unit === 'time' ? 0 : clock, unit === 'time' ? clock : 0);
                } catch (e) {
                    return { key, predicate, verdict: 'THROWS', first: { network, coin, clock, activeAt: e.message }, inputs };
                }
                actual = callPredicate(fn, args, clock, network, coin);
                if (actual !== expected) {
                    return { key, predicate, verdict: 'DIFFERS', first: { network, coin, clock, predicate: actual, activeAt: expected }, inputs };
                }
            }
        }
    }
    return { key, predicate, verdict: 'EQUAL', first: null, inputs };
}

function compareAll() { return TABLE.map(compareRow); }

module.exports = { TABLE, compareRow, compareAll, NETWORKS, COINS };
