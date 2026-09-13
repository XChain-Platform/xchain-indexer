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
 * XChain Indexer - Database mixin: hub_pushes
 * 
 * The queries over the hub_pushes table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // One grouped scan of the queue for the health endpoint: a row per status carrying the
    // row count and, for the oldest row in that status, its age in seconds. Pooled rather
    // than transactional so the health endpoint can read it while drain() is mid-flight.
    // The age is computed server-side, which keeps host and DB clock skew out of the number;
    // that field is the only signal of a stalled rail now that pushes retry without a cap,
    // because a stall shows up as an AGEING pending backlog, not a climbing failed count.
    async getHubPushQueueStats(){
        return await this._poolQuery(
            `SELECT status, COUNT(*) AS cnt,
                    TIMESTAMPDIFF(SECOND, MIN(created_at), NOW()) AS oldest_age_sec
               FROM pending_hub_pushes GROUP BY status`
        );
    },

    // Source-chain reorg fence (item 5308). The current monotonic push generation for `coin`,
    // 0 when no rollback has ever bumped it (matches the DEFAULT 0 hub rows stamp before the
    // first reorg, all of which are then always deletable). Read fresh on every push + rollback;
    // the value lives only in the DB so it survives a crash and is never rolled back.
    async getPushGeneration(coin){
        let results = await this.doQuery('SELECT generation FROM push_generations WHERE coin = ? LIMIT 1', [coin]);
        return (results.length > 0) ? Number(results[0].generation) : 0;
    },

    // Bump `coin`'s push generation by one (creating the row at 1 on first bump) and return the
    // NEW value. Called once at the start of every rollback, BEFORE forward replay, so rows the
    // replay re-publishes carry the bumped generation while the orphaned rows keep the prior one.
    // The retraction carries the PRE-bump generation (newGen - 1), so the fence deletes the
    // orphans (gen <= pre) and the re-published rows (gen == new) survive. Monotonic: a skipped
    // value from a crashed-then-retried rollback is harmless since the fence only needs <=.
    async bumpPushGeneration(coin){
        await this.doQuery(
            'INSERT INTO push_generations (coin, generation) VALUES (?, 1) ON DUPLICATE KEY UPDATE generation = generation + 1',
            [coin]);
        return await this.getPushGeneration(coin);
    },

    // Park a failed hub push for later retry. `payload` is the exact argument
    // object the HubClient method expects; it is serialized to JSON. The source
    // action_index is lifted out into its own column so a reorg can purge queued
    // pushes for orphaned actions via the rollback dataTables loop.
    //
    // THE COLUMN IS THE ROLLBACK KEY, NOT THE PAYLOAD'S DISPLAY INDEX. For every push
    // whose payload names the action that landed it the two are the same value, which is
    // why the default reads `payload.action_index`. The ATTEST v6 batch is the one caller
    // where they differ: its payload names the batch HEAD, because the hub stamps that
    // index onto every carried response as the batch link, while the delivery is landed by
    // the completing continuation. Keying that row on the payload leaves the queued
    // delivery alive through a rollback of the very chunk that completed the batch, so it
    // passes the completing action explicitly as `rollbackActionIndex`.
    //
    // @param {string} pushType the pending_hub_pushes.push_type tag
    // @param {Object} payload the HubClient argument object, serialized to JSON
    // @param {number} [rollbackActionIndex] the action whose rollback must un-land this
    //                 push; omitted means the payload's own action_index
    async enqueueHubPush(pushType, payload, rollbackActionIndex){
        let actionIndex = (rollbackActionIndex != null) ? rollbackActionIndex
                        : ((payload && payload.action_index != null) ? payload.action_index : 0);
        let query = `INSERT INTO pending_hub_pushes (push_type, action_index, payload, status, attempts, created_at)
                     VALUES (?, ?, ?, 'pending', 0, NOW())`;
        await this._poolQuery(query, [pushType, actionIndex, JSON.stringify(payload)]);
    },

    // Like enqueueHubPush, but routes through the OPEN transaction connection (doQuery, not
    // _poolQuery) so the row commits atomically with the caller's transaction, and returns the new
    // row id. Used by rollback.js to write-ahead its hub retractions inside the rollback transaction
    // (HUB-RETRACT-2): the durable row survives a crash between commit and live delivery, and the id
    // lets the caller markHubPushDelivered() on a successful immediate delivery. MUST be called with a
    // transaction open (getConnection() then returns transactionConnection); otherwise it would land
    // on a pooled connection and not be atomic with the rollback.
    //
    // `rollbackActionIndex` carries the same meaning it carries on enqueueHubPush: the
    // action whose rollback must un-land this push, which is the payload's own
    // action_index for every caller but the ATTEST v6 batch absorb.
    async enqueueHubPushTx(pushType, payload, rollbackActionIndex){
        let actionIndex = (rollbackActionIndex != null) ? rollbackActionIndex
                        : ((payload && payload.action_index != null) ? payload.action_index : 0);
        let query = `INSERT INTO pending_hub_pushes (push_type, action_index, payload, status, attempts, created_at)
                     VALUES (?, ?, ?, 'pending', 0, NOW())`;
        let res = await this.doQuery(query, [pushType, actionIndex, JSON.stringify(payload)]);
        return (res && res.insertId != null) ? Number(res.insertId) : null;
    },

    // Fetch the oldest DUE pending rows for the poller (`failed` rows are excluded
    // - they are terminal). The backoff due-time predicate mirrors HubPushQueue's
    // JS-side _isDue formula (delay = LEAST(base * 2^(attempts-1), max)) directly
    // in the WHERE clause, so rows still parked in backoff no longer occupy the
    // LIMIT batch slots. Before this, a row that is pending-but-not-due still
    // counted against LIMIT, so a hub outage that accumulates more than `limit`
    // parked rows could starve every newer due row from ever being fetched
    // (review finding 01178748: head-of-line blocking). `baseBackoffMs` and
    // `maxBackoffMs` MUST be the same values HubPushQueue uses for _isDue, or the
    // two due-ness checks drift; the caller passes its own configured values.
    // The queue keeps _isDue as a cheap belt-and-braces re-check after fetch.
    async getPendingHubPushes(limit, backoffOpts){
        let max = Number(limit);
        if(!Number.isFinite(max) || max <= 0) max = 50;
        backoffOpts = backoffOpts || {};
        let baseSec = Math.max(1, Math.floor((Number(backoffOpts.baseBackoffMs) || 30000) / 1000));
        let maxSec  = Math.max(1, Math.floor((Number(backoffOpts.maxBackoffMs)  || 600000) / 1000));
        let query = `SELECT id, push_type, payload, attempts, last_attempted_at, status
                     FROM pending_hub_pushes
                     WHERE status='pending'
                       AND (last_attempted_at IS NULL
                            OR last_attempted_at <= DATE_SUB(NOW(), INTERVAL LEAST(? * POW(2, GREATEST(attempts - 1, 0)), ?) SECOND))
                     ORDER BY id ASC
                     LIMIT ?`;
        return await this._poolQuery(query, [baseSec, maxSec, max]);
    },

    // Drop a row once the hub has accepted it (delivered rows aren't retained).
    async markHubPushDelivered(id){
        await this._poolQuery('DELETE FROM pending_hub_pushes WHERE id=?', [id]);
    },

    // Delete terminal `failed` rows older than maxAgeSeconds and report how many
    // went. Retiring a row to `failed` takes it out of the poller's reach but NOT
    // out of the table: markHubPushDelivered drops only delivered rows, and the
    // rollback purge is scoped to an orphaned action range, so before this sweep a
    // sustained hub outage parked its terminal rows in pending_hub_pushes forever,
    // against the bounded-growth claim the queue makes for itself (item 3462).
    // Age-based rather than delete-on-terminal so the recent failures getStats
    // reports to the health endpoint stay readable. COALESCE covers a row marked
    // failed with no attempt stamp (unparseable payload, unknown push_type). A
    // non-positive age means retain forever and prunes nothing.
    async pruneFailedHubPushes(maxAgeSeconds){
        let age = Number(maxAgeSeconds);
        if(!Number.isFinite(age) || age <= 0) return 0;
        let res = await this._poolQuery(
            `DELETE FROM pending_hub_pushes
                     WHERE status = 'failed'
                       AND COALESCE(last_attempted_at, created_at) <= DATE_SUB(NOW(), INTERVAL ? SECOND)`,
            [Math.floor(age)]);
        return Number(res && res.affectedRows ? res.affectedRows : 0);
    },

    // Record a failed delivery attempt: bump the counter, stamp the time, keep
    // the last error, and retire the row to `failed` once it hits maxAttempts.
    // Retirement ends the retries; pruneFailedHubPushes above is what keeps the
    // table bounded once a row is terminal.
    async recordHubPushAttempt(id, errMsg, maxAttempts){
        let max = Number(maxAttempts);
        if(!Number.isFinite(max) || max <= 0) max = 10;
        let query = `UPDATE pending_hub_pushes
                     SET attempts = attempts + 1,
                         last_attempted_at = NOW(),
                         last_error = ?,
                         status = IF(attempts + 1 >= ?, 'failed', 'pending')
                     WHERE id = ?`;
        await this._poolQuery(query, [errMsg, max, id]);
    },

};
