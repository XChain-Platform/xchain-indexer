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
 * Persistence helpers for retroactive replay markers in the events table.
 *
 ********************************************************************/

'use strict';

const {
    REPLAY_MARKER_CODE,
    encodeReplayMarker,
    decodeReplayMarker,
} = require('../../consensus/retroactive/replay_marker.js');

const REPLAY_MARKER_DATA_MAX = 250;

async function readLatestReplayMarker(db) {
    const rows = await db.doQueryStrict(
        `SELECT data FROM events WHERE code = '${REPLAY_MARKER_CODE}' ORDER BY id DESC LIMIT 1`);
    if(rows.length === 0)
        return null;
    return decodeReplayMarker(rows[0].data);
}

async function recordReplayMarker(db, marker) {
    const encoded = encodeReplayMarker(marker);
    decodeReplayMarker(encoded);
    if(encoded.length > REPLAY_MARKER_DATA_MAX)
        throw new RangeError('replay marker exceeds events.data width');

    await db.doQueryStrict(
        `INSERT INTO events (time, code, data) VALUES (NOW(), '${REPLAY_MARKER_CODE}', ?)`,
        [encoded]);
}

module.exports = {
    REPLAY_MARKER_DATA_MAX,
    readLatestReplayMarker,
    recordReplayMarker,
};
