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

// Why a mirror-resolved capability row is still held, at most once a minute per row.
// A held row stalls this chain's block loop at the proof barrier, and without the
// reason a stuck row cannot be told apart from a slow checkpoint (the hub answered
// 404 or 503, or served a proof that does not verify). Diagnostic only: it never
// changes the verdict and never throws.

const INTERVAL_MS = 60000;
const MAX_ROWS = 64;

function createHeldLog(options = {}){
    const now = options.now || (() => Date.now());
    const warn = options.warn;
    const lastLogged = new Map();

    return function logHeld(row, reason){
        try {
            const key = [row && row.snapshot_block, row && row.capability, row && row.signing_pubkey].join('|');
            const at = now();
            const last = lastLogged.get(key);
            if(last !== undefined && at - last < INTERVAL_MS) return false;
            lastLogged.delete(key);
            lastLogged.set(key, at);
            while(lastLogged.size > MAX_ROWS) lastLogged.delete(lastLogged.keys().next().value);
            warn('Capability snapshot proof held for snapshot_block ' + String(row && row.snapshot_block) +
                ' capability ' + String(row && row.capability) + ': ' + String(reason).slice(0, 200));
            return true;
        } catch(e){
            return false;
        }
    };
}

module.exports = { createHeldLog };
