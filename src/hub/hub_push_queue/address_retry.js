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
const hubPushDb = require('../../db/hub_pushes/index.js');
const HubPushDeliveryStore = require('../../db/hub_pushes/hub_push_delivery_store.js');

class AddressRetry {

    constructor(queue, selector){
        this.queue = queue;
        this.indexerDb = queue.indexerDb;
        this.deliveries = new HubPushDeliveryStore(queue, selector);
        this.hubSelector = this.deliveries.hubSelector;
        this.retryHubAddress = this.currentSelectorAddress();
    }

    currentSelectorAddress(){
        let selector = this.hubSelector;
        let status = selector && (typeof selector.status === 'function' ? selector.status() : selector);
        if(selector && typeof selector.current === 'function') return selector.current();
        return status && typeof status.current === 'string' ? status.current : null;
    }

    async resetPendingAttemptsAfterMove(rows){
        let address = this.currentSelectorAddress();
        if(!address || address === this.retryHubAddress) return false;
        if(!this.retryHubAddress){
            this.retryHubAddress = address;
            return false;
        }
        if(typeof this.indexerDb.resetPendingHubPushAttempts === 'function'){
            await this.indexerDb.resetPendingHubPushAttempts();
        } else if(typeof this.indexerDb.poolQuery === 'function'){
            await hubPushDb.resetPendingHubPushAttempts.call(this.indexerDb);
        }
        this.retryHubAddress = address;
        for(let row of (rows || [])) Object.assign(row, { attempts: 0, last_attempted_at: null, last_error: null });
        getLogger().info('HubPushQueue: reset pending attempts for hub ' + address);
        return true;
    }

    async getPendingHubPushes(batchSize, backoff){
        await this.resetPendingAttemptsAfterMove();
        return this.indexerDb.getPendingHubPushes(batchSize, backoff);
    }

    async isDueAfterMove(row, rows, now){
        await this.resetPendingAttemptsAfterMove(rows);
        return this.queue.isDue(row, now);
    }

    async candidateAddressesAfterMove(row){
        await this.resetPendingAttemptsAfterMove([row]);
        return this.deliveries.candidateAddresses();
    }

    candidateAddresses(){
        return this.deliveries.candidateAddresses();
    }

    attempt(row, candidates){
        return this.deliveries.attempt(row, candidates);
    }

    // Bind a live post-commit send to the selector's current hub when pushes fan out, so
    // the hub later recorded in delivered_to is the hub that took it even if the selector
    // moves mid-call. Pinned or single-hub nodes keep the shared client and record nothing.
    liveDeliveryTarget(fallbackClient){
        let address = this.currentSelectorAddress();
        if(!address || this.candidateAddresses().length === 0)
            return { client: fallbackClient, address: null };
        return { client: this.deliveries.clientForAddress(address), address: address };
    }

    settleLiveDelivery(rowId, address){
        return this.deliveries.settleLiveDelivery(rowId, address);
    }

    // True when an early caller has no queue yet but the selector still has multiple
    // candidate hubs that must receive a durable push once the queue starts.
    static needsDeferredFanout(indexer){
        let selector = indexer && (indexer.hubSelector || indexer.selector);
        if(!selector) return false;
        let status = typeof selector.status === 'function' ? selector.status() : selector;
        if(!status || status.pinned === true || status.mode === 'pinned') return false;
        let candidates = Array.isArray(status.candidates) ? status.candidates : selector.candidates;
        if(!Array.isArray(candidates)) return false;
        let addresses = candidates.map(candidate => typeof candidate === 'string' ? candidate : candidate && candidate.address)
            .filter(address => typeof address === 'string' && address.length > 0);
        return new Set(addresses).size > 1;
    }

    // The live-delivery facade of a running queue, or null when there is no queue.
    // Early callers use needsDeferredFanout before deciding whether a row is complete.
    static liveFacade(queue){
        let facade = queue && queue.hubPushDeliveries;
        return facade && typeof facade.settleLiveDelivery === 'function' ? facade : null;
    }
}

module.exports = AddressRetry;
