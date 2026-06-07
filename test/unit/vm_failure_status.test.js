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
 * The critical invariant: the entire resource-exhaustion family — out_of_gas, timeout,
 * out_of_memory, out_of_stack, and out_of_resource (host crash / watchdog) — collapses to
 * ONE token. Which of these backstops actually fires for a given contract is
 * timing-/memory-/arch-dependent (proven by the cross-arch determinism run: ARM hits V8
 * abort → 'out_of_resource: ...(signal SIGABRT)', x86 hits the isolate wall-clock →
 * 'timeout: wall-clock...', a slow/tight host hits the parent watchdog →
 * 'out_of_resource: ...(watchdog timeout)').
 *
 * out_of_gas is part of the family, NOT a distinct token. It was once kept separate on the
 * assumption it is "deterministically gas-bounded", but a gas-burning loop RACES the gas
 * ceiling (deterministic) against the wall-clock net (host-speed dependent): a fast
 * validator reports 'out_of_gas: ...', a slow/loaded one reports 'timeout: ...' for the
 * SAME contract+gas-schedule. Keeping out_of_gas distinct therefore re-introduced exactly
 * this fork (surfaced by the x86 re-validation run). Mapping the whole family to one token
 * makes WHICH ceiling fires irrelevant to consensus; gasUsed is clamped to the ceiling on
 * every path so the fee stays fork-safe, and the raw out_of_gas-vs-timeout detail is kept
 * un-hashed in contract_executions.error_message. This test pins the grouping so it can
 * never silently re-split.
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

    it('out_of_gas → out_of_resource (part of the family; gas-vs-wall-clock is a host race)', function () {
        // A fast validator reports this for a gas-burning loop; a slow one reports
        // 'timeout: ...' for the identical contract. Same token required, or they fork.
        assert.strictEqual(util.vmFailureStatus('out_of_gas: used 1000001 of 1000000'), 'out_of_resource');
    });

    it('the ENTIRE resource-exhaustion family → out_of_resource (the fork-safety invariant)', function () {
        // Each of these can be the outcome of the SAME contract on different validators.
        assert.strictEqual(util.vmFailureStatus('out_of_gas: used 1000001 of 1000000'), 'out_of_resource');
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
