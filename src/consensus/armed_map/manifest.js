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
 * Armed-map fingerprint v2: the indexer's row manifest (transitional, W1).
 *
 * THE MEANING, NOT THE LAYOUT. v2 hashes (key, value) rows. This file is the
 * one explicit list of them: every module that declares an activation map or
 * is a v1 gate carrier, with the exports that count as rows, plus the
 * ProtocolChanges time table. Keys are the literal `<stem>.<EXPORT>` spelling
 * of today (the knownGateKeys() spelling in consensus_rules_digest.js), and a
 * stem is data, not a path: when a carrier moves, only its require() below is
 * repointed and the key stays, so the fingerprint stays.
 *
 * MEMBERSHIP IS THIS LIST, NEVER A DIRECTORY LISTING. Nothing here calls
 * readdirSync. A list cannot notice what it forgot, so the enforcement is a
 * test (test/unit/consensus/armed_map/manifest.test.js): it scans src/ for
 * activation-map declarations, enumerates every listed module's non-function
 * exports, compares against the v1 carrier set and the ProtocolChanges
 * table, and fails on anything that is not a row here.
 *
 * NO ENOENT SKIP. v1 shares one file list between two repos and so must drop
 * a carrier the other repo lacks; each repo now has its own manifest, so a
 * resolver that throws is a real defect and poisons the fingerprint.
 *
 * At W3 the resolvers are replaced by the registry's own row list.
 *
 ********************************************************************/

'use strict';

const { canonicalValue } = require('./canonical.js');

// Read the bundled VM once at manifest load, but defer a load failure until its
// mirror rows resolve so collectRows() can return the standard poisoned shape.
let VM_MODULE;
let VM_LOAD_ERROR;
try {
    VM_MODULE = require('xchain-vm');
} catch (e) {
    VM_LOAD_ERROR = e;
}

// [stem, loader, exports]. Each ordinary carrier stays unloaded until
// collectRows() runs. The VM is the exception above because its module must be
// read once per manifest load, with any failure still becoming a row reason.
const MODULES = [
    ['amount_representability_activation', () => require('../../amount_representability_activation.js'),
        ['AMOUNT_REPRESENTABILITY_ACTIVATION', 'AMOUNT_MAX_INTEGER_DIGITS']],
    ['anchor_activation', () => require('../../anchor_activation.js'), ['ANCHOR_ACTIVATION']],
    ['anchor_reward_activation', () => require('../../anchor_reward_activation.js'),
        ['ANCHOR_REWARD_ACTIVATION', 'ANCHOR_REWARD_AMOUNT', 'ARCHIVE_REWARD_ACTIVATION', 'ARCHIVE_REWARD_AMOUNT',
         'ANCHOR_REWARD_DERIVE_ACTIVATION', 'ANCHOR_REWARD_MIRROR_MATURITY', 'ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS',
         'ANCHOR_ATTEST_ARRIVAL_MARGIN_S', 'ANCHOR_ATTEST_BARRIER_ACTIVATION']],
    ['archive_batch_author_activation', () => require('../../archive_batch_author_activation.js'),
        ['ARCHIVE_BATCH_AUTHOR_ACTIVATION']],
    ['archive_head_unverified_gate_activation', () => require('../../archive_head_unverified_gate_activation.js'),
        ['ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION']],
    ['archive_rollback_author_scope_activation', () => require('../../archive_rollback_author_scope_activation.js'),
        ['ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION', 'ARCHIVE_AUTHOR_SCOPE_JOIN_SQL']],
    ['attest_admission_activation', () => require('../../attest_admission_activation.js'),
        ['ATTEST_ADMISSION_ACTIVATION']],
    ['attest_broadcast_fee_activation', () => require('../../attest_broadcast_fee_activation.js'),
        ['ATTEST_BROADCAST_FEE_ACTIVATION', 'ATTEST_BROADCAST_FEE_CAP']],
    ['attest_relay_activation', () => require('../../attest_relay_activation.js'), ['ATTEST_RELAY_ACTIVATION']],
    ['attest_relay_reject_slot_activation', () => require('../../attest_relay_reject_slot_activation.js'),
        ['ATTEST_RELAY_REJECT_SLOT_ACTIVATION']],
    ['attest_request_cap_activation', () => require('../../attest_request_cap_activation.js'),
        ['ATTEST_REQUEST_CAP_ACTIVATION', 'ATTEST_REQUEST_CAPS']],
    ['attest_response_mirror_activation', () => require('../../attest_response_mirror_activation.js'),
        ['ATTEST_RESPONSE_MIRROR_ACTIVATION']],
    ['attest_responsible_widening_activation', () => require('../../attest_responsible_widening_activation.js'),
        ['ATTEST_RESPONSIBLE_WIDENING_ACTIVATION', 'ATTEST_RESPONSIBLE_WIDENING', 'ATTEST_RESPONSIBLE_WIDENING_V2']],
    ['attest_zero_conf_activation', () => require('../../attest_zero_conf_activation.js'),
        ['ATTEST_ZERO_CONF_ACTIVATION']],
    ['attestation/providerMinStakeHistory', () => require('../../attestation/providerMinStakeHistory.js'),
        ['PROVIDER_MIN_STAKE_ACTIVATIONS']],
    ['capability_min_stake_history', () => require('../../capability_min_stake_history.js'),
        ['MIN_STAKE_ACTIVATIONS']],
    ['caret_ref_strict_activation', () => require('../../caret_ref_strict_activation.js'),
        ['CARET_REF_STRICT_ACTIVATION']],
    ['checkpoint_commitment_activation', () => require('../../checkpoint_commitment_activation.js'),
        ['CHECKPOINT_COMMITMENT_ACTIVATION']],
    ['consolidation_leg_amount_activation', () => require('../../consolidation_leg_amount_activation.js'),
        ['CONSOLIDATION_LEG_AMOUNT_ACTIVATION']],
    ['cross_chain_royalty_activation', () => require('../../cross_chain_royalty_activation.js'),
        ['CROSS_CHAIN_ROYALTY_ACTIVATION']],
    ['dispense_cancelling_match_activation', () => require('../../dispense_cancelling_match_activation.js'),
        ['DISPENSE_CANCELLING_MATCH_ACTIVATION']],
    ['dispense_payment_tally_scale_activation', () => require('../../dispense_payment_tally_scale_activation.js'),
        ['DISPENSE_TALLY_EXACT_SCALE', 'DISPENSE_TALLY_LEGACY_SCALE', 'DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION']],
    ['dispenser_amount_positivity_activation', () => require('../../dispenser_amount_positivity_activation.js'),
        ['DISPENSER_AMOUNT_POSITIVITY_ACTIVATION']],
    ['dispenser_caps_activation', () => require('../../dispenser_caps_activation.js'), ['DISPENSER_CAPS_ACTIVATION']],
    ['dispenser_freshness_activation', () => require('../../dispenser_freshness_activation.js'),
        ['DISPENSER_FRESHNESS_ACTIVATION']],
    ['dispenser_freshness_shape_activation', () => require('../../dispenser_freshness_shape_activation.js'),
        ['DISPENSER_FRESHNESS_SHAPE_ACTIVATION']],
    ['dispenser_give_amount_activation', () => require('../../dispenser_give_amount_activation.js'),
        ['DISPENSER_GIVE_AMOUNT_ACTIVATION']],
    ['dispenser_oracle_price_activation', () => require('../../dispenser_oracle_price_activation.js'),
        ['DISPENSER_ORACLE_PRICE_ACTIVATION']],
    ['dispenser_ownership_cancel_activation', () => require('../../dispenser_ownership_cancel_activation.js'),
        ['DISPENSER_OWNERSHIP_CANCEL_ACTIVATION']],
    ['dispenser_send_amount_compare_activation', () => require('../../dispenser_send_amount_compare_activation.js'),
        ['DISPENSER_SEND_COMPARE_SCALE', 'DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION']],
    ['equivocation_header', () => require('../../equivocation_header.js'), ['EQUIV_HEADER_ACTIVATION', 'ENGINE_TAGS']],
    ['gated_handoff_ref_activation', () => require('../../gated_handoff_ref_activation.js'),
        ['GATED_HANDOFF_REF_ACTIVATION']],
    ['ledger_amount_precision_activation', () => require('../../ledger_amount_precision_activation.js'),
        ['LEDGER_AMOUNT_PRECISION', 'LEDGER_AMOUNT_PRECISION_ACTIVATION']],
    ['list_edit_resolution_activation', () => require('../../list_edit_resolution_activation.js'),
        ['LIST_EDIT_RESOLUTION_ACTIVATION']],
    ['list_owner_activation', () => require('../../list_owner_activation.js'), ['LIST_OWNER_ACTIVATION']],
    ['mirror_admission_activation', () => require('../../mirror_admission_activation.js'),
        ['ADMIT_MARGIN_BLOCKS', 'ADMIT_MIN_FUTURE_BLOCKS', 'ADMIT_MAX_FUTURE_BLOCKS', 'MIRROR_ADMISSION_ACTIVATION',
         'MIRROR_ADMISSION_CONSUMER_ACTIVATION', 'MIRROR_ADMISSION_REGTEST_ENV',
         'MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT', 'CHAIN_CODE_RE', 'CANONICAL_HEIGHT_RE', 'ADMIT_COLUMN_CHAINS']],
    ['oracle_preload_causality_activation', () => require('../../oracle_preload_causality_activation.js'),
        ['ORACLE_PRELOAD_CAUSALITY_ACTIVATION', 'ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN']],
    ['oracle_snapshot_age_causality_activation', () => require('../../oracle_snapshot_age_causality_activation.js'),
        ['ORACLE_SNAPSHOT_AGE_CAUSALITY_ACTIVATION']],
    ['oracle_stale_round_visibility_activation', () => require('../../oracle_stale_round_visibility_activation.js'),
        ['ORACLE_STALE_ROUND_VISIBILITY_ACTIVATION']],
    ['price_batching_floor_activation', () => require('../../price_batching_floor_activation.js'),
        ['PRICE_BATCHING_FLOOR_ACTIVATION']],
    ['price_fee_batch_landed_activation', () => require('../../price_fee_batch_landed_activation.js'),
        ['PRICE_FEE_BATCH_LANDED_ACTIVATION']],
    ['price_pair_activation', () => require('../../price_pair_activation.js'),
        ['PRICE_PAIR_TICKER_MAX_LEGACY', 'PRICE_PAIR_TICKER_MAX_WIDE', 'PRICE_PAIR_WIDEN_ACTIVATION',
         'PRICE_PAIR_RE_LEGACY', 'PRICE_PAIR_RE_WIDE']],
    ['price_scale_activation', () => require('../../price_scale_activation.js'),
        ['PRICE_SCALE_MAX_DECIMALS', 'PRICE_SCALE_ACTIVATION', 'PRICE_VALUE_RE_LEGACY', 'PRICE_VALUE_RE_CANONICAL']],
    ['price_sig_tally_activation', () => require('../../price_sig_tally_activation.js'),
        ['PRICE_SIG_TALLY_ACTIVATION']],
    ['price_zero_validity_activation', () => require('../../price_zero_validity_activation.js'),
        ['PRICE_MAX', 'PRICE_ZERO_VALIDITY_ACTIVATION']],
    ['protocol/constants', () => require('../../protocol/constants.js'),
        ['MAX_ACTION_DATA_LENGTH', 'OP_RETURN_PUSH_OVERHEAD', 'MAX_CODE_SIZE', 'MAX_DEPLOY_CHUNKS',
         'MAX_DEPLOYCHUNK_PART_BYTES', 'VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS', 'XCALL_MIN_GAS', 'XCALL_MAX_GAS',
         'XCALL_MAX_HOPS', 'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MAX_DEADLINE_BLOCKS', 'XCALL_MAX_RETURN_BYTES',
         'XCALL_MAX_CALLS_PER_BLOCK', 'XCALL_RESULT_ORPHAN_GRACE_SECONDS', 'ATTEST_MAX_EXPIRIES_PER_BLOCK',
         'CROSS_SETTLE_MAX_PER_BLOCK', 'XBRIDGE_MAX_PER_BLOCK', 'XPOLICY_MAX_PER_BLOCK', 'XPOLICY_MAX_MEMBERS',
         'THRESHOLD_SCALE', 'STAKE_WEIGHTED_QUORUM_ACTIVATION', 'EQUIV_HEADER_ACTIVATION',
         'STATE_COMMITMENT_ACTIVATION', 'CHECKPOINT_COMMITMENT_ACTIVATION', 'ANCHOR_REWARD_ACTIVATION',
         'ANCHOR_REWARD_AMOUNT', 'ARCHIVE_REWARD_ACTIVATION', 'ARCHIVE_REWARD_AMOUNT',
         'CROSS_CHAIN_ROYALTY_ACTIVATION', 'VALID_FIAT_CODES', 'GAS_TICK', 'PRICE_MAX',
         'ORACLE_DEVIATION_THRESHOLD', 'ORACLE_VM_ROUND_WINDOW', 'ORACLE_VM_MAX_ROWS']],
    ['protocol_changes', () => require('../../protocol_changes.js'),
        ['VM_BANNED_ASYNC_MAINNET_TIME', 'NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME', 'CONSENSUS_VERSION',
         'UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME', 'CROSS_SETTLE_CAP_MAINNET_TIME',
         'BATCH_ROOT_SUB_INDEX_MAINNET_TIME', 'ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME',
         'ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME', 'DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME',
         'DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME', 'CONTRACT_META_REQUIRED_MAINNET_TIME',
         'CONTRACT_META_REQUIRED_TESTNET_TIME', 'BATCH_ISSUANCE_LIMITS_MAINNET_TIME',
         'BATCH_COST_WEIGHTING_MAINNET_TIME', 'EMISSION_ISSUANCE_LIMITS_MAINNET_TIME',
         'UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME', 'UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME']],
    ['retraction_signing_activation', () => require('../../retraction_signing_activation.js'),
        ['RETRACTION_SIGNING_ACTIVATION']],
    ['rollcall_activation', () => require('../../rollcall_activation.js'),
        ['ROLLCALL_ACTIVATION', 'ROLLCALL_REGTEST_ARMED_HEIGHT', 'ROLLCALL_REGTEST_ENV', 'ROLLCALL_INTERVAL_BLOCKS',
         'ROLLCALL_ACCEPT_WINDOW_BLOCKS', 'ROLLCALL_PROOF_DELAY_BLOCKS', 'ROLLCALL_DOGE_MATURITY',
         'ROLLCALL_EVICT_MISSES', 'ROLLCALL_STREAK_LOOKBACK', 'ROLLCALL_REWARD_AMOUNT']],
    ['rollcall_gates_activation', () => require('../../rollcall_gates_activation.js'),
        ['ROLLCALL_GATES_ACTIVATION', 'ROLLCALL_GATES_REGTEST_ARMED_HEIGHT', 'ROLLCALL_GATES_REGTEST_ENV']],
    ['slash_grid_activation', () => require('../../slash_grid_activation.js'),
        ['SLASH_DEDUCTION_PRECISION', 'SLASH_GRID_ACTIVATION']],
    ['slash_ledger_consolidation_activation', () => require('../../slash_ledger_consolidation_activation.js'),
        ['SLASH_LEDGER_CONSOLIDATION_ACTIVATION']],
    ['snapshot_reorg_buffer', () => require('../../snapshot_reorg_buffer.js'),
        ['CANONICAL_REORG_BUFFER', 'SNAPSHOT_BURIAL_ACTIVATION']],
    ['stake_key_reuse_activation', () => require('../../stake_key_reuse_activation.js'),
        ['STAKE_KEY_REUSE_ACTIVATION']],
    ['stake_weight_collation_activation', () => require('../../stake_weight_collation_activation.js'),
        ['STAKE_WEIGHT_COLLATION', 'STAKE_WEIGHT_COLLATION_ACTIVATION', 'STAKE_WEIGHT_ORDERING_COLUMNS']],
    ['stake_weighted_quorum', () => require('../../stake_weighted_quorum.js'), ['STAKE_WEIGHTED_QUORUM_ACTIVATION']],
    ['stateHash', () => require('../../stateHash.js'),
        ['STATE_HASH_VERSION', 'DEACTIVATION_TABLES', 'SLASH_SPECS', 'REQUEST_STATUS_TABLES', 'COOLDOWN_TABLES',
         'INDEX_MAP_STATE_HASH_ACTIVATION', 'POLL_FINALIZE_STATE_HASH_ACTIVATION',
         'TOKEN_SUPPLY_STATE_HASH_ACTIVATION', 'BET_STATUS_STATE_HASH_ACTIVATION', 'ARCHIVE_HEAD_VERSIONS',
         'ARCHIVE_HEAD_VERSIONS_SQL', 'ARCHIVE_INVALID_STATE_HASH_ACTIVATION',
         'ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION', 'ARCHIVE_CHUNK_HEIGHT_COL', 'ARCHIVE_CHUNK_HEIGHT_COL_LEGACY']],
    ['state_commitment_activation', () => require('../../state_commitment_activation.js'),
        ['STATE_COMMITMENT_ACTIVATION']],
    ['state_key_collation_activation', () => require('../../state_key_collation_activation.js'),
        ['STATE_KEY_COLLATION_ACTIVATION']],
    ['state_subtree_activation', () => require('../../state_subtree_activation.js'),
        ['RESERVED_SUBTREES', 'STATE_SUBTREE_ACTIVATION', 'STATE_SUBTREE_SHADOW', 'ESCROW_LOCKED_LEAF_ACTIVATION',
         'ESCROW_LOCKED_LEAF_SHADOW']],
    ['sweep_zero_leg_activation', () => require('../../sweep_zero_leg_activation.js'), ['SWEEP_ZERO_LEG_ACTIVATION']],
    ['swq_source_cap_activation', () => require('../../swq_source_cap_activation.js'),
        ['STAKE_WEIGHT_MAX_SOURCES', 'STAKE_WEIGHT_MAX_KEYS_PER_SOURCE', 'SWQ_SOURCE_CAP_ACTIVATION']],
    ['tick_namespace_activation', () => require('../../tick_namespace_activation.js'), ['TICK_NAMESPACE_ACTIVATION']],
    ['token_bridge_activation', () => require('../../token_bridge_activation.js'), ['TOKEN_BRIDGE_ACTIVATION']],
    ['token_policy_activation', () => require('../../token_policy_activation.js'),
        ['TOKEN_POLICY_INHERITANCE_ACTIVATION']],
    ['train_activation', () => require('../../train_activation.js'), ['TRAIN_ACTIVATION']],
    ['vm_deploy_lint_pkg3_activation', () => require('../../vm_deploy_lint_pkg3_activation.js'),
        ['VM_DEPLOY_LINT_PKG3_ACTIVATION']],
    ['vm_exec_lint_activation', () => require('../../vm_exec_lint_activation.js'), ['VM_EXEC_LINT_ACTIVATION']],
    ['vm_lint_global_alias_activation', () => require('../../vm_lint_global_alias_activation.js'),
        ['VM_LINT_GLOBAL_ALIAS_ACTIVATION']],
    ['xchain_bridge_activation', () => require('../../xchain_bridge_activation.js'), ['XCHAIN_BRIDGE_ACTIVATION']],
];

// The ProtocolChanges time table. These are not exports: the class builds them
// in its constructor, so an export scan cannot see them (v1 covered them only
// through the bytes of protocol_changes.js). Listed by name so a table entry
// that disappears poisons the fingerprint instead of silently leaving the set.
const PROTOCOL_CHANGE_NAMES = [
    'ADDRESS', 'AIRDROP', 'BATCH', 'BET', 'BROADCAST', 'CALLBACK', 'DESTROY', 'DISPENSER', 'DIVIDEND', 'DISPENSE',
    'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT', 'ORDER', 'SEND', 'SLEEP', 'SWAP', 'SWEEP', 'COINPAY',
    'COINPAY_EXPIRE', 'DEPLOY', 'EXECUTE', 'DEPOSIT', 'WITHDRAW', 'DEPLOY_BASE64_CODE', 'STAKE', 'UNSTAKE',
    'DELEGATE', 'COLLECT', 'SLASH', 'PRICE', 'VOTE', 'ATTEST', 'ANCHOR', 'XCALL', 'NODEPROOF', 'ROLLCALL',
    'XBRIDGE', 'UNIFIED_FEES', 'VM_ACTIONS', 'CROSS_CHAIN_DEX', 'DISPENSER_ORIGIN_STANDING',
    'FIAT_DISPENSER_PRICING', 'ISSUANCE_FEE', 'ISSUANCE_FEE_EMISSION_EXEMPT', 'VM_BALANCE_TOKENINFO',
    'CONTROLLER_GUARD', 'MINT_SELF_MINTED_ONLY', 'VOTE_BINDING_MINIMUMS', 'VOTE_CALLBACK_TIMELOCK',
    'VOTE_RESPECTS_SLEEP', 'VOTE_POLL_TICK_VISIBLE', 'ATTEST_CANONICAL_LOWERCASE_ID', 'ATTEST_RELAY_ORIGIN',
    'VM_ATTESTATION_GETRESPONSE', 'SYNTH_EXEC_TX_HASH', 'DISPENSER_CLOSE_PER_UNIT',
    'DISPENSER_ORACLE_PER_TOKEN_PRICE', 'CROSS_CHAIN_ROYALTY', 'REST_PATTERN_METER', 'VM_BANNED_ASYNC',
    'VM_LINT_HARDENING', 'LOCK_MAX_SUPPLY_EXACT', 'LOCK_NULL_PRIOR_UNSET', 'COOLDOWN_BLOCKS_INTEGER',
    'DEPLOY_SLASH_DEST_ADDRESS_VALID', 'UNSTAKE_CONTRACT_COOLDOWN_STRICT', 'ISSUE_MINT_SUPPLY_CUMULATIVE_CAP',
    'SLEEP_RESPECTS_LOCK_SLEEP', 'COINPAY_EXPIRE_TOKEN_AMOUNT', 'COINPAY_NATIVE_RECIPROCITY',
    'UNSTAKE_COOLDOWN_COMPLETION_ACTION', 'FIX_OUTPUT_FANOUT', 'DELEGATE_REVOKE_NO_REINSERT',
    'CONTRACT_INDEX_CANONICAL', 'CONTRACT_DELEGATION_MATERIALIZE', 'SLASH_BURNS_PENDING_STAKE',
    'SLASH_ORACLE_ROUND_DISCRIMINATED', 'NATIVE_FEE_PRICE_TIME_GATE', 'DEPLOY_INIT_STRICT',
    'BATCH_SUBACTION_NORMALIZATION', 'BATCH_ISSUANCE_LIMITS', 'BATCH_COST_WEIGHTING', 'EMISSION_ISSUANCE_LIMITS',
    'LEGACY_FEE_NUMERIC_DBHITS', 'UNIFIED_FEES_SWEEP_CALLBACK', 'PARTIAL_UNSTAKE_COLLECT',
    'XCALL_RESULT_ORPHAN_RETIREMENT', 'UNCAPPED_MAX_SUPPLY_ZERO', 'CROSS_SETTLE_PER_BLOCK_CAP',
    'BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR', 'ISSUE_INHERITED_MINT_WINDOW', 'DEPLOY_DEFERRED_ASSEMBLY',
    'CONTRACT_META_REQUIRED'
];

const VM_EXPORT_NAMES = [
    'PKG3_SANDBOX_ACTIVATION',
    'EXEC_LINT_ACTIVATION',
    'LINT_GLOBAL_ALIAS_ACTIVATION',
    'BINARY_ALLOC_GATE_BLOCK_TIME',
    'ASYNC_SURFACE_GATE_BLOCK_TIME',
    'STATE_KEY_NUL_GATE_BLOCK_TIME',
    'METERING_EVAL_ORDER_GATE_BLOCK_TIME',
    'CALL_SPREAD_METER_GATE_BLOCK_TIME',
    'REST_PATTERN_METER_GATE_BLOCK_TIME',
    'STATE_KEY_TYPE_GATE_BLOCK_TIME',
    'VM_LINT_HARDENING_GATE_BLOCK_TIME',
];

// Built once per process. The stub is the smallest indexer the constructor
// accepts: the table is a set of literal addChange() calls that read neither
// config nor util, which test/unit/consensus/armed_map/manifest.test.js proves
// by constructing it under different configs and comparing.
let protocolTable = null;
function protocolChangesTable() {
    if (!protocolTable) {
        const ProtocolChanges = MODULES.find((m) => m[0] === 'protocol_changes')[1]();
        protocolTable = new ProtocolChanges({ config: {}, util: {} }).changes;
    }
    return protocolTable;
}

// Reads one own property, refusing a missing one outright: an absent export
// read as undefined would say "renamed away" in a way nobody sees.
function ownValue(holder, name, where) {
    if (!Object.prototype.hasOwnProperty.call(holder, name)) {
        throw new Error(where + ' has no ' + name);
    }
    return holder[name];
}

function vmValue(name) {
    if (VM_LOAD_ERROR) throw VM_LOAD_ERROR;
    return ownValue(VM_MODULE, name, 'xchain-vm');
}

function buildEntries() {
    const entries = [];
    for (const [stem, load, names] of MODULES) {
        for (const name of names) {
            entries.push([stem + '.' + name, () => ownValue(load(), name, stem)]);
        }
    }
    for (const name of PROTOCOL_CHANGE_NAMES) {
        entries.push(['protocol_changes.changes.' + name,
            () => ownValue(protocolChangesTable(), name, 'protocol_changes.changes')]);
    }
    // Mirror the VM-resolved values because the VM enforces them inside this
    // process independently of the indexer's local activation twins.
    for (const name of VM_EXPORT_NAMES) {
        entries.push(['xchain-vm.' + name, () => vmValue(name)]);
    }
    return entries;
}

// [key, resolver]; each resolver returns the value the running process resolved.
const ENTRIES = buildEntries();

/**
 * Runs every resolver and checks every value is serialisable.
 * @returns {{ok: true, rows: Array<[string, *]>}|{ok: false, reason: string}}
 */
function collectRows() {
    const rows = [];
    for (const [key, resolve] of ENTRIES) {
        let value;
        try {
            value = resolve();
            canonicalValue(value);
        } catch (e) {
            return { ok: false, reason: key + ': ' + (e && e.message ? e.message : String(e)) };
        }
        rows.push([key, value]);
    }
    return { ok: true, rows };
}

module.exports = { ENTRIES, MODULES, PROTOCOL_CHANGE_NAMES, VM_EXPORT_NAMES, collectRows };
