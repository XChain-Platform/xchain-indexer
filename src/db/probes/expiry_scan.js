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
 * XChain Indexer - read-only probe of the per-block expiry scans
 *
 * Runs the shipped getExpiredItems and findCancelledDispensers through a receiver whose
 * doQuery / doQueryStrict first EXPLAIN each statement and then time it, so the plan and
 * the wall time are those of the exact SQL the block loop issues. It also reports
 * whether the latest-status probe inside findCancelledDispensers reads the
 * dispenser_action_action index on dispenser_statuses. Used by bin/expiry-scan-probe.js
 * to size the scans on a real indexer DB; it is not on any block path.
 *
 * Read-only by construction: a captured statement that is not a SELECT is refused before
 * it reaches the database, so a future write inside either method fails the probe
 * instead of mutating the indexer it is pointed at.
 *
 ********************************************************************/

'use strict';

const DISPENSER_ACTION_INDEX = 'dispenser_action_action';
const QUERY_METHODS = ['doQuery', 'doQueryStrict'];

function monotonicMs(){
    return Number(process.hrtime.bigint()) / 1e6;
}

function isReadStatement(sql){
    return /^\s*(\(\s*)?SELECT\b/i.test(String(sql));
}

// A receiver that inherits every method and field of `db` but routes its query methods
// through EXPLAIN plus timing, recording one entry per statement in `calls`.
// The EXPLAIN goes through doQueryStrict when the db has it: doQuery turns a query
// error into [], which would print as an empty plan instead of the failure.
function instrumentedReceiver(db, calls, clock){
    const receiver = Object.create(db);
    const explain = (typeof db.doQueryStrict === 'function' ? db.doQueryStrict : db.doQuery).bind(db);
    for(const name of QUERY_METHODS){
        if(typeof db[name] !== 'function') continue;
        const original = db[name].bind(db);
        receiver[name] = async function(sql, args){
            if(!isReadStatement(sql))
                throw new Error('expiry scan probe refuses a non-SELECT statement: ' + String(sql).trim().slice(0, 60));
            const bound = Array.isArray(args) ? args.slice() : args;
            const plan = await explain('EXPLAIN ' + sql, bound);
            const started = clock();
            const rows = await original(sql, bound);
            calls.push({
                number: calls.length + 1,
                wallMs: clock() - started,
                rows:   Array.isArray(rows) ? rows.length : 0,
                plan:   Array.isArray(plan) ? plan : [],
            });
            return rows;
        };
    }
    return receiver;
}

// Run db[method](...args) under the instrumented receiver.
async function probeMethod(db, method, args, clock){
    if(!db || typeof db[method] !== 'function')
        throw new TypeError('expiry scan probe needs db.' + method);
    const calls = [];
    const receiver = instrumentedReceiver(db, calls, clock);
    const started = clock();
    const result = await db[method].apply(receiver, args);
    return {
        method,
        args,
        wallMs:  clock() - started,
        results: Array.isArray(result) ? result.length : 0,
        calls,
    };
}

// The table aliases whose plan row reads the dispenser_action_action index.
function dispenserActionActionUse(calls){
    const aliases = [];
    for(const call of calls){
        for(const row of call.plan){
            if(row && String(row.key || '') === DISPENSER_ACTION_INDEX)
                aliases.push(String(row.table));
        }
    }
    return aliases;
}

async function probeExpiryScan(db, opts){
    const { blockTime, blockIndex } = opts;
    const clock = opts.clock || monotonicMs;
    const expired   = await probeMethod(db, 'getExpiredItems', [blockTime], clock);
    const cancelled = await probeMethod(db, 'findCancelledDispensers', [blockTime, blockIndex], clock);
    return {
        blockTime:  Number(blockTime),
        blockIndex: Number(blockIndex),
        probes:     [expired, cancelled],
        dispenserActionAction: dispenserActionActionUse(cancelled.calls),
    };
}

// The mariadb driver returns EXPLAIN's row estimate as a BigInt, which JSON.stringify rejects.
function bigintAsString(key, value){
    return typeof value === 'bigint' ? value.toString() : value;
}

function renderProbe(probe){
    const lines = [probe.method + ' total=' + probe.wallMs.toFixed(3) + 'ms queries=' +
        probe.calls.length + ' results=' + probe.results];
    for(const call of probe.calls){
        lines.push('  query ' + call.number + ' wall=' + call.wallMs.toFixed(3) + 'ms rows=' + call.rows);
        for(const row of call.plan)
            lines.push('    plan ' + JSON.stringify(row, bigintAsString));
    }
    return lines;
}

function renderExpiryScanProbe(result){
    const lines = ['expiry scan probe block_index=' + result.blockIndex + ' block_time=' + result.blockTime];
    for(const probe of result.probes) lines.push(...renderProbe(probe));
    lines.push(DISPENSER_ACTION_INDEX + ' lookup in findCancelledDispensers: ' +
        (result.dispenserActionAction.length ? 'used by ' + result.dispenserActionAction.join(', ') : 'NOT used'));
    return lines.join('\n');
}

module.exports = { probeExpiryScan, renderExpiryScanProbe, DISPENSER_ACTION_INDEX };
