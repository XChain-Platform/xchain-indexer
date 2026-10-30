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
 *
 * XChain Indexer - Database mixin part: events, the reorg health-read warning
 *
 * The rate-limited warn getReorgHealthStats logs when a REORG-marker read fails, so a
 * /health reorg meter that keeps reading null is visible in the indexer log. Plain
 * functions, so they add no methods to Database.prototype.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

// One warn per interval at most; the failures in between are counted, not logged.
const WARN_INTERVAL_MS = 60 * 1000;

// Module-level state (the /health handler calls through a fresh committedView wrapper
// per request, so state on the instance would reset every time and never limit).
let lastWarnAt = null;
let suppressed = 0;

// Log a failed REORG health read at warn, at most once per WARN_INTERVAL_MS.
function warnReorgHealthReadFailed(stage, err, nowMs){
    let now = (nowMs != null) ? nowMs : Date.now();
    if(lastWarnAt !== null && now - lastWarnAt < WARN_INTERVAL_MS){
        suppressed += 1;
        return false;
    }
    let reason = (err && err.message) ? err.message : String(err);
    let tail   = suppressed > 0 ? ' [' + suppressed + ' similar failures suppressed]' : '';
    getLogger().warn('getReorgHealthStats: REORG ' + stage + ' read failed; /health reorg counters left null (' + reason + ')' + tail);
    lastWarnAt = now;
    suppressed = 0;
    return true;
}

// Clear the rate-limit state (tests only).
function resetReorgHealthWarnState(){
    lastWarnAt = null;
    suppressed = 0;
}

module.exports = { warnReorgHealthReadFailed, resetReorgHealthWarnState, WARN_INTERVAL_MS };
