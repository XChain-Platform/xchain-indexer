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

// Attestation-bearing ANCHOR versions. A reward exists only for these; anything else on
// the txid is a different anchor and cannot stand in as proof of this one.
const ATTESTED_VERSIONS = [0, 1];

// Which anchor versions can prove which reward FAMILY, and nothing else.
//
// The reward type names one publishing shape, and each shape rides exactly one wire
// version: 'anchor_archive' is the v1 archive head, 'anchor_bundle' is the v0 per-network
// checkpoint bundle. The map is exhaustive and exclusive on purpose: an archive head can
// never prove a bundle reward and a bundle section can never prove an archive one, whatever
// else on the transaction matches. Membership here is part of the binding, not a
// convenience, so a wire version added later gets a family here or proves nothing.
//
// The per-chain family is gone with the per-chain wires: those rewards were attested before
// the version restart, are already recorded, and are never re-derived (spec D9).
const REWARD_FAMILY_VERSIONS = {
    archive: [1],
    bundle:  [0]
};

// The reward family a reward_type names. reward_type is inside the XANCPUB canonical the
// caller re-verifies (anchor_reward_derive.rewardCanonical), so it is quorum-signed; the
// family is read from it alone and never from an unsigned mirror column. A reward_type
// naming no live family (a pre-restart 'anchor_<CHAIN>') returns null and proves nothing:
// falling back to a family would let a live anchor stand in for a retired reward.
function rewardFamily(rewardType){
    let t = String(rewardType);
    if(t === 'anchor_archive') return 'archive';
    if(t === 'anchor_bundle')  return 'bundle';
    return null;
}

// Hard stop on the getanchorconfirmations page walk in proveMined. At ANCHOR_ROW_LIMIT
// (20) rows a page this admits 500 anchor actions for one transaction, which no DOGE
// transaction can physically carry, so reaching it means the peer is faulty or hostile
// rather than that the bound is too small. It exists only so a peer that keeps answering
// "truncated" cannot spin the block loop; the walk answers 'unknown' there instead of
// judging an incomplete set.
const MAX_ANCHOR_PAGES = 25;

// Anchor statuses that are NOT fleet-uniform, so they are evidence of nothing here.
//
// _judge's whole licence to memoize a permanent 'rejected' is that the status is chain
// data every honest DOGE node computes identically. Three values in actions/anchor.js
// break that, and they break it in OPPOSITE directions on the same anchor:
//   'unverified'            - the node holds no mirrored oracle_publish snapshot
//                             (anchor.js oracleN === 0), so it declines to judge the
//                             root quorum at all.
//   'invalid: insufficient  - only a node that DOES mirror the snapshot can produce this
//    signer stake|valid       verdict for the SAME anchor the unmirrored node stamped
//    signatures (n/m)'        'unverified'.
//   'invalid: SECTION n     - the same quorum verdict on the v7 bundle leg, which names the
//    insufficient ...'        failing section. The bundle stamps ONE status across its
//                             section rows, and a node holding no mirrored snapshot for any
//                             section stamps the whole bundle 'unverified', so this spelling
//                             divides the fleet exactly as the per-chain one does.
//   'invalid_archive'       - the head-side reassembly CRC, stamped only by a node that
//                             holds the chunks and passes the unverified-head gate.
// So a BTC node reading a mirrored DOGE indexer memoized 'rejected' and skipped the
// reward forever, while a BTC node reading an unmirrored one read 'unverified', fell
// through to 'verified' and minted: a permanent COLLECT-rail divergence decided by which
// DOGE_INDEXER_URL each node happens to carry. Treating all four as non-evidence pins
// every node to the reading the unmirrored class already produces, so the verdict keys
// only on fields that are node-class-independent (version, chain, network, publisher,
// snapshot_block, seq, confirmations). The publisher-attestation quorum is not lost with
// them: anchor_reward_derive.verifyAttestation re-runs it BTC-side before proveMined.
// Every other 'invalid: ...' anchor.js writes is decided from the wire bytes plus
// replayed DOGE chain state, so it stays a deterministic reject.
const NODE_CLASS_DEPENDENT_STATUS =
    /^(?:unverified|invalid: insufficient|invalid: SECTION \d+ insufficient|invalid_archive)/i;

class AnchorProofClient {

    // `config` is the indexer config (COIN/NETWORK). `opts.timeoutMs` bounds each call;
    // the default matches the hub's own indexer-call timeout.
    constructor(config, opts){
        let o = opts || {};
        this.config    = config || {};
        this.url       = String(o.url || process.env.DOGE_INDEXER_API_URL || process.env.DOGE_INDEXER_URL
                                || this.config['DOGE_INDEXER_URL'] || '');
        this.apiKey    = String(o.apiKey || process.env.DOGE_INDEXER_API_KEY || this.config['DOGE_INDEXER_API_KEY'] || '');
        this.timeoutMs = parseInt(o.timeoutMs || process.env.ANCHOR_PROOF_TIMEOUT_MS || '15000', 10);
        // Per-REWARD-TUPLE verdict memo (see _memoKey; NOT per-txid, which let one tuple's
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
    async _fetch(txid, after){
        if(!this.url) return null;
        try {
            let params = { txid: txid };
            if(after !== null && after !== undefined) params.after_action_index = after;
            let result = await this._rpc('getanchorconfirmations', params);
            if(!result || result.error || !Array.isArray(result.anchors)) return null;
            return result;
        } catch(e){
            console.warn('AnchorProofClient: getanchorconfirmations unreachable for ' + txid + ': ' + (e && e.message));
            return null;
        }
    }

    // JSON-RPC over the node http/https core modules, matching HubClient._call. The
    // indexer deliberately carries no HTTP client dependency, and this read is on the
    // block-processing path, so it does not get to add one.
    _rpc(method, params){
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

        let memoKey = this._memoKey(txid, e);
        if(this._memo.has(memoKey)) return this._memo.get(memoKey);

        // WALK EVERY PAGE BEFORE JUDGING. getanchorconfirmations bounds its answer at
        // ANCHOR_ROW_LIMIT rows, and a window that happens to hold some attested sibling
        // anchor but not this tuple's own is, on the wire, identical to a complete
        // non-matching set: _judge below reads it as a positively-detected mis-bind and
        // returns a MEMOIZED, permanent 'rejected', and anchor_reward_derive turns that
        // into "no reward derived" forever. Degrading that case to 'unknown' instead is not
        // the fix it looks like: 'unknown' throws AnchorProofUnavailableError, which halts
        // block processing on every BTC node at once and never clears, since the same
        // deterministic window comes back on every retry. So the window is removed rather
        // than reinterpreted, and _judge keeps seeing a COMPLETE anchor set.
        //
        // Only a peer that positively reports `truncated` is asked for another page. An
        // indexer predating pagination reports nothing, the walk stops after one page, and
        // this node behaves exactly as it did before, so a mixed fleet degrades to today's
        // reading rather than to a stall.
        let anchors = [];
        let after   = null;
        let walking = true;
        for(let page = 0; walking && page < MAX_ANCHOR_PAGES; page++){
            let result = await this._fetch(txid, after);
            if(!result) return 'unknown';
            if(page === 0 && (!result.exists || result.anchors.length === 0)){
                // The DOGE indexer has no such transaction. That is NOT proof it will never
                // have one: it may simply be behind. Deferring is the only safe reading.
                return 'unknown';
            }
            anchors = anchors.concat(result.anchors);
            if(result.truncated !== true){ walking = false; break; }
            let next = Number(result.next_after_action_index);
            // A peer that says "truncated" and then cannot say where to resume, or hands
            // back a cursor that does not advance, is answering a protocol it only half
            // speaks. Judging the partial set it gave us is exactly the silent forfeit this
            // walk exists to remove, so treat it as the malformed reply it is.
            if(!Number.isInteger(next) || (after !== null && next <= after)){
                console.warn('AnchorProofClient: ' + txid + ' reported truncated with an unusable ' +
                             'page cursor (' + result.next_after_action_index + '); cannot complete the walk');
                return 'unknown';
            }
            after = next;
        }
        if(walking){
            // MAX_ANCHOR_PAGES exhausted with the set still incomplete. Unreachable with a
            // real anchor transaction (the txid is the hub's own ANCHOR tx, and a DOGE
            // transaction cannot carry this many anchor actions), so this is a peer fault or
            // a hostile answer, not a bound to tune. Refuse to judge a partial set.
            console.error('AnchorProofClient: ' + txid + ' still truncated after ' + MAX_ANCHOR_PAGES +
                          ' pages; refusing to judge a partial anchor set');
            return 'unknown';
        }

        let verdict = this._judge(anchors, e);
        if(verdict !== 'unknown') this._memo.set(memoKey, verdict);
        return verdict;
    }

    // Cache key for a DECIDED verdict. The verdict is a function of the whole reward tuple,
    // never of the txid alone, so the key carries every field _judge reads. One DOGE txid can
    // be named by more than one anchor_reward_attestations row (a failover double-publish
    // inserts one row per publisher, and a per-chain v4/v5 anchor can share a transaction with
    // the v6 archive leg), and doge_anchor_txid is NOT covered by the XANCPUB canonical
    // rewardCanonical() re-verifies, so a txid-only key let a 'verified' for one tuple mint an
    // unproven reward for another, and a 'rejected' suppress a legitimate one. Because the memo
    // is process-lifetime state, that leak also made the derived set restart-dependent, which
    // is a COLLECT-rail fork. Normalize exactly as _judge does, or two spellings of one tuple
    // miss each other. A field added to _judge must be added here too. _judge's chain term needs
    // no entry of its own, and neither does the reward FAMILY or the round term it selects:
    // all three are derived from rewardType, which is already a term here.
    _memoKey(txid, e){
        return [txid,
                String(e.rewardType),
                Number(e.roundReference),
                Number(e.snapshotBlock),
                String(e.publisher || '').toLowerCase(),
                String(e.network || ''),
                Number(e.minConfirmations)].join('|');
    }

    // Bind the anchors a txid carries to the reward tuple. Pure, so the whole binding rule
    // is unit-testable without a DOGE indexer.
    _judge(anchors, e){
        let minConf   = Number(e.minConfirmations);
        let network   = String(e.network || '');
        let publisher = String(e.publisher || '').toLowerCase();
        let round     = Number(e.roundReference);
        let snapshot  = Number(e.snapshotBlock);
        let family    = rewardFamily(e.rewardType);
        // A reward_type that names no live family names a retired wire (the pre-restart
        // per-chain anchors). No anchor of any live version can prove it, and every node
        // reads that off the quorum-signed reward_type alone, so it is a deterministic
        // permanent reject rather than an 'unknown' that would defer the block forever.
        if(family === null) return 'rejected';
        let isArchive = family === 'archive';
        let versions  = REWARD_FAMILY_VERSIONS[family];
        // The bundle's header SNAPSHOT_BLOCK, reconstructed from the section rows.
        //
        // The wire carries the header block once and each section carries its own, and the
        // indexer writes the SECTION's value onto the section's row, so no single row reports
        // the header. The parser proves the header IS the maximum over the sections (a header
        // above every section would move the attestation round, and the reward's earn block,
        // onto an oracle_publish set no section signed against), so the maximum over the v0
        // rows of this transaction reconstructs it exactly. The hub keys the one bundle reward
        // on that header block, so binding here is what stops a LAGGING section, riding the
        // bundle at its own older block, from proving a reward at that older block: a reward
        // the federation never attested and the bundle never earned. Rows above are complete by
        // construction (proveMined walks every page before judging), and one transaction
        // carries one bundle, so this maximum is that bundle's header and nothing else.
        let bundleBlock = null;
        if(family === 'bundle'){
            for(let a of anchors){
                if(Number(a.version) !== 0) continue;
                let b = Number(a.snapshot_block);
                if(Number.isFinite(b) && (bundleBlock === null || b > bundleBlock)) bundleBlock = b;
            }
        }
        let sawAttested = false;
        for(let a of anchors){
            if(!ATTESTED_VERSIONS.includes(Number(a.version))) continue;   // a sibling anchor in the same tx, not our proof
            sawAttested = true;
            // One family, one wire version (REWARD_FAMILY_VERSIONS above). A v0 bundle section
            // can never prove an archive reward and a v1 archive head can never prove a bundle
            // one, whatever else on the transaction matches.
            if(!versions.includes(Number(a.version))) continue;
            // Decoded-invalid never anchored anything, EXCEPT where the invalidity is a
            // node-class verdict rather than chain data (NODE_CLASS_DEPENDENT_STATUS above):
            // those are skipped as evidence so two BTC nodes reading different DOGE indexers
            // cannot decide the same reward tuple oppositely and fork the derived set.
            let status = String(a.status || '');
            if(/^invalid/i.test(status) && !NODE_CLASS_DEPENDENT_STATUS.test(status)) continue;
            if(String(a.checkpoint_network || '') !== network) continue;
            // No CHAIN term: neither live family binds one. The archive XANCPUB canonical keys on
            // MATCH_BATCH_SEQ, and its head carries the chain of whatever checkpoint wrapped it;
            // a bundle is ONE action carrying every checkpointed chain as a section under one
            // publisher tail and one reward keyed on the bundle SNAPSHOT_BLOCK, so it is bound to
            // the BUNDLE and names no chain at all. The retired per-chain family was the only one
            // that needed the term, and it can no longer be proven at all (see rewardFamily).
            if(String(a.publisher || '').toLowerCase() !== publisher) continue;
            // On a v0 section row this column is the SECTION's own snapshot block, not the
            // bundle header's, because a lagging chain rides a bundle at its own block. So the
            // bundle leg holds the row to BOTH values: the reward's snapshot block and the
            // reconstructed header above. The two together prove the row is the header-block
            // section of the bundle the reward names.
            if(family === 'bundle' && Number(a.snapshot_block) !== bundleBlock) continue;
            if(Number(a.snapshot_block) !== snapshot) continue;
            // The round term per family. Archive: match_batch_seq. Bundle: the snapshot block
            // itself, because a bundle's round_reference IS its SNAPSHOT_BLOCK (one reward per
            // bundle, keyed on the bundle block, six-field XANCPUB canonical with the block
            // repeated at fields 2 and 3). Using a section's checkpoint_seq here instead would
            // bind the whole bundle to whichever chain happened to be first in the wire, and
            // would reject outright any bundle carrying a lagging section whose seq trails the
            // bundle block.
            let seq = isArchive ? Number(a.match_batch_seq) : Number(a.snapshot_block);
            if(seq !== round) continue;
            // Bound at last: a tuple-matching anchor that is merely too shallow is a
            // 'unknown' (it will bury), not a 'rejected' (it never will).
            if(!(Number(a.confirmations) >= minConf)) return 'unknown';
            return 'verified';
        }
        // The transaction is on DOGE and carries attested anchors, none of which is this
        // reward: a positively-detected mis-bind. Every node sees the same rows, so this is
        // a deterministic permanent reject. If it carried no attested anchor at all we
        // cannot tell a forge from an un-decoded row, so that stays 'unknown'.
        return sawAttested ? 'rejected' : 'unknown';
    }
}

module.exports = AnchorProofClient;
module.exports.ATTESTED_VERSIONS = ATTESTED_VERSIONS;
