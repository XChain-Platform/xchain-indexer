/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * VM failure → consensus status-token mapping (util.vmFailureStatus)
 *
 * The token this returns is interned in index_statuses and hashed into contract_hash
 * (via contracts_data.executions.status_id in db.getBlockHashes), then chained and
 * committed to the TransparencyLog Merkle root that validators compare. So it MUST be a
 * pure, deterministic function of the VM error.
 *
 * The critical invariant: the entire NON-GAS resource-termination family — timeout,
 * out_of_memory, out_of_stack, and out_of_resource (host crash / watchdog) — collapses to
 * ONE token. Which of these backstops actually fires for a given poisoned contract is
 * timing-/memory-/arch-dependent (proven by the cross-arch determinism run: ARM hits V8
 * abort → 'out_of_resource: ...(signal SIGABRT)', x86 hits the isolate wall-clock →
 * 'timeout: wall-clock...', a slow/tight host hits the parent watchdog →
 * 'out_of_resource: ...(watchdog timeout)'). Mapping them to distinct tokens would let two
 * honest validators record different status_ids for the same contract → divergent
 * contract_hash → chain FORK. This test pins the grouping so it can never silently
 * re-split (a regression would have re-introduced the fork). out_of_gas stays its own
 * token because it is deterministically gas-bounded.
 ********************************************************************/

const assert = require('assert');

// Utility loads coin config in its constructor — set before require (mirrors utility.test.js).
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const Utility = require('../../src/utility.js');

describe('VM failure status mapping — consensus stability @regression @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });

    it('revert → reverted', function () {
        assert.strictEqual(util.vmFailureStatus('revert: insufficient balance'), 'reverted');
        assert.strictEqual(util.vmFailureStatus('revert:'), 'reverted');
    });

    it('out_of_gas → out_of_gas (deterministic gas-bounded; stays distinct)', function () {
        assert.strictEqual(util.vmFailureStatus('out_of_gas: used 1000001 of 1000000'), 'out_of_gas');
    });

    it('the ENTIRE non-gas resource family → out_of_resource (the fork-safety invariant)', function () {
        // Each of these can be the outcome of the SAME contract on different validators.
        assert.strictEqual(util.vmFailureStatus('timeout: wall-clock safety net triggered'), 'out_of_resource');
        assert.strictEqual(util.vmFailureStatus('out_of_memory: isolate memory limit exceeded'), 'out_of_resource');
        assert.strictEqual(util.vmFailureStatus('out_of_stack: maximum call depth exceeded'), 'out_of_resource');
        assert.strictEqual(util.vmFailureStatus('out_of_resource: execution host terminated (signal SIGABRT)'), 'out_of_resource');
        assert.strictEqual(util.vmFailureStatus('out_of_resource: execution host terminated (watchdog timeout)'), 'out_of_resource');
        assert.strictEqual(util.vmFailureStatus('out_of_resource: execution host terminated (signal SIGKILL)'), 'out_of_resource');
    });

    it('runtime errors and unknown / empty inputs → failed', function () {
        assert.strictEqual(util.vmFailureStatus('error: something blew up'), 'failed');
        assert.strictEqual(util.vmFailureStatus('totally unrecognized'), 'failed');
        assert.strictEqual(util.vmFailureStatus(''), 'failed');
        assert.strictEqual(util.vmFailureStatus(null), 'failed');
        assert.strictEqual(util.vmFailureStatus(undefined), 'failed');
    });

    it('prefix matching is anchored (a contract-controlled revert reason cannot spoof a token)', function () {
        // The token prefixes are matched only at the start of the string, so a revert/log
        // payload that merely CONTAINS "timeout:" or "out_of_gas:" does not get reclassified.
        assert.strictEqual(util.vmFailureStatus('revert: timeout: not a real timeout'), 'reverted');
        assert.strictEqual(util.vmFailureStatus('error: out_of_gas: not really'), 'failed');
    });
});
