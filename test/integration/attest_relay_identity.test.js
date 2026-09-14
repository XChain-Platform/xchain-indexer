/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/integration/attest_relay_identity.test.js
 *
 * Runs the relay-identity exactly-once lookup against a REAL MariaDB
 * and applies its migration to a real schema.
 *
 * WHY THIS FILE EXISTS. getRelayRequestByOrigin() is a NEW raw SQL predicate, and
 * it is the whole mechanism here: its return value decides whether an ATTEST
 * v3 materializes an irreversible BTC request or stores an 'invalid' verdict. Its
 * unit sibling (test/unit/actions/attest_relay.test.js) reaches it only through
 * `sinon.stub()`, and .mocharc's spec globs are test/unit/**, so the whole default
 * suite can be green without one byte of this SQL ever having been parsed. A stub
 * proves the CALL happened; it cannot prove the predicate parses, that the novel
 * `request_status <> 'rejected'` exclusion selects the rows the guard's safety
 * argument assumes, or that a JS Number binds to a BIGINT UNSIGNED without
 * silently matching a neighbouring row. This is the same gap already
 * paid for once (commit 94f1a8f); anchor_reward_late_publisher.test.js next door
 * is its remediation and this file follows its conventions deliberately.
 *
 * WHAT IT PINS, each being something a stub cannot falsify:
 *   1. The predicate PARSES and binds, against the real attests schema.
 *   2. version = 0 excludes response rows sharing the relay identity.
 *   3. request_status <> 'rejected' excludes a rejected audit row - the novel
 *      clause, and the one the guard's anti-griefing argument rests on.
 *   4. ORDER BY action_index makes the FIRST materialization canonical.
 *   5. Number() -> BIGINT UNSIGNED round-trips EXACTLY at the top of the
 *      documented range, proven by a neighbouring value NOT matching.
 *   6. doQueryStrict THROWS on a DB fault instead of collapsing to "no prior
 *      materialization" - the difference between a retried block and a fork.
 *   7. The dated migration's DDL executes, is idempotent, and produces an index
 *      byte-identical in shape to the one src/sql/attests.sql declares.
 *
 * The same suite now also covers getRelayRequestById, the request_id plane of the
 * SAME v3 admission. It was the cheaper of the two attacks and it shipped counting
 * rejected rows: request_id rides the wire and is public before the federation
 * broadcasts, so one malformed v3 at a pending id was stored as rejected and then
 * answered the guard for the real relay, permanently, for one transaction fee. It is
 * a second raw predicate with the same stub-shaped blind spot, and its cases in
 * attest_relay_identity_request_id.test.js pin the same seven properties plus one
 * more: the SHARED lookup (getAttestationRequestById, four consensus callers) still
 * returns the rejected row the narrow one hides, which is the ruling's actual
 * constraint.
 *
 * WHERE EACH PART LIVES. This file holds properties 1 to 6 for the origin lookup;
 * attest_relay_identity_request_id.test.js holds the request_id plane and
 * attest_relay_identity_migration.test.js holds property 7. All three keep the one
 * suite title below, so every full test title reads as it did when they were one
 * file, and they share the schema, hooks and row writer in
 * test/helpers/relay_identity_db.js. Each describe block below is one or two
 * numbered properties with its own copy of the hooks.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const { ORIGIN, OTHER, IDX, BIG, relayDbName, useRelayIdentityDb } = require('../helpers/relay_identity_db');

const DB_NAME = relayDbName('');

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { row } = fx;

    // ── 1. the predicate itself ──────────────────────────────────────────────

    it('parses and returns the pending v0 row holding a relay identity', async function () {
        // If the SQL were malformed this is where it surfaces, and it is the assertion
        // the four stubbed unit references cannot make at all.
        await row({ actionIndex: 10 });

        const hit = await fx.db.getRelayRequestByOrigin(ORIGIN, IDX);
        assert.ok(hit, 'a materialized relay identity must be found');
        assert.strictEqual(Number(hit.action_index), 10);
        assert.strictEqual(hit.request_status, 'pending');
    });

    it('returns null for a relay identity this chain has never materialized', async function () {
        await row({ actionIndex: 10 });

        assert.strictEqual(await fx.db.getRelayRequestByOrigin(ORIGIN, IDX + 1), null,
            'a different origin action index is a different identity');
        assert.strictEqual(await fx.db.getRelayRequestByOrigin(OTHER, IDX), null,
            'the identity is the PAIR: the same index on another origin chain is free');
    });

    it('never matches a native request, whose relay columns are NULL', async function () {
        // The `= ?` comparison is NULL-safe by accident of SQL three-valued logic, but
        // "by accident" is exactly what a schema change can take away silently.
        await row({ actionIndex: 10, originChain: null, originActionIndex: null });

        assert.strictEqual(await fx.db.getRelayRequestByOrigin(ORIGIN, IDX), null);
        assert.strictEqual(await fx.db.getRelayRequestByOrigin('', 0), null);
    });

    // ── 2. version = 0 ───────────────────────────────────────────────────────

    it('excludes the v1 response row that shares the relay identity', async function () {
        // A response row carries the same request_id and is written to the same table.
        // Counting it would make the guard reject a legitimate first materialization
        // whose response had somehow landed first, so the version filter is load-bearing,
        // not decoration.
        await row({ actionIndex: 11, version: 1, status: null });

        assert.strictEqual(await fx.db.getRelayRequestByOrigin(ORIGIN, IDX), null,
            'only a v0 request row consumes the exactly-once slot');
    });
});

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { conn, row } = fx;

    // ── 3. request_status <> 'rejected' (the novel clause) ───────────────────

    it("excludes a rejected v0 row, so one malformed v3 cannot grief the identity", async function () {
        // The clause the guard's safety argument rests on. A rejected v3 still persists
        // its origin_chain/origin_action_index for the audit row; if that row counted,
        // anyone could permanently block a legitimate materialization by broadcasting a
        // single malformed v3 naming the same origin action.
        await row({ actionIndex: 12, status: 'rejected' });

        assert.strictEqual(await fx.db.getRelayRequestByOrigin(ORIGIN, IDX), null,
            'a rejected row consumed no slot');
    });

    it('counts every NON-rejected lifecycle state, terminal ones included', async function () {
        // The other half of the same clause, and the more dangerous half: a fulfilled or
        // expired request DID spend the fee, so it must keep consuming the slot. Written
        // as `<> 'rejected'` rather than `= 'pending'` for exactly this reason, and this
        // case is what stops a later "tighten it to pending" edit from re-opening that hole.
        for (const status of ['fulfilled', 'expired', 'errored']) {
            await conn(c => c.query('DELETE FROM attests'));
            await row({ actionIndex: 13, status });

            const hit = await fx.db.getRelayRequestByOrigin(ORIGIN, IDX);
            assert.ok(hit, 'a ' + status + ' request already spent its materialization');
            assert.strictEqual(hit.request_status, status);
        }
    });

    it('sees past a rejected row to the real materialization behind it', async function () {
        await row({ actionIndex: 14, status: 'rejected' });
        await row({ actionIndex: 15, status: 'pending' });

        const hit = await fx.db.getRelayRequestByOrigin(ORIGIN, IDX);
        assert.ok(hit);
        assert.strictEqual(Number(hit.action_index), 15);
    });

    // ── 4. ORDER BY action_index ─────────────────────────────────────────────

    it('returns the FIRST materialization when two rows share the identity', async function () {
        // Determinism, not tidiness: every node must reach the same verdict, and the row
        // returned here is what the stored 'invalid' string is derived against. Inserted
        // out of order so a missing ORDER BY shows up rather than passing by luck.
        await row({ actionIndex: 21, requestId: 'b'.repeat(64) });
        await row({ actionIndex: 20, requestId: 'a'.repeat(64) });

        const hit = await fx.db.getRelayRequestByOrigin(ORIGIN, IDX);
        assert.strictEqual(Number(hit.action_index), 20);
        assert.strictEqual(hit.request_id, 'a'.repeat(64));
    });
});

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { conn, row } = fx;

    // ── 5. Number() -> BIGINT UNSIGNED binding ───────────────────────────────

    it('binds a large origin_action_index EXACTLY, matching no neighbour', async function () {
        // The part a stub can never falsify. getRelayRequestByOrigin coerces with
        // Number(); if the driver rendered that as a float, a lookup would match an
        // adjacent action index and either reject a legitimate request or admit a
        // duplicate. The neighbour assertions are the proof - a hit alone would also be
        // produced by a lossy comparison.
        await row({ actionIndex: 30, originActionIndex: BIG });

        const hit = await fx.db.getRelayRequestByOrigin(ORIGIN, BIG);
        assert.ok(hit, 'the largest safely representable index must round-trip');
        assert.strictEqual(Number(hit.action_index), 30);

        assert.strictEqual(await fx.db.getRelayRequestByOrigin(ORIGIN, BIG - 1), null,
            'the value below must NOT match: that is what proves no rounding happened');
        assert.strictEqual(await fx.db.getRelayRequestByOrigin(ORIGIN, BIG - 2), null);

        // And the stored column is byte-exact, read back as a string so the assertion
        // does not launder the value through the same Number path it is testing.
        const raw = await conn(c => c.query(
            'SELECT CAST(origin_action_index AS CHAR) AS v FROM attests WHERE action_index = 30'));
        assert.strictEqual(raw[0].v, String(BIG));
    });

    it('documents where Number fidelity ends, above the range the schema claims', async function () {
        // Not a defect being fixed here, a boundary being written down. Above
        // MAX_SAFE_INTEGER the loss happens in `parseInt(params[3])` inside the handler,
        // before db.js is reached, so no change to this query can recover it; the
        // `bigIntAsNumber: true` comment in src/db.js states the same range assumption
        // for every BIGINT column in the schema. Recorded so a future reader finds the
        // limit here rather than rediscovering it from a fork.
        const beyond = '9007199254740993';               // 2^53 + 1, not representable
        assert.strictEqual(String(Number(beyond)), '9007199254740992',
            'JS itself loses this before any SQL is involved');

        await conn(c => c.query(
            `INSERT INTO attests (action_index, version, request_id, provider_id, request_status,
                                  origin_chain, origin_action_index, block_index)
             VALUES (31, 0, ?, 'http_get', 'pending', ?, ${beyond}, 900000)`,
            ['c'.repeat(64), ORIGIN]));

        assert.strictEqual(await fx.db.getRelayRequestByOrigin(ORIGIN, Number(beyond)), null,
            'beyond the safe range the lookup misses; the origin index is bounded by the ' +
            'origin chain action count, which is why this is a documented limit not a defect');
    });
});

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { conn } = fx;

    // ── 6. doQueryStrict: a DB fault must not read as "no prior materialization" ──

    it('THROWS on a query fault instead of silently admitting a duplicate', async function () {
        // The consensus property the doQuery -> doQueryStrict choice buys. Under doQuery
        // a non-transactional query error is swallowed and returns [], which this method
        // turns into null, which the v3 guard reads as "nothing materialized yet" - so a
        // single faulting node writes a 'valid' row every other node rejected. A throw
        // rolls the block back and retries it. Simulated by removing the table, the
        // cheapest real fault that is not a credential or a network partition.
        await conn(c => c.query('RENAME TABLE attests TO attests_parked'));
        try {
            await assert.rejects(
                () => fx.db.getRelayRequestByOrigin(ORIGIN, IDX),
                /attests/,
                'a DB fault must surface, never collapse into a null the guard trusts');
        } finally {
            await conn(c => c.query('RENAME TABLE attests_parked TO attests'));
        }
    });
});
