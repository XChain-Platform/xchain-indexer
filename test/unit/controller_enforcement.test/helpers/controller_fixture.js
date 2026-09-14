'use strict';

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
 * test/unit/controller_enforcement.test/helpers/controller_fixture.js
 *
 * The fakes every part of the enforcement suite builds on: one Utility instance, the
 * base action envelope, and the db/actions doubles that stand in for
 * getEffectiveTokenController and runControllerGuard. Keeping them here rather than in
 * one part lets each part carry its own hooks, since a one-time hook must never span a
 * split.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const Utility = require('../../../../src/utility.js');

const util = new Utility();

const BASE = { BLOCK_INDEX: 100, ACTION_INDEX: 5, SOURCE: 'addr1' };

function mkDb(effective){
    return {
        config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
        getTickerId: async () => 1,
        getEffectiveTokenController: async () => effective,
        // Enforcement resolves via the *ForGuard fallback resolver; the control-flow tests below
        // don't exercise the 'all' fallback, so it delegates to the same effective row.
        getEffectiveTokenControllerForGuard: async () => effective
    };
}
// guardEnabled toggles the CONTROLLER_GUARD activation gate that invokeController consults
// (default true = at/above the flag-day, where the control-flow tests below exercise the guard).
function mkActions(guardResult, calls, guardEnabled){
    return {
        protocolChanges: { isEnabled: async () => (guardEnabled === undefined ? true : guardEnabled) },
        actionExecute:   { runControllerGuard: async (o) => { calls.push(o); return guardResult; } }
    };
}

const guardOpts = (data) => ({
    actionType: 'SEND', tick: 'AAA', from: 'addr1', to: 'addr2', amount: '10',
    data, gasInfo: null, gasBalances: []
});


module.exports = { util, BASE, mkDb, mkActions, guardOpts };
