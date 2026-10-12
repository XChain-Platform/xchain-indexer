/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * ROLLCALL gates regtest resolver held equal to the parser that runs.
 *
 * rollcall_gates_gate.js exports resolveRegtestGatesActivation, but a running
 * process never calls it: the value it applies is the registry row, which the
 * read overlay arms through regtest_env.regtestHeight. The exported resolver is
 * a second copy of that grammar, so it is pinned input for input against
 * regtestHeight here, the way rollcall_regtest_parity.test.js pins the base rail's.
 *
 ********************************************************************/
const assert = require('assert');

const rga = require('../../../src/consensus/gates/rollcall_gates_gate.js');
const { regtestHeight } = require('../../../src/protocol_changes/regtest_env.js');

const OPT_IN  = ['armed', 'genesis', 'on', 'true', 'yes', 'ARMED', ' Genesis '];
const HEIGHTS = ['0', '30', ' 600 '];
const OFF     = ['', '   ', 'off', 'inert', 'false', 'no', 'none', 'OFF', undefined, null];
const GARBAGE = ['-1', '1e3', '0x0', 'maybe', '30.5'];

// Run fn with both parsers' refusal warnings silenced; only return values are compared.
function quietly(fn) {
    const savedError = console.error;
    const savedWarn  = process.emitWarning;
    console.error = () => {};
    process.emitWarning = () => {};
    try { return fn(); } finally {
        console.error = savedError;
        process.emitWarning = savedWarn;
    }
}

function both(raw) {
    return quietly(() => ({
        exported: rga.resolveRegtestGatesActivation({ [rga.ROLLCALL_GATES_REGTEST_ENV]: raw }),
        running:  regtestHeight(raw, rga.ROLLCALL_GATES_REGTEST_ARMED_HEIGHT, 'ROLLCALL gates',
                                rga.ROLLCALL_GATES_REGTEST_ENV),
    }));
}

describe('ROLLCALL gates regtest resolver matches the running parser @regression @tier1', function () {
    it('agrees with regtestHeight on every accepted, refused and garbage input', function () {
        for (const raw of [...OPT_IN, ...HEIGHTS, ...OFF, ...GARBAGE]) {
            const { exported, running } = both(raw);
            assert.strictEqual(exported, running,
                JSON.stringify(raw) + ': the exported resolver and regtestHeight disagree');
        }
    });

    it('lands on the documented values, so agreement is not two copies of one mistake', function () {
        for (const raw of OPT_IN)
            assert.strictEqual(both(raw).running, rga.ROLLCALL_GATES_REGTEST_ARMED_HEIGHT, JSON.stringify(raw));
        assert.strictEqual(both('30').running, 30);
        assert.strictEqual(both(' 600 ').running, 600);
        for (const raw of [...OFF, ...GARBAGE])
            assert.strictEqual(both(raw).running, null, JSON.stringify(raw) + ' must stay inert');
    });
});
