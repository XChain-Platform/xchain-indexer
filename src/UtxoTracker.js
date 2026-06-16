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
 * XChain Indexer - UTXO Tracker Client
 *
 * Thin JSON-RPC client used by the indexer to query xchain-utxo-tracker.
 * Currently exposes get_first_seen which returns the first block height a
 * given address ever appeared in (or null if it never has). Used by the
 * DISPENSER action to enforce the fresh-address exception against
 * DISPENSER_PREFERENCE.
 *
 ********************************************************************/

class UtxoTracker {
    constructor(url, port){
        this.url     = url;
        this.port    = port;
        this.enabled = !!(url && port);
        this.endpoint = this.enabled ? ('http://' + url + ':' + port) : null;
    }

    // POST a JSON-RPC request and return responseData.result, or throw.
    async _call(method, params){
        if(!this.enabled)
            throw new Error('UTXO tracker not configured (UTXO_TRACKER_URL / UTXO_TRACKER_API_PORT)');

        let body = JSON.stringify({
            jsonrpc: '2.0',
            method:  method,
            params:  params,
            id:      1
        });

        let response = await fetch(this.endpoint, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    body
        });

        if(!response.ok)
            throw new Error('UTXO tracker HTTP error: ' + response.status);

        let json = await response.json();
        if(json.error)
            throw new Error('UTXO tracker RPC error: ' + JSON.stringify(json.error));

        return json.result;
    }

    // Return { height: N } if the address has ever appeared on chain, or null.
    async getFirstSeen(address){
        let result = await this._call('get_first_seen', { address: address });
        if(result === null || result === undefined)
            return null;
        if(typeof result.height !== 'number')
            return null;
        return { height: result.height };
    }
}

module.exports = UtxoTracker;
