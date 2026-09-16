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
 * XChain Indexer - Hub DB Sync Client: watermark and stall configuration
 *
 * The frozen watermark grace margins, the barrier hold ceiling, the stall
 * detector windows and their resolvers, the stall verdict, and the two pure
 * height-watermark helpers. Everything here is a constant or a pure function.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const { readEnvNow } = require('./env.js');

// ── Watermark grace margins: frozen protocol constants every node must share ──
// The four barrier grace margins (seconds) are NOT operational timeouts: they
// decide WHEN the block-loop consensus barriers open via the stream-watermark
// escape (priceSyncSatisfied / oracleSyncSatisfied / matchSyncSatisfied /
// callSyncSatisfied).
// A per-node divergence forks settlement: operator A with grace 60 settles a
// block without a retroactive-effective-time row that lands inside the window
// while operator B with grace 600 waits and settles it differently. An
// unparseable value yields NaN, making every `blockTime + NaN` comparison false
// and permanently wedging the tip. So every node MUST use identical values.
//
// These are NODE-LOCAL TIMING BARRIERS (a wait decision), never persisted or
// hashed state, so pinning them needs NO activation gate: a reindex replays with
// the mirror already far ahead of the tip, so the barrier opens immediately
// regardless of grace, and the value never enters any ledger row. There is no
// historical byte-shape that a height gate would have to preserve.
const HUB_SYNC_WATERMARK_GRACE_S = Object.freeze({
    // Covers the PRICE hourly batch window (3600s), the post-window
    // signing-round grace (300s, ORACLE_BATCH_GRACE_MS), and ~900s of
    // headroom for DOGE confirmation and indexing before the batch lands
    // locally: 3600 + 300 + 900 = 4800. The prior value (600) was calibrated
    // to the 10-minute round cadence batching replaces; left at 600 it opens
    // this barrier's escape hatch ~55 minutes before a batch window can have
    // finished, letting a chain-only node process blocks against a mirror
    // that is still missing the current window. Raising it means an isolated
    // chain-only node can now trail the tip by up to ~75 minutes at this
    // barrier instead of ~10 (it only ever LAGS, never diverges: both sides
    // of the fee-staleness comparison are chain-derived, so a node that waits
    // computes the same verdict as one that was live). Hub-connected nodes,
    // which is every validator and the documented non-validator topology,
    // never hit this escape hatch and are unaffected. Moves fleet-wide in
    // lockstep with batching like every other value in this
    // object, and needs no activation gate of its own by the reasoning below:
    // node-local, never persisted or hashed, and a reindex replays with the
    // mirror already far ahead of the tip so the barrier opens immediately
    // regardless of grace.
    price:  4800,
    oracle: 600,
    match:  120,
    // Calls carry their OWN margin, currently equal to match's, because the two
    // producers stamp effective_time differently: CrossChainDexEngine stamps the
    // finalization instant (_nowSeconds()) while CrossChainCallEngine stamps
    // now + a forward relay margin. Sharing match's value silently coupled a call
    // barrier to a match producer's timing. Changing this NUMBER is a protocol
    // change: every node must move in lockstep, reconciled against the hub's
    // call-stamping path first.
    call:   120,
    // Anchor-reward attestations. Unlike the four above, this barrier does not gate on a
    // row-content watermark at all (the rows carry no effective_time, and their arrival is
    // governed by DOGE confirmation and hub failover, not by any clock the block loop can
    // read). It gates purely on "the mirror has received everything the hub produced up to
    // this block's time", which is what makes the fleet-agreed maturity watermark in
    // anchor_reward_activation.js safe: a node that cannot certify that much DEFERS instead
    // of deriving a partial reward set. The value only has to cover ordinary stream lag,
    // because the maturity constant already absorbs the ~24h of DOGE burial, failover and
    // federation delay. Changing this NUMBER is a protocol change (it moves which nodes can
    // advance past a maturity boundary), so it moves fleet-wide or not at all.
    anchorAttest: 120,
    // Finalized ATTEST responses (attestation_responses), the mirror that replaced the
    // validator-paid on-chain response transaction. Like anchorAttest above, this value only
    // has to cover ordinary stream lag, because the real forward margin is carried by the
    // row itself: effective_time is chosen by the round leader as now + ATTEST_RESPONSE_FORWARD_S,
    // bounded by every follower before it signs, and INSIDE the signed canonical, so the
    // applying block is a function of signed data rather than of any node's clock or of this
    // number. What this grace buys is the difference between "the mirror holds no row for this
    // block" and "the mirror has not been told yet": below it the block loop defers instead of
    // settling a block that a row already bound. Changing this NUMBER is a protocol change (it
    // moves which nodes may advance past a block a response binds at), so it moves fleet-wide
    // or not at all.
    attestResponse: 120,
    // Finalized XBRIDGE transfers (bridge_transfers). Its own entry rather than a share of
    // match's, for the reason the call entry above records: sharing a grace couples this
    // barrier to another producer's stamping rule, and the bridge engine does not stamp
    // like the DEX engine. A bridge row's effective_time is now + relayMarginFloorS(dest_chain)
    // (240 to 2400 s ahead of finalization, with the follower refusing to co-sign outside
    // 60 to 3600 s), so the row is broadcast well BEFORE the time it applies at and this
    // value only has to cover ordinary stream lag, exactly like the call barrier. Changing
    // this NUMBER is a protocol change (it moves which nodes may advance past a block a
    // transfer binds at), so it moves fleet-wide or not at all.
    bridge: 120,
    // Finalized XPOLICY snapshots (policy_snapshots). Own entry for the same reason again,
    // and the producer differs a third way: a policy row's effective_time is the MAX relay
    // floor over every chain holding a copy of the tick, so it runs further ahead than a
    // bridge row and is NOT monotonic across policy_seq (apply order is by seq, never by
    // time). Neither property is something this grace should absorb: the grace covers only
    // "the mirror has not been told yet", and the ordering rule lives in the apply pass.
    policy: 120,
});

// Resolve one grace margin. `frozen` is the pinned protocol constant; `envKey`
// the operator override honored ONLY on regtest (test tunability). Off-regtest a
// differing override is IGNORED with a loud startup warning and the frozen value
// wins, mirroring resolveFeeDestination (src/coins/index.js). On regtest a SET
// override that is not a non-negative integer THROWS an actionable startup error
// (NaN / negative / fractional / non-numeric) rather than being swallowed and
// stamped as a silent value that later wedges every barrier with `+ NaN`.
function resolveWatermarkGrace(frozen, envKey, network){
    const override = readEnvNow(envKey);
    if(override === undefined || override === '') return frozen;
    if(network !== 'regtest'){
        if(String(override) !== String(frozen))
            getLogger().info('WARNING: ' + envKey + ' is set but IGNORED on ' + String(network) +
                '; using the frozen protocol grace constant ' + frozen + 's. Watermark graces are ' +
                'consensus inputs (a per-node value forks settlement) and are not operator-tunable off regtest.');
        return frozen;
    }
    if(!/^\d+$/.test(String(override).trim()))
        throw new Error('Invalid ' + envKey + '="' + override + '": watermark grace must be a ' +
            'non-negative integer number of seconds (frozen protocol default ' + frozen + ').');
    return parseInt(String(override).trim(), 10);
}

// ── Mirror-barrier hold ceiling: the NAMED bound on a barrier wait ──
//
// The graces above decide WHEN a barrier opens. Nothing above decides how long a
// barrier may hold ONE block before the mirror itself is treated as the fault, and
// that omission is what let testnet throughput sit below chain pace with every log
// line reading healthy: each defer is bounded by HUB_PRICE_SYNC_TIMEOUT_MS, the block
// loop retries, and the retry re-arms an identical wait. Per-attempt bounds compose
// into an unbounded total, so the wait had no ceiling at all, only a cadence.
//
// This is that ceiling: the longest one block may sit behind the hub-mirror barriers
// before the node stops calling it an ordinary defer, says so under a distinct name,
// and forces the mirror to reconnect and re-bootstrap (HubDbSync.requestResync). The
// remedy is aimed at the actual failure mode: every one of these barriers is satisfied
// by the stream watermark, the watermark only advances while _bootstrapDrained is set,
// and that flag is cleared by any disconnect until a re-bootstrap drains. A mirror
// whose drain never completes therefore freezes every barrier indefinitely while its
// socket looks alive, and only a fresh subscribe-then-bootstrap cycle clears it.
//
// OPERATIONAL, NOT CONSENSUS, and it is the difference that makes this safe. It never
// opens a barrier, never shortens a grace and never lets a block commit one second
// earlier: a node past the ceiling is still deferring, fail-closed, exactly as before.
// It changes only what the node LOGS, what /health reports, and whether it re-drives
// its own mirror. So unlike the graces, a per-node value cannot fork settlement, and
// the env override below is honored on every network rather than regtest alone.
//
// Sized well above one barrier-timeout cycle (60s default) and above the 5s reconnect
// plus a full bootstrap drain, so an ordinary slow drain finishes on its own and only
// a mirror that is genuinely not converging reaches the ceiling.
const HUB_SYNC_BARRIER_HOLD_CEILING_S = 900;

// Resolve the hold ceiling in MILLISECONDS. Operational, so an override is honored on
// every network; an unusable value (non-numeric, negative, fractional) falls back to
// the named default with a warning rather than throwing, because a bad value here can
// only mis-time a log line and must never keep an indexer from booting. 0 disables the
// ceiling (no forced resync, no named crossing), which is the documented off switch.
function resolveBarrierHoldCeilingMs(raw){
    const override = (raw === undefined) ? readEnvNow('HUB_SYNC_BARRIER_HOLD_CEILING_S') : raw;
    if(override === undefined || override === null || override === '')
        return HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000;
    if(!/^\d+$/.test(String(override).trim())){
        getLogger().info('WARNING: HUB_SYNC_BARRIER_HOLD_CEILING_S="' + override + '" is not a non-negative ' +
            'integer number of seconds; using the default ceiling ' + HUB_SYNC_BARRIER_HOLD_CEILING_S + 's.');
        return HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000;
    }
    return parseInt(String(override).trim(), 10) * 1000;
}

// ── Stream-watermark stall: the bound on a mirror that certifies NOTHING ──
//
// The ceiling above is driven by the BLOCK LOOP: it fires only while one block sits
// behind a mirror barrier, and only after its own long window. A watermark that
// freezes for a few minutes and then recovers therefore never reaches it, so the only
// thing that ended such a freeze was an operator restarting the container.
//
// This is the second bound, owned by the mirror itself and keyed on the mirror's own
// evidence rather than on a block. Every heartbeat carries the timestamp through which
// the hub has produced rows. When that hub tip runs AHEAD of our certified stream
// watermark and our watermark does not move for a whole detection window, the mirror
// is certifying nothing while its socket reads perfectly healthy. That single
// condition holds no matter WHICH gate is stuck (a bootstrap that never drains, a
// message chain parked on an apply that never settles, a per-table cursor wedged on a
// row the apply path refuses), which is what lets the remedy be cause-agnostic.
//
// Two stages, because a re-subscribe clears most of those and a restart clears the rest:
//   1. force a fresh subscribe-then-bootstrap, the ONE path that re-arms the gate,
//   2. if the watermark still has not moved a bounded window later, hand the process to
//      its supervisor under a named fatal.
//
// OPERATIONAL, NOT CONSENSUS, for the same reason as the ceiling: neither stage opens a
// barrier, shortens a grace or commits a block one second earlier. A node that restarts
// here comes back deferring exactly as it was, so a per-node value cannot fork
// settlement and the env overrides are honored on every network.
//
// Sized above a full re-bootstrap drain (minutes on a large price_snapshots table) so an
// ordinary slow drain finishes on its own and only a mirror that is genuinely not
// converging ever reaches stage 2.
const HUB_SYNC_WATERMARK_STALL_S      = 180;
const HUB_SYNC_WATERMARK_STALL_EXIT_S = 300;

// How often the stall condition is sampled. Small relative to the windows it measures
// so a stall is caught within a sample of its deadline rather than a whole window late.
const WATERMARK_STALL_CHECK_MS = 10000;

// Resolve one stall window in MILLISECONDS. Same contract as resolveBarrierHoldCeilingMs:
// an unusable value falls back to the named default with a warning rather than throwing,
// because a bad value here can only mis-time a log line and must never keep an indexer
// from booting. 0 is the documented off switch (no detection at all, or detection
// without the fatal stage).
function resolveWatermarkStallMs(raw, envKey, defaultS){
    const override = (raw === undefined) ? readEnvNow(envKey) : raw;
    if(override === undefined || override === null || override === '')
        return defaultS * 1000;
    if(!/^\d+$/.test(String(override).trim())){
        getLogger().info('WARNING: ' + envKey + '="' + override + '" is not a non-negative integer ' +
            'number of seconds; using the default ' + defaultS + 's.');
        return defaultS * 1000;
    }
    return parseInt(String(override).trim(), 10) * 1000;
}

// Decide what a frozen stream watermark has earned, as a pure function of the mirror's
// observable state, so the decision is testable without a socket, a DB or a real clock.
// Returns 'ok', 'resync' (stage 1) or 'exit' (stage 2).
//
// Each suppression below is a state where a frozen watermark is CORRECT and neither
// remedy could help:
//   - poll mode freezes the watermark by design (bootstrapAll refuses to certify a
//     mirror that cannot receive upserts or retractions),
//   - a schema mismatch is a deliberate permanent fail-closed hold that only a hub
//     upgrade clears, so restarting into it would buy a restart loop and nothing else,
//   - a mirror that has never certified a watermark is a cold start, not a stall; its
//     bound is the block loop's hold ceiling,
//   - a hub tip at or behind our watermark means the hub has produced nothing we lack,
//     which is the ordinary quiet-chain state and the reason a bare "unchanged for X"
//     test cannot be used on its own.
//
// THE HEIGHT DIMENSION. Everything above measures the SECONDS watermark, and above the
// mirror-admission activation that is no longer the value the barriers open on: they open
// on the per-table height watermark. A hub whose `heights` map froze while its `ts` kept
// ticking therefore reads 'ok' here forever, with only the block loop's 900 s hold ceiling
// left as a remedy, and that ceiling is delivery-side and cannot clear a producer-side
// freeze. So the height watermark is a SECOND stall dimension on the same two-stage ladder.
//
// It is measured against what the block loop actually asked for, not against a hub-reported
// admission tip: the hub publishes `heights` but publishes no tip of its own on any of the
// three carriers, so the comparator C20 names does not exist on the wire. `heightsShort` is
// therefore set by the barrier itself, when a height comparison it evaluated came up short,
// and cleared when the entry catches up. That is strictly the case the operator cares about
// (this node is being held by a height watermark that is not moving) and it needs nothing
// the hub does not already send.
//
// Either dimension can raise the alarm, each measured from ITS OWN last advance, and stage 1
// fires on whichever crosses the window first. With the height dimension idle this is byte
// for byte today's rule.
function watermarkStallVerdict(state, now){
    const s = state || {};
    if(!(s.stallMs > 0))                                   return 'ok';
    if(s.pollMode || s.schemaMismatch)                     return 'ok';

    const tsFrozen = (s.lastAdvanceAt != null) &&
                     (Number(s.hubTipTs) > Number(s.streamWatermark));
    // A mirror that has never received a heights map is a cold start on this axis too, not
    // a stall, exactly as a null lastAdvanceAt is on the seconds axis.
    const heightFrozen = (s.heightsLastAdvanceAt != null) && !!s.heightsShort;
    if(!tsFrozen && !heightFrozen)                         return 'ok';

    // Stage 1 measures from the last real advance; stage 2 measures from the remedy, so
    // a resync that is still draining is given its own full window rather than being
    // charged the time that produced it.
    if(s.resyncAt == null){
        const stamps = [];
        if(tsFrozen)     stamps.push(s.lastAdvanceAt);
        if(heightFrozen) stamps.push(s.heightsLastAdvanceAt);
        const since = Math.min.apply(null, stamps);
        return ((now - since) >= s.stallMs) ? 'resync' : 'ok';
    }
    if(!(s.exitMs > 0))                                    return 'ok';
    return ((now - s.resyncAt) >= s.exitMs) ? 'exit' : 'ok';
}

// Normalise a wire `heights` object into the shape the barriers read, dropping anything that
// is not a usable height. Returns null when the carrier stamped no object at all, which the
// caller treats as "clear", and an object (possibly empty) otherwise.
//
// STRICTLY typed, and that is deliberate. `Number('')`, `Number(null)`, `Number([])` and
// `Number(false)` are all 0, so a coercing reader would turn every one of those into a
// genesis-height claim that satisfies no block but LOOKS like an entry, and `Number('12')`
// would let the wire decide a consensus barrier's evidence in a type the hub never sends.
// A height is a non-negative safe integer NUMBER; everything else is absence.
function sanitizeHeights(raw){
    if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for(const table of Object.keys(raw)){
        const entry = raw[table];
        if(!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const chains = {};
        for(const chain of Object.keys(entry)){
            const h = entry[chain];
            if(typeof h !== 'number' || !Number.isSafeInteger(h) || h < 0) continue;
            const c = String(chain).trim().toUpperCase();
            if(c !== '') chains[c] = h;
        }
        // A table whose every entry was refused is kept as an EMPTY object rather than
        // dropped: both defer, and keeping it says "the hub published this table and none of
        // it was usable" instead of "the hub never mentioned it".
        out[String(table)] = chains;
    }
    return out;
}

// True when any (table, chain) entry in `next` is strictly higher than in `prev`. A map that
// only loses entries, or only republishes the same numbers, has not advanced: the stall
// detector's window must keep running through a hub that is repeating itself.
function heightsAdvanced(prev, next){
    const before = prev || {};
    for(const table of Object.keys(next || {})){
        const nextChains = next[table] || {};
        const prevChains = before[table] || {};
        for(const chain of Object.keys(nextChains)){
            const was = prevChains[chain];
            if(typeof was !== 'number' || nextChains[chain] > was) return true;
        }
    }
    return false;
}

// ── signed-retraction verification helpers ───────────────────────────

// Rebuild the retraction canonical from the wire event. MUST byte-match the
// producer in xchain-hub/src/consensus/retraction.js canonicalRetraction():
//   XRETRACTV1|<table>|<source_chain>|<from>|<to or ''>|<generation or ''>|<snapshot_block>

module.exports = {
    HUB_SYNC_WATERMARK_GRACE_S, resolveWatermarkGrace,
    HUB_SYNC_BARRIER_HOLD_CEILING_S, resolveBarrierHoldCeilingMs,
    HUB_SYNC_WATERMARK_STALL_S, HUB_SYNC_WATERMARK_STALL_EXIT_S, WATERMARK_STALL_CHECK_MS,
    resolveWatermarkStallMs, watermarkStallVerdict,
    sanitizeHeights, heightsAdvanced,
};
