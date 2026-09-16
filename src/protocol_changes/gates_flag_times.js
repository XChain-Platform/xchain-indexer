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
 * The registry's own constants as rows: the 16 flag-day instants the
 * time-table parts share and the compiled consensus-version pin, under the
 * `protocol_changes.<NAME>` keys the entry has always exported them by. The
 * values stay declared in flag_times.js, flag_times_batch_fees.js and
 * consensus_version.js with their rulings, because the time-table parts read
 * them by require and cannot reach the entry without a cycle; this part only
 * registers them, so rows() carries what the entry exports.
 *
 ********************************************************************/

'use strict';

const { addGate } = require('./shared_rows.js');
const { CONSENSUS_VERSION } = require('./consensus_version.js');
const {
    VM_BANNED_ASYNC_MAINNET_TIME,
    NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME,
    UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME,
    CROSS_SETTLE_CAP_MAINNET_TIME,
    BATCH_ROOT_SUB_INDEX_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME,
    DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME,
    DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME,
    CONTRACT_META_REQUIRED_MAINNET_TIME,
    CONTRACT_META_REQUIRED_TESTNET_TIME,
} = require('./flag_times.js');
const {
    BATCH_ISSUANCE_LIMITS_MAINNET_TIME,
    BATCH_COST_WEIGHTING_MAINNET_TIME,
    EMISSION_ISSUANCE_LIMITS_MAINNET_TIME,
    UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME,
    UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME,
} = require('./flag_times_batch_fees.js');

// protocol_changes
addGate('protocol_changes.VM_BANNED_ASYNC_MAINNET_TIME', 'constant', VM_BANNED_ASYNC_MAINNET_TIME);
addGate('protocol_changes.NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME', 'constant', NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME);
addGate('protocol_changes.CONSENSUS_VERSION', 'constant', CONSENSUS_VERSION);
addGate('protocol_changes.UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME', 'constant', UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME);
addGate('protocol_changes.CROSS_SETTLE_CAP_MAINNET_TIME', 'constant', CROSS_SETTLE_CAP_MAINNET_TIME);
addGate('protocol_changes.BATCH_ROOT_SUB_INDEX_MAINNET_TIME', 'constant', BATCH_ROOT_SUB_INDEX_MAINNET_TIME);
addGate('protocol_changes.ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME', 'constant', ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME);
addGate('protocol_changes.ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME', 'constant', ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME);
addGate('protocol_changes.DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME', 'constant', DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME);
addGate('protocol_changes.DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME', 'constant', DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME);
addGate('protocol_changes.CONTRACT_META_REQUIRED_MAINNET_TIME', 'constant', CONTRACT_META_REQUIRED_MAINNET_TIME);
addGate('protocol_changes.CONTRACT_META_REQUIRED_TESTNET_TIME', 'constant', CONTRACT_META_REQUIRED_TESTNET_TIME);
addGate('protocol_changes.BATCH_ISSUANCE_LIMITS_MAINNET_TIME', 'constant', BATCH_ISSUANCE_LIMITS_MAINNET_TIME);
addGate('protocol_changes.BATCH_COST_WEIGHTING_MAINNET_TIME', 'constant', BATCH_COST_WEIGHTING_MAINNET_TIME);
addGate('protocol_changes.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME', 'constant', EMISSION_ISSUANCE_LIMITS_MAINNET_TIME);
addGate('protocol_changes.UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME', 'constant', UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME);
addGate('protocol_changes.UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME', 'constant', UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME);
