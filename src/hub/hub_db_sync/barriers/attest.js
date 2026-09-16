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
 * XChain Indexer - Hub DB Sync Client: attestation barriers
 *
 * The two stream-watermark completeness barriers: anchor-reward attestations and
 * finalized ATTEST responses.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/


module.exports = {

    // ── Anchor-reward attestation mirror-completeness barrier ──────────────────
    //
    // The BTC indexer mints a COLLECT-spendable reward from mirrored
    // anchor_reward_attestations rows, and the block a given reward materializes at is
    // fixed fleet-wide (snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY). That fixed height
    // is only safe if a node which has NOT received the row by then declines to advance
    // rather than deriving a smaller set: otherwise the lagging node commits a block whose
    // ledger hash differs from its peers' for the same BTC block, which is exactly the
    // divergence the maturity re-keying exists to remove.
    //
    // TWO INDEPENDENT COMPLETENESS CERTIFICATES, and this member is the only one that carries
    // both. It is the only member whose rows already bind by HEIGHT rather than by a signed
    // time (the derive pass reads exactly `snapshot_block <= B - ANCHOR_REWARD_MIRROR_MATURITY`),
    // and it is also the one member where the family's height rule is measurably WORSE than
    // the clock it replaces, because the hub cannot advance that rail's height watermark past
    // a snapshot whose deferred reward-attest entry is still queued and that queue's TTL is
    // 6 h against today's 7320 s. So both are kept and EITHER satisfies:
    //
    //   THE HORIZON BOUND. The derive pass at B reads only rows whose snapshot_block is 144
    //   blocks back, and the hub wrote every one of those no later than
    //   time(snapshot_block) + its whole measured write-lag envelope. So a watermark past
    //   horizonTime + ANCHOR_ATTEST_ARRIVAL_MARGIN_S certifies the same completeness the
    //   block's own stamp does, and does it from a stamp roughly a day old that no miner of
    //   THIS block chose. The min() is what makes this safe to reason about: the target can
    //   only ever be EARLIER than blockTime, so every case that passes today keeps passing
    //   and nothing that defers today starts committing.
    //
    //   THE HEIGHT WATERMARK. Above the mirror-admission activation, an
    //   anchor_reward_attestations entry at or past B - 144 says every round that could stamp
    //   a row admissible at B has terminated, which is the same claim with no clock in it.
    //
    // Keeping both is R3 (b), and the OR is what preserves the horizon form's strict-relaxation
    // property: a height watermark held by one stuck DOGE anchor cannot make this barrier hold
    // a block the clock form would have released.
    //
    // No row-content watermark is possible here. These rows carry no effective_time, and
    // their arrival is governed by DOGE confirmation depth and hub failover, neither of
    // which is comparable to a BTC block height or time. So the clock half gates on the STREAM
    // watermark alone: "the hub has told me I hold everything it produced up to this
    // block's time (or up to the maturity horizon, whichever is earlier)."
    //
    // Disabled sync is satisfied by definition: with no mirror the indexer reads the hub's
    // MariaDB directly, so there is no delivery lag to wait out. Poll mode is NOT satisfied
    // and never will be, because the stream watermark deliberately freezes there (a REST
    // poll cannot observe an in-place upsert), and the barrier's timeout then defers the
    // block, which is the correct fail-closed outcome for a node that cannot certify
    // completeness at all.
    // `horizonBound` is time(B - 144) + ANCHOR_ATTEST_ARRIVAL_MARGIN_S, computed by the caller
    // and passed as a NUMBER so this module gains no dependency on the activation module or
    // the margin constant. A null or non-finite bound is the LEGACY form, fail-closed, and it
    // has to be: `Number(false)` is 0, and the decoder returns literal `false` for a block it
    // cannot serve, so a coercing guard would silently open this barrier at
    // `watermark >= margin + grace` on every decoder gap above height 144.
    anchorAttestSyncSatisfied(blockTime, horizonBound = null, blockHeight = null) {
        if (!this.enabled) return true;
        blockTime = Number(blockTime);
        if (!Number.isFinite(blockTime)) return true;
        if (this.admissionActiveAt(blockHeight) &&
            this.heightSatisfied('anchor_reward_attestations', blockHeight)) return true;
        // typeof, not Number(): `Number(false)` is 0 and passes a bare isFinite check, and
        // `false` is exactly what getBlockTime returns for a block it cannot serve.
        let usable = (typeof horizonBound === 'number') && Number.isFinite(horizonBound);
        let target = usable ? Math.min(blockTime, horizonBound) : blockTime;
        return this.streamWatermark >= target + this.anchorAttestWatermarkGraceS;
    },

    releaseAnchorAttestWaiters() {
        if (!this._anchorAttestWaiters || this._anchorAttestWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._anchorAttestWaiters) {
            if (this.anchorAttestSyncSatisfied(w.ts, w.bound, w.height)) {
                clearTimeout(w.timer);
                w.resolve(this.streamWatermark);
            } else {
                stillWaiting.push(w);
            }
        }
        this._anchorAttestWaiters = stillWaiting;
    },

    // Block-processing barrier for the anchor-reward derive pass. Resolves once this
    // mirror is certified caught up through blockTime; rejects after timeoutMs so the
    // caller DEFERS the block and retries it (never advancing past a maturity boundary it
    // cannot prove it holds the rows for).
    waitForAnchorAttestationSync(blockTime, timeoutMs, horizonBound = null, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.streamWatermark);
        if (this.anchorAttestSyncSatisfied(blockTime, horizonBound, blockHeight))
            return Promise.resolve(this.streamWatermark);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        const boundApplied = (typeof horizonBound === 'number') && Number.isFinite(horizonBound);
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, bound: horizonBound, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._anchorAttestWaiters = this._anchorAttestWaiters.filter(w => w !== waiter);
                // The prefix through `block_time <t>` is byte-identical to what it has always
                // been: two unit tests and an operator's grep both key on it. The horizon
                // clause is added only when a bound actually applied, so the message says
                // which rule held the block rather than leaving the reader to guess.
                reject(new Error('anchor-reward attestation mirror barrier timed out after ' + ms +
                                 'ms waiting for block_time ' + blockTime +
                                 (boundApplied ? ' (horizon bound ' + horizonBound + ', stream watermark at ' +
                                                 this.streamWatermark + ')'
                                               : ' (stream watermark at ' + this.streamWatermark + ')') +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('anchor_reward_attestations', blockHeight) : '')));
            }, ms);
            this._anchorAttestWaiters.push(waiter);
        });
    },

    // ── Finalized ATTEST response mirror-completeness barrier ──────────────────
    //
    // Distinct from the anchor-reward barrier directly above, which covers
    // anchor_reward_attestations. This one covers attestation_responses: the finalized
    // ATTEST results that replaced the validator-paid on-chain response transaction.
    //
    // A mirror row binds at the first BTC block whose protocol time reaches the row's
    // signed effective_time, and that block fires the contract callback, mints the
    // synthetic v1 action and moves the reward split. A node that has not received the row
    // by then does not merely lag: it settles that block with the callback un-fired and
    // every downstream ledger hash different from its peers', permanently. So a node that
    // cannot certify it holds everything the hub produced up to this block's time DEFERS.
    //
    // There is deliberately NO escape hatch on this barrier: no content watermark, no
    // empty-mirror short circuit, no bootstrapped-flag fast path. An empty mirror is
    // indistinguishable from a mirror that has not been told about the row that binds at
    // this very block, and the price barrier's chain-only escape has no analogue here
    // because the equivalent completeness proof is batch coverage (§6.3), not a clock.
    // Poll mode is never satisfied either, because the stream watermark freezes there by
    // design, and the resulting timeout defers the block, which is the correct fail-closed
    // outcome for precisely the node whose mirror may be stale.
    //
    // Disabled sync is satisfied by definition: with no mirror the indexer reads the hub's
    // MariaDB directly, so there is no delivery lag to wait out.
    // ADMISSION ERA: the attestation_responses height watermark for this chain has reached
    // B - 1. The margin is ONE block, not the default four, because that rail's 120 s forward
    // margin was itself chosen to be as short as the propagation window allows: callback
    // latency is what the attest-response design exists to remove.
    //
    // It REPLACES the watermark comparison rather than joining it, and there is still no
    // escape of any kind: an empty mirror is indistinguishable from a mirror that has not
    // been told about the row binding at this very block, so absence defers here as it always
    // has, now under the height rule instead of the clock.
    attestResponseSyncSatisfied(blockTime, blockHeight = null) {
        if (!this.enabled) return true;
        if (this.admissionActiveAt(blockHeight))
            return this.heightSatisfied('attestation_responses', blockHeight);
        blockTime = Number(blockTime);
        if (!Number.isFinite(blockTime)) return true;
        return this.streamWatermark >= blockTime + this.attestResponseWatermarkGraceS;
    },

    releaseAttestResponseWaiters() {
        if (!this._attestResponseWaiters || this._attestResponseWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._attestResponseWaiters) {
            if (this.attestResponseSyncSatisfied(w.ts, w.height)) {
                clearTimeout(w.timer);
                w.resolve(this.streamWatermark);
            } else {
                stillWaiting.push(w);
            }
        }
        this._attestResponseWaiters = stillWaiting;
    },

    // Block-processing barrier for the ATTEST response applier. Resolves once this mirror
    // is certified caught up through blockTime; rejects after timeoutMs so the caller
    // DEFERS the block and retries it, never binding a response set it cannot prove is
    // complete.
    waitForAttestationResponseSync(blockTime, timeoutMs, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.streamWatermark);
        if (this.attestResponseSyncSatisfied(blockTime, blockHeight)) return Promise.resolve(this.streamWatermark);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._attestResponseWaiters = this._attestResponseWaiters.filter(w => w !== waiter);
                reject(new Error('attestation response mirror barrier timed out after ' + ms +
                                 'ms waiting for block_time ' + blockTime +
                                 ' (stream watermark at ' + this.streamWatermark + ')' +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('attestation_responses', blockHeight) : '')));
            }, ms);
            this._attestResponseWaiters.push(waiter);
        });
    },

};
