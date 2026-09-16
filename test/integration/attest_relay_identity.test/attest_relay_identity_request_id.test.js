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
 * test/integration/attest_relay_identity.test/attest_relay_identity_request_id.test.js
 *
 * The request_id plane of the relay-identity suite: getRelayRequestById against a
 * REAL MariaDB. Why these lookups need a real engine rather than a stub, and the
 * seven properties they share with the origin lookup, are written down in
 * attest_relay_identity.test.js; this file keeps that suite's title, so every
 * full test title reads as it did when the two were one file. The schema, hooks
 * and row writer are test/integration/attest_relay_identity.test/helpers/relay_identity_db.js,
 * on a database of its own.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const { IDX, relayDbName, useRelayIdentityDb } = require('./helpers/relay_identity_db');

const DB_NAME = relayDbName('rid');

// ── 3b. the request_id plane (getRelayRequestById) ───────────────────────
//
// The sibling guard, and the one that shipped counting rejected rows. It runs on
// the SAME wire action, one line above the origin-identity check, and it is the
// cheaper attack of the two: request_id rides the wire and is derivable in public
// from the origin chain's v0, so a watcher does not even need a reorg. Everything
// below is the SQL half, which the unit tier reaches only through a stub.
//
// Three blocks, each with the same two titles and its own copy of the hooks: the
// lookup and its rejected-row exclusion, the lifecycle and ordering cases, then
// the fault and shared-lookup cases.

const RID   = 'a'.repeat(64);
const OTHER_RID = 'b'.repeat(64);

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { row } = fx;

    describe('the request_id admission lookup', function () {
        it('finds the admitted v0 row holding the id', async function () {
            await row({ actionIndex: 50, requestId: RID });

            const hit = await fx.db.getRelayRequestById(RID);
            assert.ok(hit, 'an admitted request_id must be found');
            assert.strictEqual(Number(hit.action_index), 50);
            assert.strictEqual(hit.request_status, 'pending');
        });

        it('returns null for an id this chain has never admitted', async function () {
            await row({ actionIndex: 50, requestId: RID });
            assert.strictEqual(await fx.db.getRelayRequestById(OTHER_RID), null);
        });

        it('lower-cases the id, which arrives from the wire in any case', async function () {
            await row({ actionIndex: 50, requestId: RID });
            assert.ok(await fx.db.getRelayRequestById(RID.toUpperCase()),
                'the column is stored lower-case; an upper-case wire value must still match');
        });

        it('excludes a REJECTED row, so one malformed v3 cannot burn the id', async function () {
            // The defect, driven against real SQL. A refused v3 is still written down
            // with its request_id; if that audit row answered the guard, anyone could
            // watch an origin chain, take the request_id of a request the federation is
            // about to relay, and spend one transaction fee to make it permanently
            // unservable.
            await row({ actionIndex: 51, requestId: RID, status: 'rejected' });

            assert.strictEqual(await fx.db.getRelayRequestById(RID), null,
                'a rejected verdict escrowed nothing and materialized nothing');
        });

        it('sees past the front-run to the real materialization behind it', async function () {
            await row({ actionIndex: 51, requestId: RID, status: 'rejected' });
            await row({ actionIndex: 52, requestId: RID, status: 'pending' });

            const hit = await fx.db.getRelayRequestById(RID);
            assert.ok(hit);
            assert.strictEqual(Number(hit.action_index), 52);
        });
    });
});

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { conn, row } = fx;

    describe('the request_id admission lookup', function () {
        it('counts every NON-rejected lifecycle state, terminal ones included', async function () {
            // The dangerous half of `<> 'rejected'`: a fulfilled or expired request DID
            // materialize, so it must keep the id. Written this way rather than
            // `= 'pending'` so a later tightening cannot re-open double materialization.
            for (const status of ['fulfilled', 'expired', 'errored']) {
                await conn(c => c.query('DELETE FROM attests'));
                await row({ actionIndex: 53, requestId: RID, status });

                const hit = await fx.db.getRelayRequestById(RID);
                assert.ok(hit, 'a ' + status + ' request already spent the id');
                assert.strictEqual(hit.request_status, status);
            }
        });

        it('excludes the v1 response row that carries the same request_id', async function () {
            await row({ actionIndex: 54, version: 1, requestId: RID, status: null });

            assert.strictEqual(await fx.db.getRelayRequestById(RID), null,
                'only a v0 request row consumes the id');
        });

        it('returns the FIRST admission when two rows share the id', async function () {
            await row({ actionIndex: 56, requestId: RID, originActionIndex: IDX + 1 });
            await row({ actionIndex: 55, requestId: RID });

            assert.strictEqual(Number((await fx.db.getRelayRequestById(RID)).action_index), 55);
        });
    });
});

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { conn, row } = fx;

    describe('the request_id admission lookup', function () {
        it('THROWS on a query fault instead of reading as "the id is free"', async function () {
            // Same consensus property as the origin lookup: null here ADMITS the v3.
            await conn(c => c.query('RENAME TABLE attests TO attests_parked'));
            try {
                await assert.rejects(() => fx.db.getRelayRequestById(RID), /attests/);
            } finally {
                await conn(c => c.query('RENAME TABLE attests_parked TO attests'));
            }
        });

        it('leaves the shared row lookup answering for rejected rows', async function () {
            // getAttestationRequestById keeps four consensus callers that need to see
            // every stored row. The narrow query exists precisely so their behaviour did
            // not have to change, and this is that promise asked of real SQL.
            await row({ actionIndex: 57, requestId: RID, status: 'rejected' });

            assert.ok(await fx.db.getAttestationRequestById(RID),
                'the shared lookup still returns the rejected row');
            assert.strictEqual(await fx.db.getRelayRequestById(RID), null,
                'and the admission guard still does not');
        });
    });
});
