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
const { assertConsensusRuntime } = require('../../../src/actions.js');

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
