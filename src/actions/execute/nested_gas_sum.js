'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Banks a nested EXECUTE callee's unused gas reservation into its caller's
// running refund. Before the NESTED_EXECUTE_GAS_SUM_ACTIVATION height the
// refund is the plain unbounded sum (settlement floors the billed gas at 0);
// from that height each addend is a non-negative finite amount and the summed
// refund never exceeds the gas the caller itself metered, so the sum cannot
// outgrow the charge it is refunded against.

const gateRegistry = require('../../consensus/gate_registry');

const KEY = 'nested_execute_gas_sum_activation.NESTED_EXECUTE_GAS_SUM_ACTIVATION';

/**
 * Whether the bounded sum applies at the action's block.
 * @param {object} config  the indexer config (NETWORK, COIN)
 * @param {object} data    the action data (BLOCK_INDEX)
 * @returns {boolean}
 */
function boundedAt(config, data){
    return gateRegistry.activeAt(KEY, config['NETWORK'], config['COIN'], data['BLOCK_INDEX'], null);
}

/**
 * The caller's refund total after banking one callee's unused reservation.
 * @param {number} total      the refund banked so far
 * @param {object} emission   the settled EXECUTE emission (gasUnusedSubtree)
 * @param {boolean} bounded   the gate answer from boundedAt()
 * @param {number} gasMetered the caller's own metered gas, the bound's ceiling
 * @returns {number}
 */
function bankUnusedGas(total, emission, bounded, gasMetered){
    let unused = Number(emission.gasUnusedSubtree) || 0;
    if(!bounded)
        return total + unused;
    if(!Number.isFinite(unused) || unused < 0)
        unused = 0;
    return Math.min(total + unused, Math.max(0, Number(gasMetered) || 0));
}

module.exports = { KEY, boundedAt, bankUnusedGas };
