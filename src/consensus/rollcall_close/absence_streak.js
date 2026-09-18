/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Steps (7) and (8) of a ROLLED ROLLCALL close: the absent sources, each
 * one's K-streak over the pinned lookback window, and the absence rows that
 * record it, eviction flag included.
 *
 ********************************************************************/

const rca = require('../gates/rollcall_gate.js');

// Parse a pinned responsible set back into a Set of source addresses. A row whose
// JSON is missing or unparseable yields null, and the caller must then treat that
// epoch as one it cannot judge membership at rather than as an empty set: an
// empty set would silently make every source "not in R" and skip the epoch,
// quietly shortening every streak.
function pinnedSources(row){
    if(!row || row.responsible_set_json === null || row.responsible_set_json === undefined) return null;
    try {
        let parsed = JSON.parse(row.responsible_set_json);
        if(!Array.isArray(parsed)) return null;
        return new Set(parsed.map((s) => String(s)));
    } catch(e){ return null; }
}

// One absent source's streak, walked over `lookback` (newest first) and capped at
// ROLLCALL_EVICT_MISSES. `priorAbsences` is the set of epochs it was recorded absent at.
function sourceStreak(source, lookback, priorAbsences, epochHeight){
    let streak = 0;
    for(let row of lookback){                       // newest first
        let eh = parseInt(row.epoch_height);

        // This epoch: absence is what we just measured, membership is given.
        if(eh === epochHeight){ streak++; if(streak >= rca.ROLLCALL_EVICT_MISSES) break; continue; }

        // Epochs the source was not responsible for are SKIPPED: not counted and
        // not streak-ending. That is what stops a source resetting its streak by
        // dipping under the capability floor for one epoch with a partial UNSTAKE.
        // An unreadable pin is treated as "cannot judge membership", which ends
        // the walk rather than silently skipping and over-counting the streak.
        let pinned = pinnedSources(row);
        if(pinned === null) break;
        if(!pinned.has(source)) continue;

        if(!priorAbsences.has(eh)) break;           // present: the streak ends
        streak++;
        if(streak >= rca.ROLLCALL_EVICT_MISSES) break;
    }
    return streak;
}

// Measure and write this epoch's absences. `sortedSources` is the pinned set in
// consensus order, so the absence rows and the eviction order follow it.
// Returns { absentSources, evictedSources }.
async function measureAbsences(indexerDb, epochHeight, closeBlock, sortedSources, presentSources){
    // (7) Absences, pinned against the set at S and never re-derived.
    let absentSources = sortedSources.filter((s) => !presentSources.has(s));

    // (8) The K-streak, over the pinned lookback window. The window includes this
    // epoch's own row, which was written above.
    let lookback = await indexerDb.getRolledRollcallEpochs(epochHeight, rca.ROLLCALL_STREAK_LOOKBACK);
    let evictedSources = [];
    let absenceRows    = [];

    for(let source of absentSources){
        let priorAbsences = new Set(
            await indexerDb.getRollcallAbsenceEpochsForSource(source, lookback.map((r) => parseInt(r.epoch_height))));

        let streak = sourceStreak(source, lookback, priorAbsences, epochHeight);

        let evicted = (streak >= rca.ROLLCALL_EVICT_MISSES);
        if(evicted) evictedSources.push(source);
        absenceRows.push({ epoch_height: epochHeight, source: source, close_block: closeBlock, evicted: evicted });
    }

    if(absenceRows.length > 0)
        await indexerDb.insertRollcallAbsences(absenceRows);
    return { absentSources, evictedSources };
}

module.exports = { pinnedSources, sourceStreak, measureAbsences };
