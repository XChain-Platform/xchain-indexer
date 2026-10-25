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
 * Canonical payload and state transitions for a retroactive replay marker.
 *
 ********************************************************************/

'use strict';

const REPLAY_MARKER_CODE = 'CONSENSUS_RETRO_REPLAY';
const REPLAY_STATES = Object.freeze(['pending', 'replaying', 'replayed']);
const DIGEST_RE = /^[0-9a-f]{64}$/;

function validateTarget(target) {
    if(!Number.isSafeInteger(target) || target < 0)
        throw new TypeError('target must be a non-negative safe integer');
}

function validateReplayTo(replayTo, target) {
    if(!Number.isInteger(replayTo) || replayTo < target)
        throw new TypeError('replay_to must be an integer at or above target');
}

function validateDigest(digest, field) {
    if(typeof digest !== 'string' || !DIGEST_RE.test(digest))
        throw new TypeError(field + ' must be a 64-character lowercase hex digest');
}

function canonicalMarker(marker) {
    if(!marker || typeof marker !== 'object' || Array.isArray(marker))
        throw new TypeError('replay marker must be an object');

    validateTarget(marker.target);
    validateReplayTo(marker.replay_to, marker.target);
    validateDigest(marker.rules_from, 'rules_from');
    validateDigest(marker.rules_to, 'rules_to');
    if(!REPLAY_STATES.includes(marker.state))
        throw new TypeError('state is not a replay state');

    return {
        target: marker.target,
        replay_to: marker.replay_to,
        rules_from: marker.rules_from,
        rules_to: marker.rules_to,
        state: marker.state,
    };
}

function buildReplayMarker({ target, replayTo, rulesFrom, rulesTo } = {}) {
    return canonicalMarker({
        target,
        replay_to: replayTo,
        rules_from: rulesFrom,
        rules_to: rulesTo,
        state: 'pending',
    });
}

function encodeReplayMarker(marker) {
    return JSON.stringify(canonicalMarker(marker));
}

function decodeReplayMarker(data) {
    return canonicalMarker(JSON.parse(data));
}

function advanceReplayMarker(marker, state) {
    const current = canonicalMarker(marker);
    const next = current.state === 'pending' ? 'replaying' :
        current.state === 'replaying' ? 'replayed' : null;
    if(state !== next)
        throw new Error('illegal replay marker transition from ' + current.state + ' to ' + state);
    return canonicalMarker(Object.assign({}, current, { state }));
}

function isReplayOpen(marker) {
    return marker !== null && marker !== undefined &&
        (marker.state === 'pending' || marker.state === 'replaying');
}

module.exports = {
    REPLAY_MARKER_CODE,
    REPLAY_STATES,
    buildReplayMarker,
    encodeReplayMarker,
    decodeReplayMarker,
    advanceReplayMarker,
    isReplayOpen,
};
