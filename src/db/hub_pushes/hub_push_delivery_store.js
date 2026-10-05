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

const { getLogger } = require('../../observability/index.js');

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

    parseDeliveredTo(value){
        if(value == null) return new Set();
        if(Buffer.isBuffer(value)) value = value.toString('utf8');
        if(typeof value === 'string'){
            try { value = JSON.parse(value); }
            catch (err) { return new Set(); }
        }
        if(!Array.isArray(value)) return new Set();
        return new Set(value.filter(address => typeof address === 'string'));
    }

    async getDeliveredTo(rowId){
        let rows = await this.indexerDb.poolQuery(
            'SELECT delivered_to FROM pending_hub_pushes WHERE id = ?', [rowId]);
        return this.parseDeliveredTo(rows && rows[0] && rows[0].delivered_to);
    }

    async markDelivered(rowId, address){
        await this.indexerDb.poolQuery(
            `UPDATE pending_hub_pushes
                SET delivered_to = JSON_ARRAY_APPEND(
                    COALESCE(delivered_to, JSON_ARRAY()), '$', ?)
              WHERE id = ?
                AND NOT JSON_CONTAINS(
                    COALESCE(delivered_to, JSON_ARRAY()), JSON_QUOTE(?), '$')`,
            [address, rowId, address]
        );
    }

    async attempt(row, candidates){
        let parsed = await this.queue.parseHubPushPayload(row);
        if(parsed === null) return;

        let deliveredTo = await this.getDeliveredTo(row.id);
        let firstError = null;
        for(let address of candidates){
            if(deliveredTo.has(address)) continue;
            try {
                let delivered = await this.queue.deliverHubPush(
                    row, parsed.payload, this.clientForAddress(address));
                if(!delivered) return;
                await this.markDelivered(row.id, address);
                deliveredTo.add(address);
                getLogger().info('HubPushQueue: delivered ' + row.push_type + ' row ' + row.id +
                    ' to ' + address);
            } catch (err){
                if(!firstError) firstError = err;
                if(err && err.rateLimited) break;
            }
        }

        if(candidates.every(address => deliveredTo.has(address))){
            await this.indexerDb.markHubPushDelivered(row.id);
            return;
        }
        if(firstError){
            let attemptNo = (Number(row.attempts) || 0) + 1;
            await this.queue.recordHubPushFailure(row, firstError, attemptNo);
        }
    }
}

module.exports = HubPushDeliveryStore;
