/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 *
 * Unit coverage for append-only retroactive replay marker events.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const {
    REPLAY_MARKER_DATA_MAX,
    readLatestReplayMarker,
    recordReplayMarker,
} = require('../../../../src/db/events/retroactive_replay_marker.js');
const {
    buildReplayMarker,
    encodeReplayMarker,
    advanceReplayMarker,
} = require('../../../../src/consensus/retroactive/replay_marker.js');

function makeDb(rows = []) {
    const calls = [];
    return {
        calls,
        async doQueryStrict(sql, params) {
            calls.push({ sql: String(sql), params: params || [] });
            return rows;
        },
    };
}

function makeMarker(digest = 'a'.repeat(64)) {
    return buildReplayMarker({
        target: 10,
        replayTo: 20,
        rulesFrom: digest,
        rulesTo: digest,
    });
}

function assertAppendOnly(db) {
    assert.ok(db.calls.every(({ sql }) => !/UPDATE|DELETE/i.test(sql)));
}

describe('retroactive replay marker events @regression @tier1', function () {
    it('returns null when there is no CONSENSUS_RETRO_REPLAY row', async function () {
        const db = makeDb();

        assert.strictEqual(await readLatestReplayMarker(db), null);
        assert.strictEqual(db.calls.length, 1);
    });

    it('reads the newest marker row first and decodes it', async function () {
        const marker = makeMarker();
        const db = makeDb([{ data: encodeReplayMarker(marker) }]);

        assert.deepStrictEqual(await readLatestReplayMarker(db), marker);
        assert.match(db.calls[0].sql, /WHERE code = 'CONSENSUS_RETRO_REPLAY'/);
        assert.match(db.calls[0].sql, /ORDER BY id DESC LIMIT 1/);
    });

    it('throws when the newest marker row is malformed', async function () {
        const db = makeDb([{ data: '{bad' }]);

        await assert.rejects(readLatestReplayMarker(db));
    });

    it('inserts the encoded marker as an append-only event', async function () {
        const marker = advanceReplayMarker(makeMarker(), 'replaying');
        const db = makeDb();

        await recordReplayMarker(db, marker);

        assert.strictEqual(db.calls.length, 1);
        assert.match(db.calls[0].sql, /INSERT INTO events/);
        assert.match(db.calls[0].sql,
            /VALUES \(NOW\(\), 'CONSENSUS_RETRO_REPLAY', \?\)/);
        assert.deepStrictEqual(db.calls[0].params, [encodeReplayMarker(marker)]);
        assertAppendOnly(db);
    });

    it('keeps a maximal replayed marker within REPLAY_MARKER_DATA_MAX', async function () {
        const digest = 'f'.repeat(64);
        const pending = buildReplayMarker({
            target: 9999999999,
            replayTo: 9999999999,
            rulesFrom: digest,
            rulesTo: digest,
        });
        const marker = advanceReplayMarker(
            advanceReplayMarker(pending, 'replaying'), 'replayed');
        const db = makeDb();

        assert.ok(encodeReplayMarker(marker).length <= REPLAY_MARKER_DATA_MAX);
        await recordReplayMarker(db, marker);
        assert.strictEqual(db.calls.length, 1);
        assertAppendOnly(db);
    });

    it('refuses an invalid marker before issuing a query', async function () {
        const db = makeDb();
        const marker = Object.assign({}, makeMarker(), { state: 'done' });

        await assert.rejects(recordReplayMarker(db, marker));
        assert.deepStrictEqual(db.calls, []);
    });
});
