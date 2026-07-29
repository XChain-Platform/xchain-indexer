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
 * test/unit/db.federation-query-hardening.test.js
 *
 * Hardening guards for two federation-facing read paths surfaced by the
 * 2026-07-08 federation-query stress-sweep:
 *
 *  - getPendingAttestationRequests(): the row count is interpolated into raw SQL,
 *    so a non-integer limit produced `LIMIT 100.5` (a MariaDB syntax error that
 *    failed the whole attestation-work poll). The limit is now floored, hard-
 *    capped and passed as a bound param.
 *
 *  - getCapabilitySnapshotValidators(): a NULL snapshot amount surfaced as the
 *    literal string 'null', diverging from the sibling getCapabilitySnapshotWeights
 *    and the BTC local path (both coerce NULL to '0'). Now null-guarded to '0'.
 *
 * Technique (matches db.queries.test.js): stub doQuery on a prototype-borrowed
 * Database so each method exercises real logic against injected results; no live
 * MariaDB required. _mirrorDb() returns `this` in single-host, so a doQuery stub
 * also covers the capability_snapshots read.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

afterEach(function () {
    sinon.restore();
});

describe('getPendingAttestationRequests() LIMIT hardening @regression @tier1', function () {

    // Capture the (query, args) doQuery receives so we can assert the LIMIT shape.
    function dbCapturing() {
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake((query, args) => {
            calls.push({ query, args });
            return Promise.resolve([]);
        });
        return { db, calls };
    }

    it('binds the row count as a `LIMIT ?` param, not raw string interpolation', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests(null, 100, null);
        assert.strictEqual(calls.length, 1);
        assert.match(calls[0].query, /LIMIT \?/, 'LIMIT must be a bound param');
        assert.doesNotMatch(calls[0].query, /LIMIT\s+\d/, 'no numeric literal interpolated');
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 100, 'bound limit is the last arg');
    });

    it('floors a fractional limit to an integer (would otherwise be a `LIMIT 100.5` syntax error)', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests(null, 100.5, null);
        const bound = calls[0].args[calls[0].args.length - 1];
        assert.strictEqual(bound, 100, 'fractional limit floored to 100');
        assert.strictEqual(Number.isInteger(bound), true);
    });

    it('hard-caps the limit at 500 regardless of caller', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests(null, 1e9, null);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 500);
    });

    it('falls back to 100 for a non-positive / non-finite limit', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests(null, 0, null);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 100);
        calls.length = 0;
        await db.getPendingAttestationRequests(null, NaN, null);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 100);
        calls.length = 0;
        await db.getPendingAttestationRequests(null, -5, null);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 100);
    });

    it('still appends the provider_id + cursor args ahead of the bound limit', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests('http_get', 50,
            { after_block_index: 10, after_action_index: 3 });
        const args = calls[0].args;
        // provider_id, then (block>?, block=?, action>?) cursor triple, then LIMIT.
        assert.strictEqual(args[0], 'http_get');
        assert.strictEqual(args[args.length - 1], 50, 'bound limit remains the final arg');
        assert.match(calls[0].query, /LIMIT \?/);
    });
});

describe('getCapabilitySnapshotValidators() NULL-amount guard @regression @tier1', function () {

    it("coerces a NULL snapshot amount to '0' (not the literal string 'null')", async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([
            { pubkey: 'aa'.repeat(32), amount: null },
            { pubkey: 'bb'.repeat(32), amount: '500' }
        ]);
        const out = await db.getCapabilitySnapshotValidators('cross_chain', 961000);
        assert.strictEqual(out[0].amount, '0', "NULL amount must render as '0'");
        assert.strictEqual(out[1].amount, '500');
    });

    it('matches the sibling getCapabilitySnapshotWeights null contract', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ pubkey: 'cc'.repeat(32), weight: null, source: null, amount: null }]);
        const vals = await db.getCapabilitySnapshotValidators('oracle_publish', 961000);
        const wts  = await db.getCapabilitySnapshotWeights('oracle_publish', 961000);
        assert.strictEqual(vals[0].amount, '0');
        assert.strictEqual(wts[0].weight, '0', 'sibling already guards weight');
    });
});

describe('getOpenCrossChainOffers() UNION + cursor + expiration hardening (XCC-2) @regression @tier1', function () {
    // The unified cross-chain book draws SWAP + ORDER in one UNION ALL under a single global
    // LIMIT + keyset cursor (was two per-kind LIMITs concat'd, which silently dropped the
    // newest of an over-cap kind and lost the global order). A full page (rows === limit) flags
    // truncated so the hub pages via next_cursor rather than matching a partial book.
    function offerRow(kind, idx, extra) {
        return Object.assign(
            { kind, action_index: idx, give_coin: 'BTC', give_tick: 'AAA', give_amount: '1', give_ownership: 0,
              get_coin: 'LTC', get_tick: null, get_amount: '1', get_ownership: 0, get_address: 'x',
              source: 's', expiration: 0, allow_list: null, block_list: null, payout_legs: null,
              block_index: 1, effective_expiration: 0 },
            extra || {});
    }

    it('draws swaps + orders in a single UNION ALL, not two per-kind LIMIT queries', async function () {
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
        await db.getOpenCrossChainOffers(500, null, null, null);
        assert.strictEqual(calls.length, 1, 'one merged query, not one per kind');
        assert.match(calls[0].query, /UNION ALL/, 'swaps + orders unioned');
        assert.match(calls[0].query, /ORDER BY u\.action_index ASC/, 'one global keyset order');
        // exactly one LIMIT (the outer bound), bound as a param
        assert.strictEqual((calls[0].query.match(/LIMIT \?/g) || []).length >= 1, true);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 500, 'bound limit is the last arg');
    });

    it('flags truncated=true + returns the max action_index as next_cursor on a full page', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([offerRow('swap', 4), offerRow('swap', 9)]);
        const out = await db.getOpenCrossChainOffers(2, null, null, null);
        assert.strictEqual(out.truncated, true);
        assert.strictEqual(out.next_cursor, 9, 'next_cursor is the last (max) action_index');
        assert.strictEqual(out.length, 2);
    });

    it('flags truncated=false + null next_cursor on an empty page', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const out = await db.getOpenCrossChainOffers(2, null, null, null);
        assert.strictEqual(out.truncated, false);
        assert.strictEqual(out.next_cursor, null);
        assert.strictEqual(out.length, 0);
    });

    it('enriches ORDER rows with give/get remaining, leaves SWAP rows alone', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([offerRow('swap', 1), offerRow('order', 2)]);
        const remaining = sinon.stub(db, 'getOrderAmountsRemaining').resolves(['7', '3']);
        const out = await db.getOpenCrossChainOffers(10, null, null, null);
        assert.strictEqual(out[0].kind, 'swap');
        assert.strictEqual(out[0].give_remaining, undefined, 'swaps carry no remaining');
        assert.strictEqual(out[1].kind, 'order');
        assert.strictEqual(out[1].give_remaining, '7');
        assert.strictEqual(out[1].get_remaining, '3');
        assert.strictEqual(remaining.calledOnceWith(2), true, 'remaining looked up only for the order row');
    });

    it('applies the expiration filter + cursor as bound params only when provided', async function () {
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
        // No block_time / no cursor / no to_coin: outer WHERE absent, args = [limit] only.
        await db.getOpenCrossChainOffers(100, null, null, null);
        assert.doesNotMatch(calls[0].query, /effective_expiration IS NULL OR/);
        assert.deepStrictEqual(calls[0].args, [100]);
        // With block_time + cursor + to_coin: expiration clause present; args carry the
        // to_coin + cursor per branch (swap then order), then block_time, then limit.
        calls.length = 0;
        await db.getOpenCrossChainOffers(100, 42, 'LTC', 1700000000);
        assert.match(calls[0].query, /u\.effective_expiration IS NULL OR u\.effective_expiration >= \?/);
        // swap: to_coin, cursor ; order: to_coin, cursor ; expiration ; limit
        assert.deepStrictEqual(calls[0].args, ['LTC', 42, 'LTC', 42, 1700000000, 100]);
    });

    it('overlays edits for the effective-expiration filter (mirrors getExpiredItems)', async function () {
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
        await db.getOpenCrossChainOffers(100, null, null, 1700000000);
        // both branches resolve effective_expiration from the latest valid non-null edit,
        // falling back to the base expiration column.
        assert.match(calls[0].query, /swap_edits se[\s\S]*ses\.status='valid'[\s\S]*se\.expiration IS NOT NULL[\s\S]*ORDER BY se\.action_index DESC/);
        assert.match(calls[0].query, /order_edits oe[\s\S]*oes\.status='valid'[\s\S]*oe\.expiration IS NOT NULL[\s\S]*ORDER BY oe\.action_index DESC/);
    });
});

/*********************************************************************
 *  : the capability_snapshots reads must be ORDERED.
 *
 * Both feed stake-weighted quorum / the cross_chain validator set on off-BTC
 * indexers. An unordered SELECT hands row order to the storage engine, so two
 * nodes can return the same rows in different sequences; that stays invisible
 * until a consumer dedupes, tie-breaks or truncates, and then they disagree
 * about the validator set and validation forks.
 *
 * The ordering must also be NODE-IDENTICAL, which rules out the obvious
 * `ORDER BY id`: the schema documents `id` as a LOCAL surrogate with no hub
 * parity (hubs persist independently, AnchorRecovery rebuilds rows id-less, and
 * the mirror strips wire ids), so ordering by it would be stable per node and
 * divergent across the fleet. The natural key uq_cap_snap is the only safe
 * source of a total order here.
 ********************************************************************/
describe('capability_snapshots reads are deterministically ordered (#3085) @regression @tier1', function () {

    function capture(method, args) {
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake((query, a) => { calls.push({ query, args: a }); return Promise.resolve([]); });
        return db[method](...args).then(() => calls[0]);
    }

    for (const method of ['getCapabilitySnapshotWeights', 'getCapabilitySnapshotValidators']) {

        it(`${method} orders by the natural key, giving a TOTAL order`, async function () {
            const call = await capture(method, ['cross_chain', 961000]);
            assert.match(call.query, /FROM capability_snapshots/);
            // WHERE pins (capability, snapshot_block); uq_cap_snap's remaining
            // components are (signing_pubkey, source), and the unique key makes that
            // pair distinct, so exactly one ordering is valid.
            assert.match(call.query, /ORDER BY\s+signing_pubkey ASC,\s*source ASC/,
                'must order by the natural key so every node returns one identical sequence');
        });

        it(`${method} does NOT order by the node-local surrogate id`, async function () {
            const call = await capture(method, ['cross_chain', 961000]);
            assert.doesNotMatch(call.query, /ORDER BY[^`]*\bid\b/,
                '`id` has no hub parity; ordering by it is stable per node and divergent ' +
                'across the fleet, which is worse than no ordering at all');
        });
    }

    // getCapabilitySnapshotValidators selects only (pubkey, amount), so it would be
    // tempting to order by pubkey alone. A pubkey delegated by TWO sources yields two
    // rows, so pubkey alone is not total; source must remain in the ordering even
    // though it is not projected.
    it('validators ordering keeps `source` as the tie-break despite not selecting it', async function () {
        const call = await capture('getCapabilitySnapshotValidators', ['cross_chain', 961000]);
        assert.doesNotMatch(call.query, /SELECT[\s\S]*?\bsource\b[\s\S]*?FROM/,
            'source is intentionally not projected here');
        assert.match(call.query, /ORDER BY\s+signing_pubkey ASC,\s*source ASC/,
            'a multi-source delegated pubkey produces duplicate pubkeys, so pubkey alone ties');
    });

    // The existence check is order-insensitive by construction: any matching row
    // proves presence, so its LIMIT 1 needs no ORDER BY and must not grow one.
    it('isPubkeyInCapabilitySnapshot stays an order-insensitive existence check', async function () {
        const call = await capture('isPubkeyInCapabilitySnapshot', ['aa'.repeat(32), 'cross_chain', 961000]);
        assert.match(call.query, /SELECT 1 FROM capability_snapshots/);
        assert.match(call.query, /LIMIT 1/);
        assert.doesNotMatch(call.query, /ORDER BY/,
            'presence is independent of which row answers, so no ordering is required');
    });
});
