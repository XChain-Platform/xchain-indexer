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
 * test/unit/hub_db_sync_attestation_responses.test.js
 *
 * attestation_responses mirror registration (the ATTEST response-mirror
 * design, not an on-chain response transaction).
 *
 * The finalized ATTEST response reaches every indexer through hub_db_sync
 * instead of through a validator-paid on-chain transaction, which puts three
 * registrations on the consensus path and one seam under the barrier row:
 *
 *   1. HUB_STATE_TABLES membership, which is also what puts the table in the
 *      bootstrap drain loop (the loop concatenates the class arrays).
 *   2. The natural-key id strip in _applyRow. Every hub that holds the
 *      finalized artifact writes its OWN row and gossips it, so two hubs carry
 *      different ids for one logical row; identity is UNIQUE (network,
 *      request_id) and a wire id kept here can land on a locally-assigned PK
 *      where INSERT IGNORE drops a real response with no error.
 *   3. FULL_REPAGE_TABLES membership, which FOLLOWS FROM (2) rather than from
 *      any in-place upgrade: once the ids are locally assigned, a
 *      since_id = MAX(local id) cursor is not a position in the followed hub's
 *      id space at all.
 *   4. The frozen watermark grace and its regtest-only env seam.
 *   5. The one-column batch-link upsert. Every signed column is fixed by the first
 *      insert, and only batch_action_index (the display link to the on-chain
 *      v5/v6 batch) can be filled later, from NULL, once.
 *
 * These are driven against the real methods, not asserted against the
 * declarations: every test below reads the SQL the mirror would actually issue
 * or the cursor it would actually ask the hub for. Each is falsifiable by
 * removing the table from the list it pins (both falsifications were run).
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const {
    HubDbSync, FROZEN, GRACE_ENV, RESPONSE_COLUMNS, CHECKPOINT_COLUMNS,
    makeSync, insertFor, responseRow, splitAssignments, makeStoredSync,
} = require('./hub_db_sync_attestation_responses.test/helpers/fixtures.js');

describe('HubDbSync attestation_responses mirror registration @regression @tier1', function () {
    afterEach(function () {
        delete process.env[GRACE_ENV];
        sinon.restore();
    });

    // ── class membership, proved through the drain loop rather than the array ──

    it('_bootstrapAll drains attestation_responses, which is what HUB_STATE_TABLES membership buys', async function () {
        const { sync } = makeSync();
        const drained = [];
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) => { drained.push(table); return 1; });
        sinon.stub(sync, 'advanceWatermark');
        await sync.bootstrapAll();
        assert.ok(drained.indexOf('attestation_responses') !== -1,
            'the bootstrap loop must page attestation_responses; it concatenates the class arrays, so ' +
            'membership in HUB_STATE_TABLES is the whole mechanism');
    });

    // ── the natural-key id strip ──

    it('_applyRow strips the hub id from an attestation_responses row', async function () {
        const { sync, queries } = makeSync();
        const row = responseRow();
        await sync._applyRow('attestation_responses', row);

        const inserts = insertFor(queries, 'attestation_responses');
        assert.strictEqual(inserts.length, 1, 'exactly one INSERT for the row');
        const sql = inserts[0].sql;

        // The column list, read out of the generated SQL rather than assumed.
        const cols = /\(([^)]*)\) VALUES/.exec(sql)[1].split(',').map(s => s.trim().replace(/`/g, ''));
        assert.ok(cols.indexOf('id') === -1,
            'the hub id must not be written: hub ids are hub-LOCAL (every hub that verifies the ' +
            'gossiped result inserts its own row), so a wire id can collide with a locally-assigned ' +
            'PK and INSERT IGNORE would silently drop a real response. Generated SQL was: ' + sql);
        assert.ok(cols.indexOf('network') !== -1 && cols.indexOf('request_id') !== -1,
            'the natural key (network, request_id) must be written, or the row has no identity');
        assert.strictEqual(inserts[0].args.length, cols.length, 'one bound arg per written column');
        assert.ok(inserts[0].args.indexOf(row.id) === -1, 'the hub id must not be bound as a value either');
    });

    it('_applyRow falls back to a plain INSERT IGNORE for a row that carries no link column', async function () {
        const { sync, queries } = makeSync();
        const row = responseRow();
        delete row.batch_action_index;                   // a hub that does not serve the column yet
        await sync._applyRow('attestation_responses', row);
        assert.ok(/^INSERT IGNORE INTO attestation_responses /.test(insertFor(queries, 'attestation_responses')[0].sql),
            'with no link on the wire there is nothing to upsert, and the plain insert keeps a hub that ' +
            'predates the column working unchanged');
    });
});

describe('HubDbSync attestation_responses mirror registration @regression @tier1', function () {
    afterEach(function () {
        delete process.env[GRACE_ENV];
        sinon.restore();
    });

    it('_applyRow KEEPS the id for state_checkpoints, the id-parity control in the same class', async function () {
        const { sync, queries } = makeSync();
        await sync._applyRow('state_checkpoints', { id: 77, network: 'regtest', chain: 'BTC',
                                                   block_index: 5, state_hash: 'e'.repeat(64), checkpoint_seq: 3 });
        const cols = /\(([^)]*)\) VALUES/.exec(insertFor(queries, 'state_checkpoints')[0].sql)[1]
            .split(',').map(s => s.trim());
        assert.ok(cols.indexOf('id') !== -1,
            'state_checkpoints is an id-parity mirror; if the strip reaches it, the strip condition is ' +
            'too broad and this suite would pass for the wrong reason');
    });

    // ── the one-column batch-link upsert ──

    it('generates an upsert whose ONLY assignment is a first-stamp-wins batch_action_index', async function () {
        const { sync, queries } = makeSync();
        await sync._applyRow('attestation_responses', responseRow());
        const sql = insertFor(queries, 'attestation_responses')[0].sql;

        assert.ok(/^INSERT INTO attestation_responses /.test(sql),
            'a plain INSERT IGNORE would drop the batch stamp the hub sends as a re-broadcast of an ' +
            'already-mirrored row, leaving the link NULL on every streamed mirror while a fresh ' +
            'bootstrap served it. Generated SQL was: ' + sql);
        const odku = /ON DUPLICATE KEY UPDATE (.+)$/.exec(sql);
        assert.ok(odku, 'the upgrade clause must be present. Generated SQL was: ' + sql);
        assert.deepStrictEqual(splitAssignments(odku[1]),
            ['batch_action_index = COALESCE(batch_action_index, VALUES(batch_action_index))'],
            'EXACTLY one assignment, and it fills from NULL only. Every other column is content a ' +
            'responsible set signed and this node has already verified; making one of them assignable ' +
            'would let a re-delivery rewrite a verified response under an unchanged natural key');
    });

    it('a re-delivered row cannot rewrite a signed column', async function () {
        const { sync, stored } = makeStoredSync();
        const first = responseRow();
        await sync._applyRow('attestation_responses', first);

        const forged = responseRow();
        forged.signatures       = '[{"pubkey":"' + 'e'.repeat(64) + '","sig":"' + 'f'.repeat(128) + '"}]';
        forged.response_payload = '{"ok":false}';
        forged.status           = 'expired';
        await sync._applyRow('attestation_responses', forged);

        assert.strictEqual(stored().signatures, first.signatures,
            'the stored signature set must survive a re-delivery: the row is transport, the applier ' +
            'has already verified this copy, and the natural key is the identity rather than the body');
        assert.strictEqual(stored().response_payload, first.response_payload, 'the attested body is fixed at insert');
        assert.strictEqual(stored().status, first.status, 'the terminal status is fixed at insert');
    });
});

describe('HubDbSync attestation_responses mirror registration @regression @tier1', function () {
    afterEach(function () {
        delete process.env[GRACE_ENV];
        sinon.restore();
    });

    it('fills a NULL link from a re-delivery and stamps the applied v1 row through the request id', async function () {
        const { sync, stored, setter } = makeStoredSync();
        await sync._applyRow('attestation_responses', responseRow());
        assert.strictEqual(stored().batch_action_index, null, 'the row mirrors before its batch lands');
        assert.strictEqual(setter.callCount, 0, 'nothing to carry while the link is NULL');

        const linked = responseRow();
        linked.batch_action_index = 4242;
        await sync._applyRow('attestation_responses', linked);

        assert.strictEqual(stored().batch_action_index, 4242, 'the stamp must land on the mirrored row');
        assert.strictEqual(setter.callCount, 1,
            'the v1 row the applier minted locally also carries the link, and the request id is the only ' +
            'identifier the two sides share: the batch is parsed on DOGE and names its responses by ' +
            'request_id, while the v1 action index was assigned on BTC');
        assert.deepStrictEqual(setter.firstCall.args, ['a'.repeat(64), 4242]);
    });

    it('a SECOND batch claiming the same response moves neither copy', async function () {
        const { sync, stored, setter } = makeStoredSync();
        const first = responseRow();
        first.batch_action_index = 4242;
        await sync._applyRow('attestation_responses', first);

        const second = responseRow();
        second.batch_action_index = 9999;
        await sync._applyRow('attestation_responses', second);

        assert.strictEqual(stored().batch_action_index, 4242, 'first stamp wins, as COALESCE says');
        assert.strictEqual(setter.callCount, 2, 'the link is re-asserted, never recomputed');
        assert.deepStrictEqual(setter.secondCall.args, ['a'.repeat(64), 4242],
            'the setter must write the value now STORED in the mirror, not the one that just arrived, ' +
            'or the two copies of a display link disagree after a duplicate batch');
    });

    it('skips the link entirely when there is no local indexer connection to stamp', async function () {
        const { sync, queries } = makeSync();
        const linked = responseRow();
        linked.batch_action_index = 4242;
        await sync._applyRow('attestation_responses', linked);
        assert.strictEqual(queries.filter(q => /^SELECT batch_action_index/.test(q.sql)).length, 0,
            'the explorer vendors this same client against a pool with no indexer and no attests table; ' +
            'the mirrored row still applies there, only the local stamp is skipped');
    });
});
