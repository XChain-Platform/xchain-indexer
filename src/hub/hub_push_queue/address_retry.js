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
}

module.exports = AddressRetry;
