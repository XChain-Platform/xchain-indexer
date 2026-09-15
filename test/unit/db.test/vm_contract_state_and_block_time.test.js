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
 **********************************************************************/

// test/unit/db.test/vm_contract_state_and_block_time.test.js
//
// Covers capability configuration, adversarial contract-state keys, and block-time memoization.

'use strict';

const { assert, sinon, getTestConfig, Database } = require('./helpers/db.js');

// ---------------------------------------------------------------------------
// describe: isCapabilityConfigured (config-drift signal for the hub RPC)
// ---------------------------------------------------------------------------
// The getcapabilityvalidators RPC uses this to distinguish a capability this
// indexer doesn't know about (config drift during a rollout) from one that
// simply has no qualified validators. Without the distinction both answer with
// an empty set, so a misconfigured capability silently drops all its
// attestation work.
describe('Database.isCapabilityConfigured() @regression @tier1', function () {
    function dbWith(caps) {
        const config = getTestConfig();
        config.STAKING = caps === undefined ? {} : { CAPABILITIES: caps };
        return { config, isCapabilityConfigured: Database.prototype.isCapabilityConfigured };
    }

    it('returns true for a configured capability', function () {
        const db = dbWith({ attestation: { MIN_STAKE: '10000' } });
        assert.strictEqual(db.isCapabilityConfigured.call(db, 'attestation'), true);
    });

    it('returns false for a capability absent from the config', function () {
        const db = dbWith({ attestation: { MIN_STAKE: '10000' } });
        assert.strictEqual(db.isCapabilityConfigured.call(db, 'oracle_publish'), false);
    });

    it('returns false when STAKING.CAPABILITIES is missing entirely', function () {
        const db = dbWith(undefined);
        assert.strictEqual(db.isCapabilityConfigured.call(db, 'attestation'), false);
    });
});

// ---------------------------------------------------------------------------
// describe: getContractState (adversarial state keys like __proto__ must
// round-trip faithfully into the VM's initialState. A plain {} would route
// state['__proto__'] = value through the __proto__ setter (no-op for strings,
// prototype reassignment for objects), silently losing the key on reload.
// Regression guard for the Object.create(null) fix in src/db.js.
// ---------------------------------------------------------------------------
describe('Database.getContractState() adversarial keys @regression @tier1', function () {
    let db;

    function makeDb(rows) {
        return {
            doQuery: sinon.stub().resolves(rows),
            getContractState: Database.prototype.getContractState,
        };
    }

    // Values are stored JSON-serialized (createContractState writes JSON.stringify(value)).
    const row = (k, v) => ({ state_key: k, state_value: JSON.stringify(v) });

    it('returns a null-prototype object (no inherited Object.prototype)', async function () {
        db = makeDb([row('owner', 'addr1')]);
        const state = await db.getContractState.call(db, 1);
        assert.strictEqual(Object.getPrototypeOf(state), null,
            'state object must have a null prototype so adversarial keys are own data properties');
    });

    it('round-trips a "__proto__" string key as an own property (not the proto setter)', async function () {
        db = makeDb([row('__proto__', 'secret-balance'), row('owner', 'addr1')]);
        const state = await db.getContractState.call(db, 1);
        assert.ok(Object.prototype.hasOwnProperty.call(state, '__proto__'),
            '__proto__ must be a genuine own property');
        assert.strictEqual(state['__proto__'], 'secret-balance',
            '__proto__ value must survive the reload (this is what regressed with a plain {})');
        assert.strictEqual(state.owner, 'addr1');
    });

    it('round-trips a "__proto__" OBJECT key without reassigning the prototype', async function () {
        db = makeDb([row('__proto__', { nested: true })]);
        const state = await db.getContractState.call(db, 1);
        // With a plain {}, state['__proto__'] = {nested:true} would set the
        // object's [[Prototype]] instead of an own key, corrupting the state.
        assert.strictEqual(Object.getPrototypeOf(state), null,
            'assigning an object to __proto__ must NOT reassign the prototype');
        assert.deepStrictEqual(state['__proto__'], { nested: true });
    });

    it('round-trips a "constructor" key', async function () {
        db = makeDb([row('constructor', 'C')]);
        const state = await db.getContractState.call(db, 1);
        assert.strictEqual(state['constructor'], 'C');
    });

    it('falls back to the raw string when state_value is not valid JSON', async function () {
        db = makeDb([{ state_key: 'legacy', state_value: 'not-json' }]);
        const state = await db.getContractState.call(db, 1);
        assert.strictEqual(state.legacy, 'not-json');
    });
});

// ---------------------------------------------------------------------------
// describe: getBlockTime (memoization)
//
// block_time is constant per block_index but protocol_changes.isEnabled() was
// re-querying it once per action-handler call (several times per block). This
// guards the single-entry memo cache: repeated calls for the same block_index
// must hit the cache instead of re-querying, while a different block_index
// still triggers a fresh query and returns the correct (not stale) value.
// ---------------------------------------------------------------------------
describe('Database.getRawBlockTime() memoization @regression @tier1', function () {
    let db;

    beforeEach(function () {
        db = {
            // getRawBlockTime reads via doQueryStrict (throw-on-fault) so a
            // transient decoder-DB fault propagates to the fail-loud protocol-changes catch
            // instead of collapsing to the `false` sentinel and silently disabling gates.
            doQueryStrict: sinon.stub().resolves([]),
            _blockTimeCache: { block_index: null, block_time: null },
            getRawBlockTime: Database.prototype.getRawBlockTime,
        };
    });

    it('queries the DB on the first call for a block_index', async function () {
        db.doQueryStrict.resolves([{ block_time: 1700000000 }]);
        const result = await db.getRawBlockTime.call(db, 100);
        assert.strictEqual(result, 1700000000);
        assert.strictEqual(db.doQueryStrict.callCount, 1);
    });

    it('serves repeated calls for the same block_index from cache (no extra query)', async function () {
        db.doQueryStrict.resolves([{ block_time: 1700000000 }]);
        await db.getRawBlockTime.call(db, 100);
        await db.getRawBlockTime.call(db, 100);
        await db.getRawBlockTime.call(db, 100);
        assert.strictEqual(db.doQueryStrict.callCount, 1, 'only the first call should hit the DB');
    });

    it('returns the identical value on cached calls as the original query', async function () {
        db.doQueryStrict.resolves([{ block_time: 1700000123 }]);
        const first  = await db.getRawBlockTime.call(db, 100);
        const second = await db.getRawBlockTime.call(db, 100);
        assert.strictEqual(second, first);
        assert.strictEqual(second, 1700000123);
    });

    it('re-queries when block_index changes (last-block-wins, cache does not grow unbounded)', async function () {
        db.doQueryStrict.onCall(0).resolves([{ block_time: 1111 }]);
        db.doQueryStrict.onCall(1).resolves([{ block_time: 2222 }]);
        const first  = await db.getRawBlockTime.call(db, 100);
        const second = await db.getRawBlockTime.call(db, 101);
        assert.strictEqual(first, 1111);
        assert.strictEqual(second, 2222);
        assert.strictEqual(db.doQueryStrict.callCount, 2);
    });

});

describe('Database.getRawBlockTime() memoization @regression @tier1', function () {
    let db;

    beforeEach(function () {
        db = {
            // getRawBlockTime reads via doQueryStrict (throw-on-fault) so a
            // transient decoder-DB fault propagates to the fail-loud protocol-changes catch
            // instead of collapsing to the `false` sentinel and silently disabling gates.
            doQueryStrict: sinon.stub().resolves([]),
            _blockTimeCache: { block_index: null, block_time: null },
            getRawBlockTime: Database.prototype.getRawBlockTime,
        };
    });

    it('does not serve a stale value after the block_index advances then returns', async function () {
        db.doQueryStrict.onCall(0).resolves([{ block_time: 1111 }]);
        db.doQueryStrict.onCall(1).resolves([{ block_time: 2222 }]);
        await db.getRawBlockTime.call(db, 100);
        await db.getRawBlockTime.call(db, 101);
        db.doQueryStrict.resolves([{ block_time: 1111 }]);
        const third = await db.getRawBlockTime.call(db, 100);
        assert.strictEqual(third, 1111);
        assert.strictEqual(db.doQueryStrict.callCount, 3, 'revisiting block 100 after 101 must re-query, not read a stale entry');
    });

    it('returns false when the block row is not found (unchanged from unmemoized behavior)', async function () {
        db.doQueryStrict.resolves([]);
        const result = await db.getRawBlockTime.call(db, 999);
        assert.strictEqual(result, false);
    });

    it('rethrows an infrastructure fault instead of returning false, and does not cache it', async function () {
        const fault = new Error('lock wait timeout');
        fault.errno = 1205;
        db.doQueryStrict.onCall(0).rejects(fault);
        db.doQueryStrict.onCall(1).resolves([{ block_time: 1700009999 }]);
        await assert.rejects(() => db.getRawBlockTime.call(db, 100), /lock wait timeout/);
        // Not memoized: the retry re-queries and returns the real value.
        const retried = await db.getRawBlockTime.call(db, 100);
        assert.strictEqual(retried, 1700009999);
        assert.strictEqual(db.doQueryStrict.callCount, 2);
    });
});
