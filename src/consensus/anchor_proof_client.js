/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * DOGE anchor visibility for the BTC indexer.
 *
 * The BTC indexer mints the COLLECT-spendable anchor/archive reward from a hub-mirrored
 * anchor_reward_attestations row, but ANCHOR lives on DOGE. Until this client the BTC side
 * had no view of DOGE at all, so it took the mirror's word that the anchor it was paying
 * for had ever been mined: an evicted or reorged anchor still produced a permanent reward.
 * This is the third and last independent re-proof of the same fact (after the publishing
 * hub's confirm-then-write queue and the receiving peer's XANCREWARD check), and it is the
 * one that runs where the money is actually created.
 *
 * VERDICTS, and why there are three rather than two. The caller cannot treat "I could not
 * reach DOGE" as "not mined": that would make the reward set depend on one node's network
 * luck, and two nodes deriving different sets at the same BTC height fork the ledger. So:
 *   'verified'  - the txid carries an anchor of the expected version, bound to this exact
 *                 reward tuple, non-invalid, buried at least `minConfirmations` deep.
 *                 DERIVE.
 *   'rejected'  - the txid is on DOGE and positively contradicts the tuple (wrong
 *                 publisher, wrong seq, wrong snapshot_block, wrong version, decoded
 *                 invalid). Chain data, so every honest node reaches the same verdict:
 *                 SKIP this row forever, deterministically. The statuses that are a
 *                 NODE-CLASS verdict rather than chain data are excluded from it by
 *                 NODE_CLASS_DEPENDENT_STATUS below, or this guarantee is false.
 *   'unknown'   - no DOGE indexer wired, unreachable, malformed reply, or the anchor is
 *                 present but still shallow. The caller must DEFER the block (never
 *                 advance past it) rather than derive a set that another node would
 *                 derive differently.
 *
 * The DOGE endpoint is resolved with the same three-tier idiom the hub uses for its own
 * per-coin indexer calls (env <COIN>_INDEXER_API_URL -> env <COIN>_INDEXER_URL -> config
 * <COIN>_INDEXER_URL), so a fleet already wired for the hub needs no new variable.
 * getanchorconfirmations is a FEDERATION_READ_METHOD, so the key rides as x-api-key.
 *
 ********************************************************************/

'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');

const { getLogger } = require('../observability/index.js');
const { CONFIG_ENV } = require('../config.js');
// The binding rule judge applies (the attested versions, the reward families, the
// node-class-dependent statuses and the bundle header reconstruction) lives in
// anchor_proof_client/binding.js; the getanchorconfirmations page walk proveMined runs
// before it judges lives in anchor_proof_client/page_walk.js.
const { ATTESTED_VERSIONS, judgeAnchors } = require('./anchor_proof_client/binding.js');
const { walkAnchorPages } = require('./anchor_proof_client/page_walk.js');

class AnchorProofClient {

    // The attestation-bearing ANCHOR versions (binding.js), published on the class so a
    // caller can read the set without reaching into the part.
    static ATTESTED_VERSIONS = ATTESTED_VERSIONS;

    // `config` is the indexer config (COIN/NETWORK). `opts.timeoutMs` bounds each call;
    // the default matches the hub's own indexer-call timeout.
    constructor(config, opts){
        let o = opts || {};
        this.config    = config || {};
        this.url       = String(o.url || CONFIG_ENV.DOGE_INDEXER_API_URL || CONFIG_ENV.DOGE_INDEXER_URL
                                || this.config['DOGE_INDEXER_URL'] || '');
        this.apiKey    = String(o.apiKey || CONFIG_ENV.DOGE_INDEXER_API_KEY || this.config['DOGE_INDEXER_API_KEY'] || '');
        this.timeoutMs = parseInt(o.timeoutMs || CONFIG_ENV.ANCHOR_PROOF_TIMEOUT_MS || '15000', 10);
        // Per-REWARD-TUPLE verdict memo (see memoKey; NOT per-txid, which let one tuple's
        // verdict answer for a different tuple naming the same txid). A confirmed anchor is
        // immutable chain data and a block can be re-attempted many times behind a barrier,
        // so re-asking DOGE for every attempt is pure load. Only DECIDED verdicts are
        // memoized: 'unknown' must be re-asked, since it is exactly the state that is
        // expected to change.
        this._memo = new Map();
    }

    configured(){ return !!this.url; }

    // Ask the DOGE indexer what a txid anchored. Returns the parsed result, or null when
    // the answer is unusable (unreachable / RPC error / malformed), which the caller maps
    // to 'unknown'. `after` is the exclusive action_index page cursor; null/undefined asks
    // for the first page, which is the only request an indexer predating pagination
    // understands (it ignores the unknown param and answers the first page anyway).
    async fetch(txid, after){
        if(!this.url) return null;
        try {
            let params = { txid: txid };
            if(after !== null && after !== undefined) params.after_action_index = after;
            let result = await this.rpc('getanchorconfirmations', params);
            if(!result || result.error || !Array.isArray(result.anchors)) return null;
            return result;
        } catch(e){
            getLogger().warn('AnchorProofClient: getanchorconfirmations unreachable for ' + txid + ': ' + (e && e.message));
            return null;
        }
    }

    // JSON-RPC over the node http/https core modules, matching HubClient.call. The
    // indexer deliberately carries no HTTP client dependency, and this read is on the
    // block-processing path, so it does not get to add one.
    rpc(method, params){
        return new Promise((resolve, reject) => {
            let parsed  = url.parse(this.url);
            let isHttps = parsed.protocol === 'https:';
            let lib     = isHttps ? https : http;
            let body    = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params });
            let headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
            if(this.apiKey) headers['x-api-key'] = this.apiKey;
            let req = lib.request({
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     parsed.pathname || '/',
                method:   'POST',
                headers:  headers,
                timeout:  this.timeoutMs
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        let payload = JSON.parse(data);
                        if(payload.error) return reject(new Error(payload.error.message || JSON.stringify(payload.error)));
                        resolve(payload.result);
                    } catch(e){ reject(new Error('Invalid JSON response: ' + e.message)); }
                });
            });
            req.on('error',   (err) => reject(err));
            req.on('timeout', ()    => { req.destroy(new Error('Request timeout')); });
            req.write(body);
            req.end();
        });
    }

    // Prove (or disprove) that `expect` names a mined DOGE anchor.
    //   expect.txid            - the doge_anchor_txid on the mirrored attestation row
    //   expect.rewardType      - 'anchor_<CHAIN>', 'anchor_archive' or 'anchor_bundle'
    //   expect.roundReference  - checkpoint_seq (per-chain), match_batch_seq (archive) or
    //                            the bundle's SNAPSHOT_BLOCK (bundle)
    //   expect.snapshotBlock   - the reward's BTC snapshot_block
    //   expect.publisher       - the elected publisher pubkey being paid
    //   expect.network         - the reward's network
    //   expect.minConfirmations- required DOGE burial depth
    // Returns 'verified' | 'rejected' | 'unknown'.
    async proveMined(expect){
        let e = expect || {};
        let txid = String(e.txid || '').toLowerCase();
        // A row with no txid was written before the column existed. It can never be proven,
        // and "cannot be proven" is a property of the ROW, identical on every node, so this
        // is a deterministic permanent skip rather than a defer.
        if(!/^[0-9a-f]{64}$/.test(txid)) return 'rejected';
        if(!this.url) return 'unknown';                       // fail closed: defer, never pay unproven

        let memoKey = this.memoKey(txid, e);
        if(this._memo.has(memoKey)) return this._memo.get(memoKey);

        // Walk every page before judging (anchor_proof_client/page_walk.js says why).
        // null is any reason the complete anchor set could not be had, which defers.
        let anchors = await walkAnchorPages(this, txid);
        if(anchors === null) return 'unknown';

        let verdict = this.judge(anchors, e);
        if(verdict !== 'unknown') this._memo.set(memoKey, verdict);
        return verdict;
    }

    // Cache key for a DECIDED verdict. The verdict is a function of the whole reward tuple,
    // never of the txid alone, so the key carries every field judge reads. One DOGE txid can
    // be named by more than one anchor_reward_attestations row (a failover double-publish
    // inserts one row per publisher, and a per-chain v4/v5 anchor can share a transaction with
    // the v6 archive leg), and doge_anchor_txid is NOT covered by the XANCPUB canonical
    // rewardCanonical() re-verifies, so a txid-only key let a 'verified' for one tuple mint an
    // unproven reward for another, and a 'rejected' suppress a legitimate one. Because the memo
    // is process-lifetime state, that leak also made the derived set restart-dependent, which
    // is a COLLECT-rail fork. Normalize exactly as judge does, or two spellings of one tuple
    // miss each other. A field added to judge must be added here too. judge's chain term needs
    // no entry of its own, and neither does the reward FAMILY or the round term it selects:
    // all three are derived from rewardType, which is already a term here.
    memoKey(txid, e){
        return [txid,
                String(e.rewardType),
                Number(e.roundReference),
                Number(e.snapshotBlock),
                String(e.publisher || '').toLowerCase(),
                String(e.network || ''),
                Number(e.minConfirmations)].join('|');
    }

    // Bind the anchors a txid carries to the reward tuple. Pure, so the whole binding rule
    // is unit-testable without a DOGE indexer. The rule itself is judgeAnchors in
    // anchor_proof_client/binding.js.
    judge(anchors, e){
        return judgeAnchors(anchors, e);
    }
}

module.exports = AnchorProofClient;
