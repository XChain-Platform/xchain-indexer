// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

// _applyRetraction mirrors the hub's reorg delete onto the local copy. When the broadcast
// carries to_action_index (a deferred/closed-range retraction, item 5296) the replica MUST
// bound its delete identically or it diverges from the hub. The first doQuery call is the delete.
function registerRetractionGuardGroup1(makeApply) { it('open-ended delete for price_snapshots when no to_action_index', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50 });
        assert.match(calls[0].sql, /source_action_index >= \?/);
        assert.ok(!/<= \?/.test(calls[0].sql), 'must stay open-ended');
        assert.deepStrictEqual(calls[0].args, ['BTC', 50]);
    }); }

function registerRetractionGuardGroup2(makeApply) { it('bounded delete for price_snapshots when to_action_index present', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, to_action_index: 75 });
        assert.match(calls[0].sql, /source_action_index >= \? AND source_action_index <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 50, 75]);
    }); }

function registerRetractionGuardGroup3(makeApply) { it('bounded delete for oracle_prices keys on action_index', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'LTC', from_action_index: 1, to_action_index: 9 });
        assert.match(calls[0].sql, /action_index >= \? AND action_index <= \?/);
        assert.deepStrictEqual(calls[0].args, ['LTC', 1, 9]);
    }); }

function registerRetractionGuardGroup4(makeApply) { it('REFUSES an unfenced delete for cross_chain_calls', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, to_action_index: 20 });
        assert.strictEqual(calls.length, 0, 'no DELETE may run for an unfenced quorum-class retraction');
    }); }

function registerRetractionGuardGroup5(makeApply) { it('REFUSES an unfenced delete for cross_chain_matches', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 10, to_action_index: 20 });
        assert.strictEqual(calls.length, 0, 'no DELETE may run for an unfenced quorum-class retraction');
    }); }

function registerRetractionGuardGroup6(makeApply) { it('gen-fenced delete for price_snapshots adds push_generation <= ?', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 });
        assert.match(calls[0].sql, /source_action_index >= \? AND source_action_index <= \? AND push_generation <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 50, 75, 5]);
    }); }

function registerRetractionGuardGroup7(makeApply) { it('gen-fenced open-ended delete for oracle_prices (gen but no to_action_index)', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'LTC', from_action_index: 1, retraction_generation: 7 });
        assert.match(calls[0].sql, /action_index >= \? AND push_generation <= \?/);
        assert.ok(!/action_index <= \?/.test(calls[0].sql), 'no closed-range clause');
        assert.deepStrictEqual(calls[0].args, ['LTC', 1, 7]);
    }); }

function registerRetractionGuardGroup8(makeApply) { it('gen-fenced delete for cross_chain_calls adds push_generation <= ?', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, to_action_index: 20, retraction_generation: 3 });
        assert.match(calls[0].sql, /source_action_index >= \? AND source_action_index <= \? AND push_generation <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 10, 20, 3]);
    }); }

function registerRetractionGuardGroup9(makeApply) { it('gen-fenced PER-LEG delete for cross_chain_matches (a_/b_push_generation)', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 10, to_action_index: 20, retraction_generation: 4 });
        assert.match(calls[0].sql, /a_action_index <= \? AND a_push_generation <= \?/);
        assert.match(calls[0].sql, /b_action_index <= \? AND b_push_generation <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 10, 20, 4, 'BTC', 10, 20, 4]);
    }); }

describe('HubDbSync._applyRetraction closed-range parity @regression @tier3', function () {
    function makeApply() {
        const calls = [];
        const doQuery = sinon.stub().callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, calls };
    }

    registerRetractionGuardGroup1(makeApply);
    registerRetractionGuardGroup2(makeApply);

    registerRetractionGuardGroup3(makeApply);

    // Quorum-class tables refuse unfenced deletions outright (every current
    // source stamps the retraction-generation fence); the fenced variants below stay the
    // closed-range parity coverage for these two tables.
    registerRetractionGuardGroup4(makeApply);
    registerRetractionGuardGroup5(makeApply);

    // Item 5308: when the broadcast carries retraction_generation, the replica mirrors the SAME
    // generation fence (push_generation <= it), so a row re-published at a recycled action_index
    // (higher generation) survives on the replica too. cross_chain_matches fences per leg.
    registerRetractionGuardGroup6(makeApply);
    registerRetractionGuardGroup7(makeApply);

    registerRetractionGuardGroup8(makeApply);
    registerRetractionGuardGroup9(makeApply);
});

function makeApply(ownGeneration) {
    const calls = [];
    const doQuery = sinon.stub().callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });
    const opts = { hubUrl: 'http://hub.test', coin: 'BTC' };
    if (ownGeneration !== undefined) opts.getOwnRollbackGeneration = ownGeneration;
    const sync = new HubDbSync({ doQuery }, opts);
    return { sync, calls };
}
const deletes = (calls) => calls.filter(c => /^DELETE/.test(c.sql));

// ---------------------------------------------------------------------------
// Retraction receive-side guards. row:deleted events are unsigned
// and the hub's push*reorg RPCs forward the caller's claim verbatim, so the
// mirror must not treat them as ground truth: retractions claiming a reorg of
// OUR OWN chain are checked against our own push_generations authority, and
// per-chain generation monotonicity drops stale replays.
// ---------------------------------------------------------------------------
describe('HubDbSync._applyRetraction receive-side guards @regression @tier1', function () {
    it('accepts an own-chain retraction whose fence is below our rollback generation', async function () {
        const { sync, calls } = makeApply(async () => 6);
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 5 });
        assert.strictEqual(deletes(calls).length, 1, 'legitimate backstop delete must apply');
    });

    it('REFUSES an own-chain retraction at/above our rollback generation (forged reorg)', async function () {
        const { sync, calls } = makeApply(async () => 6);
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 6 });
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 999 });
        assert.strictEqual(deletes(calls).length, 0, 'no rollback of ours produced these fences');
    });

    it('REFUSES an own-chain retraction when never rolled back (generation 0)', async function () {
        const { sync, calls } = makeApply(async () => 0);
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 1, retraction_generation: 0 });
        assert.strictEqual(deletes(calls).length, 0);
    });

    it('fails CLOSED when the own-generation read throws', async function () {
        const { sync, calls } = makeApply(async () => { throw new Error('db down'); });
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 1 });
        assert.strictEqual(deletes(calls).length, 0);
    });

    it('REFUSES an unfenced own-chain retraction even for non-quorum tables', async function () {
        const { sync, calls } = makeApply(async () => 6);
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 1 });
        assert.strictEqual(deletes(calls).length, 0, 'our own retractions are always fenced');
    });

    it('other-chain retractions skip the own-generation check but track monotonicity', async function () {
        const { sync, calls } = makeApply(async () => 0);
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'LTC', from_action_index: 10, retraction_generation: 7 });
        assert.strictEqual(deletes(calls).length, 1, 'no local authority for LTC; fenced delete applies');
        // Stale replay below the tracked generation is dropped...
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'LTC', from_action_index: 10, retraction_generation: 6 });
        assert.strictEqual(deletes(calls).length, 1, 'stale replay must be skipped');
        // ...equal-generation redelivery is idempotent and still applied.
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'LTC', from_action_index: 10, retraction_generation: 7 });
        assert.strictEqual(deletes(calls).length, 2, 'same-generation redelivery stays idempotent');
    });

    it('monotonicity is tracked per (table, source_chain), not globally', async function () {
        const { sync, calls } = makeApply(async () => 0);
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'LTC', from_action_index: 10, retraction_generation: 9 });
        await sync._applyRetraction({ table: 'cross_chain_matches', source_chain: 'LTC', from_action_index: 10, retraction_generation: 2 });
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 10, retraction_generation: 1 });
        assert.strictEqual(deletes(calls).length, 3, 'independent keys must not shadow each other');
    });
});

describe('HubDbSync._applyRetraction receive-side guards @regression @tier1', function () {
    it('without the hook (explorer vendored mirror) other-chain legacy behavior is unchanged', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'LTC', from_action_index: 1 });
        assert.strictEqual(deletes(calls).length, 1, 'unfenced non-quorum retraction stays compatible');
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 1 });
        assert.strictEqual(deletes(calls).length, 2, 'own-chain check needs the hook; without it legacy applies');
    });
});
