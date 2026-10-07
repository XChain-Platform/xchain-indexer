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
 * Consensus-runtime gate on the LIVE validator (not just in CI).
 *
 * xchain-vm pins the engine (V8/ICU/Unicode/CLDR/ABI) because some
 * contract-observable bytes are engine-produced and not spec-mandated; an
 * off-pin validator commits different bytes for the same contract and forks
 * the chain. The gate used to warn and continue, leaving the only hard check
 * in CI, which runs on a build host and never sees the running node. This
 * pins the fail-closed contract: an off-pin engine aborts Actions
 * construction, so no contract handler is ever wired up.
 ********************************************************************/

'use strict';

const assert = require('assert');
const { assertConsensusRuntime, assertVmConsensusEpoch, EXPECTED_VM_CONSENSUS_VERSION } = require('../../../../src/actions/index.js');
const { skipOrFail } = require('../../../helpers/sibling_checkout.js');

describe('consensus-runtime gate: fail closed on an off-pin engine @regression @tier1', function () {

    it('throws the operator mismatch description when the engine is off-pin', function () {
        const vmModule = {
            checkConsensusRuntime: () => ({
                ok: false,
                mismatches: [{ key: 'v8', expected: '12.4.254.21-node.56', actual: '9.9.9' }]
            }),
            describeRuntimeMismatch: () => 'CONSENSUS RUNTIME MISMATCH: v8 ... would FORK'
        };
        assert.throws(() => assertConsensusRuntime(vmModule), /CONSENSUS RUNTIME MISMATCH/);
    });

    it('does not throw when the engine matches the pin', function () {
        const vmModule = {
            checkConsensusRuntime: () => ({ ok: true, mismatches: [] }),
            describeRuntimeMismatch: () => { throw new Error('must not be described on a match'); }
        };
        assertConsensusRuntime(vmModule);
    });

    it('is inert when the bundled VM predates the checker (no gate to run)', function () {
        assertConsensusRuntime({});
        assertConsensusRuntime(null);
    });

});

describe('VM consensus-epoch gate: fail closed on a wrong-epoch VM @regression @tier1', function () {

    it('throws when the loaded VM declares another epoch, naming both epochs', function () {
        assert.notStrictEqual(EXPECTED_VM_CONSENSUS_VERSION, '4', 'the stale-epoch fixture must differ from the pin');
        assert.throws(() => assertVmConsensusEpoch({ CONSENSUS_VERSION: '4' }), function (err) {
            assert.match(err.message, /VM CONSENSUS EPOCH MISMATCH/);
            assert.ok(err.message.indexOf('"4"') !== -1, 'the message must name the loaded epoch');
            assert.ok(err.message.indexOf(JSON.stringify(EXPECTED_VM_CONSENSUS_VERSION)) !== -1,
                'the message must name the expected epoch');
            return true;
        });
    });

    it('throws when a loaded VM declares no epoch at all, rather than skipping', function () {
        assert.throws(() => assertVmConsensusEpoch({}), /undefined \(missing\)/);
    });

    it('compares strictly, so a numeric epoch is not the string pin', function () {
        assert.throws(() => assertVmConsensusEpoch({ CONSENSUS_VERSION: Number(EXPECTED_VM_CONSENSUS_VERSION) }),
            /VM CONSENSUS EPOCH MISMATCH/);
    });

    it('passes a VM on the expected epoch, and leaves an unloaded VM to the load gate', function () {
        assertVmConsensusEpoch({ CONSENSUS_VERSION: EXPECTED_VM_CONSENSUS_VERSION });
        assertVmConsensusEpoch(null);
    });

    it('passes the VM this checkout actually bundles, when one is present', function () {
        let vm;
        try { vm = require('xchain-vm'); }
        catch (e) { return skipOrFail(this, { usable: false, reason: 'xchain-vm did not load: ' + e.message }, 'the bundled-VM epoch check'); }
        assertVmConsensusEpoch(vm);
    });

});
