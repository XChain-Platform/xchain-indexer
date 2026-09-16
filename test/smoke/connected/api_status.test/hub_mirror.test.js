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
 * Smoke test: REST /status endpoint (hub mirror connectivity)
 *
 * The hubMirror field of GET /status, over the same reconstructed route as
 * test/smoke/connected/api_status.test.js (./helpers/status_app.js): a live
 * snapshot, a disconnected one, no mirror at all, and a snapshot call that
 * throws. Does NOT start the indexer loop or connect to any database.
 */

'use strict';

const assert     = require('assert');
const { getJson, listen } = require('./helpers/status_app.js');

// Sibling blocks under the /status suite title, so every full test title matches
// the one suite these cases share with api_status.test.js.
describe('Smoke: REST /status', function () {
    this.timeout(5000);

    // -------------------------------------------------------------------------
    // Hub mirror connectivity (row 48). connected/disconnected snapshots, the
    // unconfigured (no hubDbSync at all) case, and a throwing snapshot: none of
    // these may claim connected or fail the whole probe.
    // -------------------------------------------------------------------------
    it('SM-05i: GET /status surfaces hubMirror connected from a live mirror snapshot', async function () {
        const snapshot = { configured: true, connected: true, bootstrapped: true,
                            streamWatermark: 1700000000, tables: { attestation_responses: 1700000000 } };
        const { server, port } = await listen({
            indexerDb: { async getLatestBlockIndex() { return 100; } },
            lastDecoderBlock: 100,
            isSynced() { return true; },
            hubDbSync: { mirrorStatus() { return snapshot; } },
        });
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200);
            assert.deepStrictEqual(body.hubMirror, snapshot);
        } finally {
            server.close();
        }
    });

    it('SM-05j: GET /status surfaces hubMirror disconnected without claiming connected', async function () {
        const { server, port } = await listen({
            indexerDb: { async getLatestBlockIndex() { return 100; } },
            lastDecoderBlock: 100,
            isSynced() { return true; },
            hubDbSync: { mirrorStatus() { return { configured: true, connected: false, bootstrapped: false,
                                                    streamWatermark: 0, tables: {} }; } },
        });
        try {
            const { body } = await getJson(port, '/status');
            assert.strictEqual(body.hubMirror.configured, true);
            assert.strictEqual(body.hubMirror.connected, false);
        } finally {
            server.close();
        }
    });
});

describe('Smoke: REST /status', function () {
    this.timeout(5000);

    it('SM-05k: GET /status reports hubMirror as unconfigured, never throwing, when the mirror is absent', async function () {
        const { server, port } = await listen({
            indexerDb: { async getLatestBlockIndex() { return 100; } },
            lastDecoderBlock: 100,
            isSynced() { return true; },
            // no hubDbSync at all: single-host deployment, HUB_DB_SYNC_ENABLED unset
        });
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200);
            assert.deepStrictEqual(body.hubMirror,
                { configured: false, connected: false, bootstrapped: false, streamWatermark: null, tables: {} });
        } finally {
            server.close();
        }
    });

    it('SM-05l: GET /status degrades to the disabled hubMirror shape when the snapshot call throws', async function () {
        const { server, port } = await listen({
            indexerDb: { async getLatestBlockIndex() { return 100; } },
            lastDecoderBlock: 100,
            isSynced() { return true; },
            hubDbSync: { mirrorStatus() { throw new Error('boom'); } },
        });
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200, 'a mirror snapshot failure must not fail the whole probe');
            assert.strictEqual(body.hubMirror.connected, false, 'a throw must never read as connected');
            assert.strictEqual(body.hubMirror.configured, false);
        } finally {
            server.close();
        }
    });
});
