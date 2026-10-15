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
 * XChain Indexer - Hub DB Sync Client: remote-token pin barrier
 *
 * The height barrier over remote_token_snapshots. From
 * remote_token_admission_activation an ORDER or SWAP create at block B reads the
 * newest pin admitted on this chain at or below B, so the block waits until the
 * hub's remote_token_snapshots height watermark for this chain reaches the consumer
 * target for B: every pin admitted at or below B is then in this mirror.
 *
 * There is no empty-mirror escape. A pin is admitted a margin AHEAD of the hub's
 * tip when it is signed, so an empty mirror says nothing about whether a pin
 * admitted at or below B is still in flight; only the watermark does.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const REMOTE_TOKEN_TABLE = 'remote_token_snapshots';

module.exports = {

    // Mark the table bootstrapped once a full drain has applied it, and re-evaluate the
    // waiters. A live row or a reconnect refresh defaults armBootstrap to the drain state,
    // so it cannot arm the barrier over a mirror that has not been drained.
    async refreshRemoteTokenSyncState(armBootstrap = this._bootstrapDrained) {
        if (armBootstrap) this.remoteTokenBootstrapped = true;
        this.releaseRemoteTokenWaiters();
    },

    remoteTokenSyncSatisfied(blockHeight) {
        return this.remoteTokenBootstrapped && this.heightSatisfied(REMOTE_TOKEN_TABLE, blockHeight);
    },

    releaseRemoteTokenWaiters() {
        if (this._remoteTokenWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._remoteTokenWaiters) {
            if (this.remoteTokenSyncSatisfied(w.height)) {
                clearTimeout(w.timer);
                w.resolve(true);
            } else {
                stillWaiting.push(w);
            }
        }
        this._remoteTokenWaiters = stillWaiting;
    },

    // Resolves once remoteTokenSyncSatisfied(B) holds; rejects after timeoutMs so the
    // caller defers the block and retries it rather than reading a pin set that is not
    // yet final at B. Resolves at once when sync is disabled.
    waitForRemoteTokenSync(timeoutMs, blockHeight) {
        blockHeight = Number(blockHeight);
        if (!this.enabled || !Number.isFinite(blockHeight)) return Promise.resolve(true);
        if (this.remoteTokenSyncSatisfied(blockHeight)) return Promise.resolve(true);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                // A satisfied waiter is resolved and dropped by the release; only a short one remains.
                this.releaseRemoteTokenWaiters();
                if (this._remoteTokenWaiters.indexOf(waiter) === -1) return;
                this._remoteTokenWaiters = this._remoteTokenWaiters.filter(w => w !== waiter);
                reject(new Error('remote token sync barrier timed out after ' + ms +
                                 'ms waiting for block_height ' + blockHeight +
                                 this.heightTail(REMOTE_TOKEN_TABLE, blockHeight)));
            }, ms);
            this._remoteTokenWaiters.push(waiter);
        });
    },

};
