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
 *
 * getFirstSeen returns the first block height a given address ever appeared in
 * (or null if it never has). The DISPENSER action uses it to enforce the
 * fresh-address exception against DISPENSER_PREFERENCE below the freshness
 * flag-day; that verdict is replay-frozen, and this wire shape is frozen with it.
 *
 * getFirstSeenStatus is the tracker's freshness-aware sibling: the same
 * first-seen value plus the tracker's own sync/halt view, so a null first-seen
 * from a LAGGING or HALTED tracker is distinguishable from an address that has
 * genuinely never appeared. DIAGNOSTIC USE ONLY. The frozen verdict keeps
 * reading getFirstSeen, because changing the method a hashed verdict is computed
 * from is itself a consensus change.
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

    // Return { firstSeen, sync }: the same value getFirstSeen would give, plus the
    // tracker's freshness meta (tracker_height, node_height, lag, synced,
    // mempool_ready, and halted/halt_reason only while halted). `sync` is null when
    // the tracker answered without one. Throws on transport / RPC failure, including
    // the -32601 a tracker deployed before get_first_seen_status answers with; the
    // caller decides what to do about that, and the one caller today is a
    // swallow-everything diagnostic.
    async getFirstSeenStatus(address){
        let result    = await this._call('get_first_seen_status', { address: address });
        let raw       = (result && result.first_seen) || null;
        let firstSeen = (raw && typeof raw.height === 'number') ? { height: raw.height } : null;
        return { firstSeen: firstSeen, sync: (result && result.sync) || null };
    }
}

module.exports = UtxoTracker;
