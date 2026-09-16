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
 * XChain Platform - bridge settle pass: the refusal and deferral log, and its memo.
 *
 * BUILT BY THE ENTRY, ONE MEMO PER ENTRY INSTANCE, and that is why this is a factory rather
 * than a module holding a Map. The memo is per-process state whose lifetime used to be the
 * settle module's own: a suite that purges and re-requires the entry (requireDisarmed in
 * bridge_settle.test.js) got a fresh memo, and a second suite requiring the entry normally got
 * a different one again. A Map at module scope here would instead be SHARED by every instance
 * of the entry in one mocha process, so one suite's refusal could suppress the log line another
 * suite asserts. Building it with the entry keeps the lifetimes exactly as they were.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

// Per-process memo of the last TERMINAL refusal reason logged for (kind, id), so a row that sits
// refused in the due set logs once instead of once per settle pass. Keyed on the log label
// ('XBRIDGE' or 'XPOLICY') rather than on the settlements table's 'transfer'/'policy' kind so a
// transfer id and a snapshot id that happen to collide in the id column never
// collide here either. Bounded so a long-running indexer cannot grow this without limit: past
// the cap, inserting a brand-new id evicts the oldest entry first (a plain FIFO over insertion
// order), which only costs one extra line for an id that has not refused in a very long while,
// never a suppressed one.
const REFUSAL_MEMO_CAP = 5000;

module.exports = function createRefusalLog(){
    const _refusalMemo = new Map();

    // One log line per refusal or deferral, naming the id and the reason, which is the single line
    // both specs ask for. Deliberately not an exception: a refused row is ordinary operation.
    //
    // TWO CLASSES, split by whether a later pass can change the outcome. A DEFERRAL (a row not yet
    // due, a capability snapshot not yet mirrored, a policy seq gap or leg carried forward) is meant
    // to be re-examined every pass, so each of its lines is a fresh, true statement about that pass
    // and it keeps calling log/warn directly. A TERMINAL refusal (a bad signature, a foreign
    // network or chain id, an escrow that would go negative, a second settlement for one source leg)
    // names a fact about the ROW that does not change from one pass to the next, so a row sitting
    // refused in the due set would otherwise re-log the same event every pass forever; that is what
    // storms the log and is what the "exactly one refusal" requirement rules out. Terminal call sites use
    // warnOnce below instead of warn.
    function log(kind, id, message){
        getLogger().info('\t ' + kind + ' : ' + String(id).substring(0, 16) + '... : ' + message);
    }
    function warn(kind, id, message){
        getLogger().warn('\t ' + kind + ' : ' + String(id).substring(0, 16) + '... : ' + message);
    }

    // True the first time (kind, id) refuses, and true again only when the reason for that id
    // CHANGES (a genuinely new refusal); false when it repeats. `reason` is the SETTLE_REASON
    // constant, never the fully formatted message, so two refusals in the same class with different
    // incidental detail (a different escrow address, a different quorum count) still count as one
    // refusal and do not re-log.
    function shouldLogRefusal(kind, id, reason){
        const key = kind + '' + String(id);
        if(_refusalMemo.get(key) === reason) return false;
        if(!_refusalMemo.has(key) && _refusalMemo.size >= REFUSAL_MEMO_CAP){
            const oldestKey = _refusalMemo.keys().next().value;
            _refusalMemo.delete(oldestKey);
        }
        _refusalMemo.set(key, reason);
        return true;
    }

    // A terminal refusal: warn once per (kind, id) unless the reason changes. Byte-identical to a
    // plain warn call on the FIRST occurrence, which is what the rail suite greps the log for.
    function warnOnce(kind, id, reason, message){
        if(shouldLogRefusal(kind, id, reason)) warn(kind, id, message);
    }

    // Test-only: forget every memoized refusal, so a unit test can run one id through the settle
    // pass more than once and observe it as a fresh process would.
    function resetRefusalMemo(){
        _refusalMemo.clear();
    }

    return {
        log,
        warn,
        warnOnce,
        shouldLogRefusal,
        resetRefusalMemo,
        memoSize: () => _refusalMemo.size,
    };
};
