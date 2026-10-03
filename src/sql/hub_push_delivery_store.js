// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { getLogger } = require('../observability/index.js');

class HubPushDeliveryStore {

    constructor(queue, selector){
        this.queue = queue;
        this.indexerDb = queue.indexerDb;
        this.hubClient = queue.hubClient;
        this.hubSelector = selector || queue.indexer.hubSelector || queue.indexer.selector ||
            (this.hubClient && (this.hubClient.selector || this.hubClient.hubSelector)) || null;
    }

    candidateAddresses(){
        if(!this.hubSelector) return [];
        let status = (typeof this.hubSelector.status === 'function')
            ? this.hubSelector.status() : this.hubSelector;
        if((status && (status.pinned === true || status.mode === 'pinned')) ||
           this.hubSelector.pinned === true ||
           (typeof this.hubSelector.isPinned === 'function' && this.hubSelector.isPinned()))
            return [];
        let candidates = status && status.candidates;
        if(!Array.isArray(candidates) && Array.isArray(this.hubSelector.candidates))
            candidates = this.hubSelector.candidates;
        if(!Array.isArray(candidates)) return [];
        return [...new Set(candidates
            .map(candidate => typeof candidate === 'string' ? candidate : candidate && candidate.address)
            .filter(address => typeof address === 'string' && address.length > 0))];
    }

    clientForAddress(address){
        let base = this.hubClient;
        let client = Object.create(base);
        client.hubUrl = address;
        client.call = (method, params, apiKeyOverride, urlOverride) =>
            base.call(method, params, apiKeyOverride, urlOverride || address);
        return client;
    }

    async ensure(rowId, addresses){
        let values = addresses.map(() => "(?, ?, 'pending', 0, NOW(), NOW())").join(', ');
        let params = [];
        for(let address of addresses) params.push(rowId, address);
        await this.indexerDb.poolQuery(
            `INSERT IGNORE INTO hub_push_deliveries
                (push_id, hub_address, status, attempts, created_at, updated_at)
             VALUES ${values}`,
            params
        );
    }

    async get(rowId){
        return await this.indexerDb.poolQuery(
            `SELECT push_id, hub_address, status, attempts, last_attempted_at, last_error
               FROM hub_push_deliveries WHERE push_id = ?`,
            [rowId]
        );
    }

    async markDelivered(rowId, address){
        await this.indexerDb.poolQuery(
            `UPDATE hub_push_deliveries
                SET status = 'delivered', last_attempted_at = NOW(), last_error = NULL,
                    updated_at = NOW()
              WHERE push_id = ? AND hub_address = ?`,
            [rowId, address]
        );
    }

    async recordFailure(rowId, address, err){
        let msg = String((err && err.message) || err).slice(0, 480);
        if(err && err.rateLimited){
            let waitMs = Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : 60000;
            this.queue._throttledUntilMs = Date.now() + waitMs;
            getLogger().warn('HubPushQueue: hub rate-limited delivery to ' + address +
                '; holding the queue ' + Math.round(waitMs / 1000) + 's (' + msg + ')');
            return;
        }
        await this.indexerDb.poolQuery(
            `UPDATE hub_push_deliveries
                SET attempts = attempts + 1, last_attempted_at = NOW(), last_error = ?,
                    updated_at = NOW()
              WHERE push_id = ? AND hub_address = ?`,
            [msg, rowId, address]
        );
        getLogger().warn('HubPushQueue: delivery failed for row ' + rowId + ' to ' + address + ': ' + msg);
    }

    async remove(rowId){
        await this.indexerDb.poolQuery('DELETE FROM hub_push_deliveries WHERE push_id = ?', [rowId]);
    }

    async attempt(row, candidates){
        let parsed = await this.queue.parseHubPushPayload(row);
        if(parsed === null) return;

        await this.ensure(row.id, candidates);
        let deliveries = await this.get(row.id);
        let byAddress = new Map((deliveries || []).map(delivery => [delivery.hub_address, delivery]));
        let now = Date.now();

        for(let address of candidates){
            let delivery = byAddress.get(address) || {
                hub_address: address,
                status: 'pending',
                attempts: 0,
                last_attempted_at: null
            };
            if(delivery.status === 'delivered' || !this.queue.isDue(delivery, now)) continue;
            try {
                let delivered = await this.queue.deliverHubPush(row, parsed.payload, this.clientForAddress(address));
                if(!delivered){
                    await this.remove(row.id);
                    return;
                }
                await this.markDelivered(row.id, address);
                delivery.status = 'delivered';
                byAddress.set(address, delivery);
                getLogger().info('HubPushQueue: delivered ' + row.push_type + ' row ' + row.id +
                    ' to ' + address);
            } catch (err){
                await this.recordFailure(row.id, address, err);
            }
        }

        if(candidates.every(address => {
            let delivery = byAddress.get(address);
            return delivery && delivery.status === 'delivered';
        })){
            await this.remove(row.id);
            await this.indexerDb.markHubPushDelivered(row.id);
        }
    }
}

module.exports = HubPushDeliveryStore;
