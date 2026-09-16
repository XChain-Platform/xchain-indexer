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
 * XChain Indexer - Barrier clock and hold
 *
 * The health-side arithmetic around the block loop's sync barriers: the instant a
 * time-keyed barrier can first clear, the price-barrier skip decision, and the
 * mirror-barrier hold fold with its ceiling remedy. The height-aware and
 * bound-aware clearsAt wrappers stay in ../XChainIndexer.js beside the activation
 * reads they key on. Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const { HUB_SYNC_WATERMARK_GRACE_S, HUB_SYNC_BARRIER_HOLD_CEILING_S } = require('../hub/hub_db_sync.js');
const { blockMayReadPrice } = require('../chain/price_read_predicate.js');
const { nextBarrierHold, isMirrorBarrierReason, barrierHoldMs,
        barrierCeilingExceeded } = require('./stall_health.js');
const { getLogger } = require('../observability/index.js');

module.exports = {

    // The wall-clock instant at which a time-keyed hub-sync barrier can FIRST be
    // satisfied for a block, or null when that cannot be determined. Every such barrier has
    // the same escape hatch (`streamWatermark >= blockTime + grace`), and the watermark only
    // advances as real time does, so a block stamped in the FUTURE cannot clear before
    // blockTime + grace no matter how healthy the mirror is. Their other satisfaction case
    // (the mirror already holds a row at/past blockTime) cannot fire early either, because
    // rows effective at a future instant do not exist yet. Returns null when sync is off or
    // the inputs are not finite, which leaves the caller's verdict exactly as it was before.
    //
    // Used ONLY for the /status health verdict. It gates no wait, no read and no write.
    barrierClearsAt(blockTime, graceField){
        blockTime = Number(blockTime);
        if(!this.hubDbSync || !Number.isFinite(blockTime)) return null;
        let graceS = Number(this.hubDbSync[graceField]);
        if(!Number.isFinite(graceS)) graceS = 0;
        return (blockTime + graceS) * 1000;
    },

    // Wall-clock instant (epoch ms) the DIRECT call-presence barrier's hub-clock escape can
    // FIRST open for a block, or null when that cannot be determined. The mirrored twin of
    // barrierClearsAt, which cannot serve this path because it returns null without a
    // HubDbSync. Health verdict only: it gates no wait, no read and no write.
    //
    // Null above the mirror-admission activation at `blockHeight`: the barrier is then
    // height-keyed and no clock instant opens it, so a hold accumulates and the 900 s ceiling
    // can fire exactly as it does for the mirrored twins. A caller that passes no height gets
    // today's clock verdict, which keeps the existing one-argument shape meaningful.
    directCallBarrierClearsAt(blockTime, blockHeight){
        // Guarded on the RAW height before mirrorAdmissionActiveAt is reached, so the
        // pre-train one-argument shape (and a hand-built harness with no config) reads inert
        // without touching this.config. Number(null) is 0, and 0 is above an activation armed
        // at height 0, which is why the guard is on the raw value and never a coerced one.
        if(blockHeight !== null && blockHeight !== undefined && this.mirrorAdmissionActiveAt(blockHeight)) return null;
        blockTime = Number(blockTime);
        if(!this.hubDb || !Number.isFinite(blockTime)) return null;
        let graceS = Number(this.directCallGraceS);
        if(!Number.isFinite(graceS)) graceS = HUB_SYNC_WATERMARK_GRACE_S.call;
        return (blockTime + graceS) * 1000;
    },

    // Decide whether this block takes the price/oracle mirror barriers, and record
    // that decision for db.assertPriceBarrierNotSkipped(). Returns true to wait.
    //
    // Three ways to end up waiting, and the last two are the safety rails:
    //   - blockMayReadPrice says the block carries transactions, so a reader is possible.
    //   - this block already tripped the fail-closed assertion on a previous attempt, so
    //     priceBarrierForceBlock pins it; skipping again would loop forever.
    //   - malformed input, which priceReadPredicate resolves to "wait" by contract.
    //
    // priceBarrierSkipped is deliberately AND-ed with hubDbSync. On a single-host stack
    // there is no mirror and the barriers never ran in the first place, so flagging a skip
    // there would arm the choke-point assertion against reads that were always legitimate
    // and wedge the node on its first priced block.
    evaluatePriceBarrier(blockToParse, blockTransactions){
        let mayReadPrice = blockMayReadPrice(blockTransactions)
                           || this.priceBarrierForceBlock === blockToParse;
        this.priceBarrierBlock   = blockToParse;
        this.priceBarrierSkipped = !!this.hubDbSync && !mayReadPrice;
        return mayReadPrice;
    },

    // End the process under a named reason, for a fault that no amount of further running
    // can clear. Matches what api.js does with a fatal indexer error, and is a method
    // rather than an inline process.exit so a test can observe the decision without
    // taking the runner down with it.
    fatalExit(reason){
        getLogger().error('Fatal indexer error: ' + reason);
        process.exit(1);
    },

    // Fold one poll-loop pass into the mirror-barrier hold, and act when it crosses the
    // named ceiling. Called once per pass, right after the catch-up loop exits,
    // where `this.stallReason` and `this.stallClearsAt` already carry whatever the defer
    // sites set. Reading them here rather than instrumenting each of the nine defer sites
    // keeps one rule in one place, and a barrier added later is covered for free.
    //
    // What crossing the ceiling does, and what it deliberately does NOT do. It logs under
    // a distinct name, counts the crossing for /health, and asks the mirror to reconnect
    // and re-bootstrap. It does not open the barrier, shorten a grace, skip a block or
    // change a single hashed value: the block keeps deferring, fail-closed, until its
    // barrier is genuinely satisfied. So the ceiling can never fork settlement, and a node
    // whose mirror really is missing rows is no more permissive after it fires than before.
    //
    // Returns the hold in ms (0 when nothing is held), for the caller and for tests.
    noteBarrierHold(blockToParse, now = Date.now()){
        let prev = this.barrierHold;
        this.barrierHold = nextBarrierHold(prev, blockToParse, this.stallReason, this.stallClearsAt, now);
        let hold = this.barrierHold;
        if(!hold) return 0;
        if(!barrierCeilingExceeded(hold, this.barrierHoldCeilingMs, now)) return barrierHoldMs(hold, now);

        // The remedy fits the MIRROR barriers only. A host fault (vm_executor_unavailable,
        // anchor_reward_proof_unavailable) is held by something a hub resubscribe cannot
        // touch, and re-driving the mirror for it would be a misleading log line attached to
        // a pointless reconnect. The hold and its ceiling still apply to those: naming how
        // long a block has been stuck is worth having whatever is holding it.
        let mirrorBarrier = isMirrorBarrierReason(hold.reason);

        // Announce the crossing ONCE per held block, then keep re-driving the mirror on the
        // ceiling cadence: requestResync() throttles itself on the same value, so calling it
        // every pass costs nothing and a mirror that recovers and re-stalls is re-driven again.
        if(!hold.notified){
            hold.notified = true;
            this.barrierCeilingHits++;
            getLogger().error('Mirror-barrier hold ceiling reached: block ' + blockToParse + ' has been held at ' +
                hold.reason + ' for ' + Math.round(barrierHoldMs(hold, now) / 1000) + 's, past the ' +
                Math.round(this.barrierHoldCeilingMs / 1000) + 's ceiling (HUB_SYNC_BARRIER_HOLD_CEILING_S, default ' +
                HUB_SYNC_BARRIER_HOLD_CEILING_S + 's). The block is still deferring, which is correct. ' +
                (mirrorBarrier
                    ? 'Forcing a hub-mirror resync: a stream watermark that stops advancing holds every ' +
                      'one of these barriers open-endedly, and only a fresh subscribe-then-bootstrap re-arms it.'
                    : 'Not a hub-mirror barrier, so no resync is forced; this is a host fault to investigate.'));
        }
        if(mirrorBarrier && this.hubDbSync && typeof this.hubDbSync.requestResync === 'function')
            this.hubDbSync.requestResync('block ' + blockToParse + ' held at ' + hold.reason +
                                         ' past the ' + Math.round(this.barrierHoldCeilingMs / 1000) + 's ceiling');
        return barrierHoldMs(hold, now);
    }
};
