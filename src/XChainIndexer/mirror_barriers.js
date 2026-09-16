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
 * XChain Indexer - Mirror barriers
 *
 * The mirror sync barriers after the price pair, in block-loop order (cross-chain match,
 * call, bridge transfer, policy snapshot, direct-hub-DB call presence, anchor-reward
 * attestation, attestation response, capability snapshot), and the two height-aware
 * clear-instant helpers they report through. Each defers the block (stallReason set, no
 * transaction open) rather than process it against a mirror that has not caught up.
 * Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const { getLogger } = require('../observability/index.js');

module.exports = {

    // The barrierClearsAt verdict (XChainIndexer/barrier_clock.js) for a barrier that may have
    // been RE-KEYED onto a height.
    //
    // Above the mirror-admission activation the answer is null, and that null is load-bearing
    // rather than cosmetic. stallClearsAt exists to name the first instant a CLOCK-keyed
    // barrier can open; a height-keyed one has no such instant, because nothing in its
    // predicate moves with wall clock. Reporting `blockTime + grace` anyway would be a lie
    // with consequences: waitingOnFutureBlock() would answer 'future_block_wait' until that
    // instant, nextBarrierHold() would refuse to accumulate a hold, and the 900 s ceiling
    // could never fire on the one barrier whose stall is now genuine mirror lag and IS
    // remediable by a resync. Null is what turns this stall from "healthy, self-clearing" into
    // "measurable, attributable and self-remedying", which is the whole point of the re-keying.
    //
    // Keyed on B, the block being processed, exactly as the predicate is.
    barrierClearsAtHeightAware(blockTime, graceField, blockHeight){
        if(this.mirrorAdmissionActiveAt(blockHeight)) return null;
        return this.barrierClearsAt(blockTime, graceField);
    },

    // The anchor-attest barrier's clear instant, bound-aware.
    //
    // It MUST move with the predicate, and the reason is not cosmetic. The predicate now opens
    // at min(blockTime, horizonBound) + grace; leaving this on blockTime + grace would leave
    // waitingOnFutureBlock() answering 'future_block_wait' for up to two hours after the
    // barrier itself could open, nextBarrierHold() would stay null across that whole window,
    // and the 900 s hold ceiling could never fire on the one barrier the horizon bound was
    // added to un-stall. The grace field is passed by NAME so barrierClearsAt stays the only
    // reader of a grace and the barrier-to-grace wiring scan still sees which one this is.
    anchorBarrierClearsAt(blockTime, horizonBound, blockHeight, graceField){
        // Height-keyed above the activation: no clock instant exists, so null.
        if(this.mirrorAdmissionActiveAt(blockHeight)) return null;
        blockTime = Number(blockTime);
        if(!Number.isFinite(blockTime)) return null;
        let usable = (typeof horizonBound === 'number') && Number.isFinite(horizonBound);
        return this.barrierClearsAt(usable ? Math.min(blockTime, horizonBound) : blockTime, graceField);
    },

    // Cross-chain match sync barrier: wait until the local cross_chain_matches
    // mirror has caught up to this block's time, so every operator of this chain
    // settles the same cross-chain matches at the same block. No-op when sync is
    // disabled or the mirror holds no cross-chain matches.
    async deferOnMatchSync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForMatchSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain match sync): ', err);
                this.stallReason = 'match_sync_barrier';
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'matchWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    },

    // Cross-chain call sync barrier: wait until the local cross_chain_calls
    // mirror has caught up to this block's time, so every operator of this chain
    // injects/delivers the same cross-chain calls at the same block. No-op when
    // sync is disabled or the mirror holds no relay rows.
    async deferOnCallSync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForCallSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain call sync): ', err);
                this.stallReason = 'call_sync_barrier';
                // callWatermarkGraceS, NOT the match grace: callSyncSatisfied waits on
                // the call grace, and the two producers stamp effective_time differently
                // (hub_db_sync.js HUB_SYNC_WATERMARK_GRACE_S.call). Keying the health
                // verdict on the match value would mis-time the wedge discriminator the
                // moment the two constants diverge or a regtest override moves one.
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'callWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    },

    // Bridge transfer sync barrier: wait until the local bridge_transfers mirror
    // has caught up to this block's time, so every operator of this chain mints
    // the same bridged credits at the same block. A transfer's apply assigns an
    // action index, so a node that applied a smaller set at this height would
    // commit different actions_hash and ledger_hash for a block its peers agree
    // on. No-op when sync is disabled or the mirror holds no transfers.
    async deferOnBridgeSync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForBridgeSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (bridge transfer sync): ', err);
                this.stallReason = 'bridge_sync_barrier';
                // bridgeWatermarkGraceS, never the match or call grace: the bridge
                // engine is a third producer with its own effective_time stamping rule,
                // and sharing another table's grace couples two producers' timing, the
                // documented mistake the call barrier was split out to end.
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'bridgeWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    },

    // Policy snapshot sync barrier: its own barrier and not a reuse of the bridge
    // one, because policy_snapshots is keyed on origin_chain alone (a snapshot
    // names no destination, so there is no (src, dest) pair to scope by) and
    // carries its own watermark grace. The snapshots materialize membership that
    // GATES the credits the bridge pass then applies, so a stale policy mirror
    // would let one node admit a transfer another node's membership refuses.
    async deferOnPolicySync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForPolicySync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (policy snapshot sync): ', err);
                this.stallReason = 'policy_sync_barrier';
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'policyWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    },

    // Direct-hub-DB call-presence barrier: the sync barriers above only run with a
    // HubDbSync mirror. In single-host / direct-hub-DB mode (hubDb set, no sync) the
    // indexer reads the hub's MariaDB directly, but "the hub DB is current" does NOT
    // mean a relay row was PRESENT when this block was processed. The hub finalizes a
    // cross_chain_calls row at wall-clock ~= its effective_time minus the relay margin;
    // a node whose tip already sits at that block can pass it before the write lands,
    // injecting the execution/callback a block late, landing the synthetic action in a
    // different block than a node that saw the row on time (a real content divergence /
    // ledger fork). The request_id/call_id preimages no longer bind action_index (see
    // attest.js/xcall.js EMITTER_PATH), but the block an injection lands in still must
    // agree. Block until the local hub mirror covers block_time (its highest finalized
    // effective_time >= block_time) before processCrossChainCalls reads the table; a
    // lagging mirror defers-and-retries (the barrier throws on timeout) so this node
    // never injects a partial call set, while the already-current single-shared-DB
    // (regtest) case clears on the first query with no added latency. Above the
    // mirror-admission activation the same wait is keyed on the hub's persisted
    // height watermark for this chain instead, so blockToParse rides along.
    async deferOnDirectCallPresence(blockToParse, blockTime){
        if(!this.hubDbSync && this.hubDb){
            try {
                await this.waitForDirectCallPresence(blockTime, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (direct call-presence barrier): ', err);
                this.stallReason = 'call_presence_barrier';
                // The barrier now HAS a time-keyed escape (hub clock >= block_time +
                // call grace), so this stall does have a first-clearable instant and
                // /status can say so instead of reporting an open-ended stall on a
                // future-stamped block. Keyed on this node's wall clock while the
                // barrier itself reads the hub's: the two are the same host in the
                // single-host topology this barrier serves, and this value gates no
                // wait, no read and no write (health verdict only, see barrierClearsAt).
                // Null above the admission activation, where no clock instant opens it.
                this.stallClearsAt = this.directCallBarrierClearsAt(blockTime, blockToParse);
                return true;
            }
        }
        return false;
    },

    // Anchor-reward attestation mirror-completeness barrier. The BTC-side derive
    // pass (./block_passes.js) mints COLLECT-spendable rewards at a height fixed fleet-wide
    // (snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY), so a node that has not
    // received a matured attestation by that height must NOT commit the block with a
    // smaller reward set: it would fork the ledger hash for a block its peers agree
    // on. Defer instead, exactly like the barriers above. BTC-only (nothing derives
    // elsewhere) and inert until the operator arms the derive flag-day, but the wait
    // itself is cheap and unconditional on BTC so a node cannot advance into an armed
    // boundary with a stale mirror.
    async deferOnAnchorAttestSync(blockToParse, blockTime, anchorHorizonBound){
        if(this.hubDbSync && this.config['COIN'] === 'BTC'){
            try {
                await this.hubDbSync.waitForAnchorAttestationSync(blockTime, this.priceSyncTimeoutMs, anchorHorizonBound, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (anchor-reward attestation mirror): ', err);
                this.stallReason = 'anchor_attest_barrier';
                this.stallClearsAt = this.anchorBarrierClearsAt(
                    blockTime, anchorHorizonBound, blockToParse, 'anchorAttestWatermarkGraceS');
                return true;
            }
        }
        return false;
    },

    // Finalized ATTEST response mirror barrier. A mirrored attestation_responses
    // row binds at the first block whose protocol time reaches its signed
    // effective_time, and that block fires the contract callback, mints the
    // synthetic v1 action and settles the request fee. A node that has not
    // received the row by then does not lag, it forks: it commits that block with
    // the callback un-fired while its peers commit it fired, and nothing later
    // re-binds. So it defers, with no chain-only escape (see hub_db_sync.js).
    // Armed on EVERY BTC block with no transaction predicate: the binding
    // condition is a time, so a row can bind at a block carrying no ATTEST
    // transaction at all, and there is nothing to scope the wait to. BTC-only,
    // because all attestation stake and every request lives on BTC.
    async deferOnAttestResponseSync(blockToParse, blockTime){
        if(this.hubDbSync && this.config['COIN'] === 'BTC'){
            try {
                await this.hubDbSync.waitForAttestationResponseSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (attestation response mirror): ', err);
                this.stallReason = 'attest_response_sync_barrier';
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'attestResponseWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    },

    // Cross-chain capability-snapshot barrier: wait until the capability snapshot
    // for every effective cross-chain match AND call relay row has mirrored in, so
    // neither is ever skipped (and applied later at a per-operator-variable height)
    // for a missing snapshot. Defers the block on timeout, same as the barriers above.
    async deferOnSnapshotSync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForSnapshotSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain snapshot sync): ', err);
                this.stallReason = 'snapshot_sync_barrier';
                this.stallClearsAt = null;          // snapshot presence, not wall clock
                return true;
            }
        }
        return false;
    }
};
