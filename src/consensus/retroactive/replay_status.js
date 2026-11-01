/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 *
 * Pure status rules for an open retroactive replay marker.
 *
 *********************************************************************/

'use strict';

const { witnessFromPhase } = require('./witness_status.js');

const RULES_DIGEST = /^[0-9a-f]{64}$/;

function replayReachedTip(marker, committedTip){
    return Boolean(marker
        && marker.state === 'replaying'
        && committedTip >= marker.replay_to);
}

function replayMayComplete(marker, committedTip, witnessPhase){
    const reachedTip = replayReachedTip(marker, committedTip);
    if(witnessPhase === null || witnessPhase === undefined) return reachedTip;

    witnessFromPhase(witnessPhase.phase);
    return reachedTip
        && witnessPhase.phase === 'final'
        && typeof witnessPhase.changed === 'boolean';
}

function heightIsFinal(height, replay){
    if(!replay || replay.state === 'replayed') return true;
    return height < replay.target;
}

function rulesStatusBody(digest, marker, witnessPhase){
    if(!RULES_DIGEST.test(digest)) throw new Error('invalid consensus rules digest');

    const includeWitness = arguments.length >= 3;
    return {
        digest,
        replay: marker === null ? null : {
            state: marker.state,
            target: marker.target,
            replay_to: marker.replay_to,
            ...(includeWitness ? {
                witness: witnessFromPhase(witnessPhase && witnessPhase.phase),
                changed: witnessPhase && typeof witnessPhase.changed === 'boolean'
                    ? witnessPhase.changed : null,
            } : {})
        }
    };
}

module.exports = { replayReachedTip, replayMayComplete, heightIsFinal, rulesStatusBody };
