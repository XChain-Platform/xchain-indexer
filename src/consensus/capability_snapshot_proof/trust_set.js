/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const { selectTrustPinRaw } = require('./trust_pin.js');
const { parsePinnedSet } = require('./pinned.js');

function held(reason){
    return { trustSet: null, firstUse: false, held: true, reason };
}

function resolveTrustSet(network, snapshotBlock, readEnv){
    const selection = selectTrustPinRaw(network, snapshotBlock, readEnv);
    if(selection.error) return held(selection.error);

    if(selection.raw === null){
        if(network === 'regtest'){
            return { trustSet: null, firstUse: true, held: false, reason: null };
        }
        return held(selection.name + ' is not configured');
    }

    const parsed = parsePinnedSet(selection.raw);
    if(parsed.error) return held(selection.name + ' ' + parsed.error);
    return { trustSet: parsed.set, firstUse: false, held: false, reason: null };
}

module.exports = { resolveTrustSet };
