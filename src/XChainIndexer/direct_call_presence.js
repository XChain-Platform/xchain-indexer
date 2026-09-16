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
 * XChain Indexer - Direct-hub-DB call-presence barrier
 *
 * The single-host (no-mirror) twin of the HubDbSync call barrier. Before the
 * cross-chain-call pass the block loop waits, bounded, until the hub database this
 * node reads directly covers the block: by clock below the mirror-admission
 * activation, by the hub's persisted admission height above it. Installed onto
 * XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const { HUB_SYNC_WATERMARK_GRACE_S } = require('../hub/hub_db_sync.js');
// Only the margin table is read from the activation module. admitMarginBlocks is a pure
// lookup over a frozen table, so holding it from require time carries no activation arm
// (the admission suites purge and re-require the activation module to re-arm it).
const { admitMarginBlocks } = require('../consensus/gates/mirror_admission_gate.js');
const { getLogger } = require('../observability/index.js');

// One probe of the height form (above the activation). Records the floor it read on
// `probe` for the timeout diagnostic and returns whether the block is covered.
async function probeAdmissionFloor(indexer, probe){
    // THE HEIGHT FORM. Covered when the persisted floor for (cross_chain_calls,
    // this chain) has reached B - margin. No clock, no escape: the only thing
    // that holds this is a watermark that has not advanced, which is mirror lag.
    let rows = await indexer.hubDb.getHubConfigParam(
        'xchain', String(indexer.config['NETWORK'] || ''), 'admission_watermark',
        'cross_chain_calls.' + probe.chain);
    probe.lastFloor = null;
    if(probe.chain !== '' && rows && rows.length > 0 && rows[0].param_value !== null && rows[0].param_value !== undefined){
        let raw = String(rows[0].param_value).trim();
        if(/^(?:0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw))) probe.lastFloor = Number(raw);
    }
    return probe.lastFloor !== null && probe.lastFloor >= probe.target;
}

// One probe of the clock form (below the activation). Records the mirror watermark and
// hub clock it read on `probe` and returns whether the block is covered.
async function probeClockCoverage(indexer, probe){
    // UNIX_TIMESTAMP() rides along on the SAME query and the SAME connection as the
    // watermark, so the escape below compares two readings taken at one instant from
    // one clock. Reading the hub's clock separately (or substituting this node's)
    // would let skew between them decide a consensus barrier.
    let rows = await indexer.hubDb.getHubCrossChainCallCoverage(probe.chain);
    if(rows.length === 0 || rows[0].ts === null)
        return true;                            // no finalized rows: nothing to wait on
    probe.lastTs = Number(rows[0].ts);
    if(probe.lastTs >= probe.blockTime)
        return true;                            // mirror covers this block
    // Hub-clock escape hatch. Without it this barrier keys liveness
    // on CALL TRAFFIC: the only proceed condition was a finalized row at/after
    // block_time, so the moment XCALL traffic goes idle, chain time walks past
    // the newest finalized effective_time and NOTHING can ever satisfy the
    // barrier again. Every block defers, forever, on a chain that is perfectly
    // healthy. The hub_db_sync path never had this failure mode because
    // callSyncSatisfied also opens on `streamWatermark >= blockTime + grace`.
    //
    // This is that same escape, keyed on the same frozen grace, with the hub's
    // clock standing in for the stream watermark. The two are the same reading:
    // streamWatermark is literally the hub's Math.floor(Date.now()/1000),
    // broadcast on a heartbeat (HubDbBroadcaster.broadcastWatermark); in direct
    // mode there is no stream to carry it, so we ask the hub's database for it.
    //
    // Why it is safe to proceed: the hub stamps a call row's effective_time
    // FORWARD of the instant it writes it (CrossChainCallEngine adds the relay
    // margin), so a row effective at or before block_time was already committed
    // before block_time on the hub's clock. Once that same clock reads a full
    // call grace past block_time, any such row is present in the table we just
    // read, and the set we are about to inject is the canonical one. This is
    // NOT the removed ungraced `Date.now() >= block_time` gate: that one used
    // the NODE's clock, allowed zero margin, and did let a lagging reader
    // proceed with a partial set.
    // NULL/absent must not coerce to 0 (Number(null) === 0 is finite, and a
    // 0 that compared true would open the escape on a hub that answered
    // nothing). Normalize the missing reading to null, which is not finite.
    let hubNow = rows[0].hub_now;
    probe.lastNow = (hubNow === null || hubNow === undefined) ? null : Number(hubNow);
    if(Number.isFinite(probe.lastNow) && probe.lastNow >= probe.blockTime + probe.graceS){
        getLogger().info('Direct call-presence barrier: hub clock ' + probe.lastNow +
            ' is past block_time ' + probe.blockTime + ' + ' + probe.graceS + 's grace ' +
            '(call mirror at ' + probe.lastTs + '); proceeding.');
        return true;
    }
    return false;
}

// Coverage check: proceed the instant the local hub mirror covers block_time, i.e.
// the highest finalized effective_time is at/after it, or there is nothing to wait on.
// A query error means the table is not ready yet, which reads as NOT covered so the
// barrier waits (it never proceeds against an unread table). The probe uses
// doQueryStrict, which is what makes the catch below reachable: doQuery collapses a
// non-transactional query fault into [], and the hub connection never holds a
// transaction, so an empty result would fall straight into `covered = true` and a
// transient hub fault would CLEAR the barrier it exists to hold.
async function probeCallCoverage(indexer, probe){
    try {
        return probe.admission ? await probeAdmissionFloor(indexer, probe)
                               : await probeClockCoverage(indexer, probe);
    } catch(e){
        // Table not ready / transient error: treat as not covered and keep waiting.
        // Surface it once per distinct message so a persistent fault (schema change,
        // permission regression, dead pool) is distinguishable from genuine mirror lag
        // instead of looking identical to it for the whole timeout window.
        if(indexer._callPresenceLastErr !== e.message){
            indexer._callPresenceLastErr = e.message;
            getLogger().error('direct call-presence query error (treating as not covered): ' + e.message);
        }
        return false;
    }
}

module.exports = {

    // Direct-hub-DB call-presence barrier (see the call site in the block loop and the note on
    // callPresenceTimeoutMs). Resolves only when it is safe to read cross_chain_calls for a block
    // at block_time, so the injection/callback pass sees EXACTLY the finalized rows with
    // effective_time <= block_time that canonical hub state holds, never a smaller (partial) set:
    //   * Coverage condition (proceed): the local hub mirror covers this block once
    //     MAX(effective_time) over finalized rows >= block_time. Nothing later than block_time can
    //     change the effective-at/before set, so reading now matches a node that saw every row on
    //     time.
    //   * Empty-table fast path (proceed): no finalized rows means there is nothing to wait on.
    //   * Hub-clock escape hatch (proceed): the hub's OWN clock, read as UNIX_TIMESTAMP() on the
    //     same connection in the same query, has passed block_time + directCallGraceS. See the
    //     long note at the escape in the loop body; this is the ruled fix for the forever-defer
    //     wedge, and is the direct-mode twin of callSyncSatisfied's streamWatermark
    //     escape in hub_db_sync.js.
    //   * Mirror-lags (defer): if the highest finalized effective_time is still BELOW block_time
    //     and the hub clock has not yet cleared the grace, the mirror may genuinely be behind, so
    //     this block's call set could be incomplete. We do NOT proceed with that partial set.
    //     Instead we poll the mirror with a bounded sleep loop (mirroring the indexer's other sync
    //     barriers) and, if neither condition is met within callPresenceTimeoutMs, THROW so the
    //     caller defers the block and retries it from the top of the loop (lastIndexerBlock is not
    //     advanced). This is wait-then-retry, not throw-and-halt: a behind mirror blocks block
    //     PROCESSING (the consensus-correct outcome) until it catches up or the grace clears,
    //     rather than committing a divergent, partial-set block.
    //
    // CRITICAL fast path: the common cases (regtest single shared hub DB already current, or no
    // pending lag) hit the coverage / empty-table condition on the very first query and return
    // with zero added latency. Only a genuinely-lagging distributed mirror enters the poll loop.
    // An UNGRACED wall-clock proceed (Date.now >= block_time) is still deliberately NOT used: it
    // let a lagging node proceed with fewer cross-chain calls than canonical and diverge the
    // actions hash. The escape hatch is not that gate: it is keyed on the HUB's clock, not the
    // node's, and only opens a full call grace past block_time.
    // Two forms, chosen by the mirror-admission consumer activation at `blockHeight`:
    //
    //   BELOW it, today's clock form byte for byte: the local hub mirror covers block_time
    //   (its highest finalized effective_time over calls touching THIS coin is at/after it),
    //   or the hub's own clock has passed block_time + the call grace.
    //
    //   ABOVE it, the family's height form: the hub's persisted cross_chain_calls height
    //   watermark for this chain is at or above B - ADMIT_MARGIN_BLOCKS[cross_chain_calls],
    //   and the hub-clock escape is RETIRED. Nothing in that predicate reads t(B), which is
    //   the point: a block stamped 7200 s ahead is height B like any other, and the only
    //   thing that can hold the barrier is a watermark trailing B - margin, which is genuine
    //   mirror lag.
    //
    // The coverage read is scoped to calls that touch THIS coin (target or source) at every
    // height, matching the mirrored twin (refreshCallSyncTimestamp): a global watermark
    // could be bumped past block_time by an unrelated other-chain call and let this node
    // proceed before every call effective for its coin was present, which is the same fork
    // the mirrored path already closed. It is a wait and hashes nothing, so it is not gated
    // on the activation. A caller with no configured coin falls back to the unscoped
    // superset, which only ever waits longer.
    //
    // The height form's carrier is the floor the hub persists into the shared hub DB:
    // `configs` with coin 'xchain', this network, module 'admission_watermark', param_name
    // 'cross_chain_calls.<CHAIN>' and canonical digits for a value. It is written
    // monotonically and only where it moved, so it sits at or below the hub's live claim and
    // reading it AS the claim is conservative. An absent row, a non-digit value or a query
    // error all read as NOT covered (fail closed), and the value is never coerced from a
    // missing reading: Number(null) is 0, and 0 would certify a genesis-era mirror for every
    // block.
    async waitForDirectCallPresence(blockTime, blockHeight){
        blockTime = Number(blockTime);
        if(!this.hubDb || !Number.isFinite(blockTime)) return;
        let timeoutMs = Number(this.callPresenceTimeoutMs);
        if(!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 10000;
        // The raw-height guard is what keeps the one-argument shape inert without reading
        // this.config (see directCallBarrierClearsAt).
        let admission = blockHeight !== null && blockHeight !== undefined && this.mirrorAdmissionActiveAt(blockHeight);
        let chain = (this.config && this.config['COIN']) ? String(this.config['COIN']).trim().toUpperCase() : '';
        // Grace for the hub-clock escape below. Resolved at startup (start()); the frozen
        // constant is the fallback so a hand-built caller (unit tests) and any future path
        // that skips start() still gets the protocol value rather than NaN, which would make
        // every `hubNow >= blockTime + grace` comparison false and restore the wedge.
        let graceS = Number(this.directCallGraceS);
        if(!Number.isFinite(graceS)) graceS = HUB_SYNC_WATERMARK_GRACE_S.call;
        // What the probes read, plus the last observed mirror watermark, HUB clock and
        // admission floor (height form) they record for the diagnostics below.
        let probe = {
            admission: admission, chain: chain, blockTime: blockTime, graceS: graceS,
            target: admission ? (Number(blockHeight) - admitMarginBlocks('cross_chain_calls')) : null,
            lastTs: null, lastNow: null, lastFloor: null
        };
        // The height tail every log line below carries ABOVE the activation, in the shape
        // hub_db_sync.heightTail gives the mirrored twins; each line's prefix is untouched
        // because a unit test and an operator's grep match on it.
        let heightTail = (floor) => ' (admission height cross_chain_calls.' + (chain === '' ? 'unknown' : chain) +
                                    ' at ' + (floor === null ? 'none' : floor) + ', needs ' + probe.target + ')';
        let deadline = Date.now() + timeoutMs;
        let pollMs = 250;
        while(true){
            // Proceed the instant the hub mirror covers this block (see probeCallCoverage).
            if(await probeCallCoverage(this, probe)) return;
            // Mirror is behind. Defer the block rather than proceed with a partial set: once the
            // bound is exhausted, throw so the caller retries this block from the top of the loop.
            // The message keeps its byte-identical prefix and gains the height form only above
            // the activation, where the clock readings it names are simply never taken.
            if(Date.now() >= deadline)
                this.util.throwError('direct call-presence barrier timed out after ' + timeoutMs +
                    'ms waiting for block_time ' + blockTime + ' (call mirror at ' + probe.lastTs +
                    ', hub clock at ' + probe.lastNow + ', escape at ' + (blockTime + graceS) + ')' +
                    (admission ? heightTail(probe.lastFloor) : '') +
                    (this._callPresenceLastErr ? ' [last query error: ' + this._callPresenceLastErr + ']' : ''));
            getLogger().info('Waiting on hub call mirror: block_time ' + blockTime +
                ' not yet covered (mirror at ' + probe.lastTs + ', hub clock at ' + probe.lastNow +
                ', escape at ' + (blockTime + graceS) + ')' +
                (admission ? heightTail(probe.lastFloor) : '') + '; retrying...');
            await this.util.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        }
    }
};
