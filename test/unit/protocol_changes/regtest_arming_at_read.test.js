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

// Regtest arming is applied when a row is READ, not when it is registered
// (activation-registry D78). The registry loaded below is the shared instance
// every suite holds; the environment is changed AFTER it loaded and every read
// path (get, copy, rows, activeAt) must follow it, with no purge of any module.
// That is what lets a test set the variable and re-require an activation module
// to see the armed table, exactly as the module's own literal behaved.

const assert = require('assert');

const registry = require('../../../src/protocol_changes.js');
const { REGTEST_ARMING } = require('../../../src/protocol_changes/shared_rows.js');
const { createRegistry } = require('../../../src/protocol_changes/core.js');

const KEY = 'rollcall_activation.ROLLCALL_ACTIVATION';
const ENV = 'XC_ROLLCALL_REGTEST_ACTIVATION';

function withEnv(value, fn) {
    const saved = process.env[ENV];
    try {
        if (value === undefined) delete process.env[ENV];
        else process.env[ENV] = value;
        return fn();
    } finally {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    }
}

function rowOf(key) {
    const hit = registry.rows().find(([k]) => k === key);
    return hit ? hit[1] : undefined;
}

describe('protocol_changes: regtest arming is applied at READ time @regression @tier1', function () {
    let committed;
    before(function () {
        assert.strictEqual(REGTEST_ARMING[KEY].env, ENV, 'the row under test is the one the env variable arms');
        committed = withEnv(undefined, () => registry.get(KEY));
        assert.strictEqual(committed.regtest, null, 'the committed regtest entry is UNPINNED (the block literal)');
    });

    it('get() reads the armed height once the variable is set after the registry loaded', function () {
        withEnv('armed', () => {
            assert.strictEqual(registry.get(KEY).regtest, 0);
            assert.ok(Object.isFrozen(registry.get(KEY)), 'the armed reading is frozen like the committed row');
            assert.strictEqual(registry.get(KEY).mainnet, committed.mainnet, 'only the regtest entry moves');
            assert.strictEqual(registry.get(KEY).testnet, committed.testnet, 'only the regtest entry moves');
        });
        withEnv('12', () => assert.strictEqual(registry.get(KEY).regtest, 12));
    });

    it('unset reads the committed value again, and the stored row never moved', function () {
        withEnv('armed', () => assert.strictEqual(registry.get(KEY).regtest, 0));
        withEnv(undefined, () => {
            assert.strictEqual(registry.get(KEY).regtest, null);
            assert.strictEqual(registry.get(KEY), committed, 'the bare reading is the stored row itself');
        });
        assert.strictEqual(registry.registry.entries.get(KEY).value.regtest, null, 'registration stored the committed table');
    });

    it('copy(), rows() and activeAt() follow the same reading', function () {
        withEnv('armed', () => {
            assert.strictEqual(registry.copy(KEY).regtest, 0);
            assert.strictEqual(rowOf(KEY).regtest, 0);
            assert.strictEqual(registry.activeAt(KEY, 'regtest', null, 0, 0), true);
        });
        withEnv(undefined, () => {
            assert.strictEqual(registry.copy(KEY).regtest, null);
            assert.strictEqual(rowOf(KEY).regtest, null);
            assert.strictEqual(registry.activeAt(KEY, 'regtest', null, 0, 0), false);
        });
    });

});

describe('protocol_changes: regtest arming at read, the edges @regression @tier1', function () {
    it('a refused value reads INERT, as regtestHeight says, and warns once per value', async function () {
        const seen = [];
        const onWarning = (w) => { if (w.name === 'RegtestArmingWarning') seen.push(w.message); };
        process.on('warning', onWarning);
        try {
            withEnv('bogus', () => {
                assert.strictEqual(registry.get(KEY).regtest, null);
                assert.strictEqual(registry.get(KEY).regtest, null);
            });
            // process.emitWarning delivers on the next tick.
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(seen.length, 1, 'one warning for two reads of the same refused value');
            assert.match(seen[0], /XC_ROLLCALL_REGTEST_ACTIVATION="bogus"/);
        } finally {
            process.removeListener('warning', onWarning);
        }
    });

    it('a row outside REGTEST_ARMING is untouched by the environment', function () {
        const key = 'rollcall_activation.ROLLCALL_INTERVAL_BLOCKS';
        const bare = withEnv(undefined, () => registry.get(key));
        withEnv('armed', () => assert.strictEqual(registry.get(key), bare));
    });

    it('a registry with no overlay installed reads its committed rows', function () {
        const r = createRegistry();
        r.addGate('stem.X', 'height', { mainnet: 1, regtest: null });
        assert.strictEqual(r.get('stem.X').regtest, null);
        assert.throws(() => r.setReadOverlay('not a function'), /expected a function/);
        r.setReadOverlay((key, value) => (key === 'stem.X' ? Object.freeze(Object.assign({}, value, { regtest: 7 })) : value));
        assert.strictEqual(r.get('stem.X').regtest, 7);
        assert.strictEqual(r.rows()[0][1].regtest, 7);
        assert.strictEqual(r.activeAt('stem.X', 'regtest', null, 7, 0), true);
    });
});
