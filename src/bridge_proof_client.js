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
 * XChain Platform - D2 proof TRANSPORT: the client half of the escrow cross-check.
 *
 * WHAT THIS IS. bridge_checkpoint_check.js proves an origin-chain escrow balance against a
 * quorum-signed state checkpoint, and is deliberately synchronous and pure: it chooses no
 * checkpoint and performs no I/O. This module is the half that does both, and its header
 * names the two obligations it discharges on that module's behalf:
 *
 *   1. SELECT THE CHECKPOINT DETERMINISTICALLY. The first checkpoint at or after
 *      row.snapshot_block for (row.src_chain, row.network), highest checkpoint_seq at that
 *      height. Two nodes that pick different checkpoints, or that differ on whether one is
 *      present yet, produce different verdicts for the same row at the same height, and a
 *      verdict that decides whether an action index is assigned is consensus-visible.
 *   2. HAND OVER ONLY A QUORUM-ESTABLISHED CHECKPOINT. Two sources qualify, and each is
 *      already quorum-established before it reaches the selector:
 *        - a locally parsed `anchor_actions` v0 bundle SECTION with status 'valid'. The
 *          strongest source: actions/anchor.js verified the oracle_publish quorum at parse
 *          time, from chain data this node parsed itself.
 *        - a mirrored `state_checkpoints` row RE-VERIFIED here against the capability
 *          snapshot at that checkpoint's own snapshot_block. The mirror is untrusted, so a
 *          row that has not been re-verified is not a candidate at all: a hub that can forge
 *          the transfer could otherwise forge the root it is proven against, and the whole
 *          cross-check would be vacuous.
 *
 * A CHECKPOINT NOT YET HELD LOCALLY STALLS THE PASS, and that is the third obligation. It is
 * NOT a refusal: a refusal is a consensus verdict ("this row never applies here"), while
 * "my mirror has not caught up" is a property of one node's network. Refusing on absence
 * would let a node that is merely behind decide, permanently, that a legitimate transfer is
 * forged. So every absence, every unreachable endpoint and every malformed answer raises
 * BridgeProofUnavailableError, which the block loop turns into a DEFERRED BLOCK under the
 * stall reason BRIDGE_PROOF_BARRIER, beside waitForBridgeSync. The node retries the same
 * block until the proof is obtainable; it never advances past it on a guess.
 *
 * RESIDUAL NON-DETERMINISM, STATED RATHER THAN HIDDEN. Two nodes can hold DIFFERENT
 * checkpoint sets above row.snapshot_block, so one may select height 102 where the other
 * selects 105. Both are quorum-signed commitments of the same chain and both prove the same
 * escrow balance, so both verdicts are ok:true and the applied effect is identical. The
 * selection rule removes the case that actually forks: two nodes holding the SAME set never
 * pick differently, and a node holding NO qualifying checkpoint stalls instead of deciding.
 *
 * THE PROOF IS TRANSPORT, NEVER A CANONICAL FIELD (D19). Nothing in here is signed, nothing
 * in here is written, and nothing in here reads or writes a signed field.
 *
 * Spec: the base bridge spec sections 5, 8, 12 and work row 17; D2, D19, D46.
 *
 ********************************************************************/

'use strict';

const http    = require('http');
const https   = require('https');
const urllib  = require('url');
const ed25519 = require('./ed25519.js');
const swq     = require('./stake_weighted_quorum.js');
const eq      = require('./equivocation_header.js');

// The block loop's stall reason for a proof that cannot be obtained yet. The '_barrier'
// suffix is load-bearing: health.js keys its mirror-barrier class on it (isMirrorBarrierReason
// in XChainIndexer.js), so a proof stall reads as the mirror-lag stall it is rather than as a
// wedged indexer.
const BRIDGE_PROOF_BARRIER = 'bridge_proof_barrier';

// Why a pass stalled. LOG reasons, not consensus verdict strings: no action's STATUS is built
// from them and no canonical carries them.
const PROOF_STALL_REASON = {
    NO_CHECKPOINT: 'no quorum-established checkpoint at or after the transfer snapshot_block is held locally',
    NO_ENDPOINT:   'no origin-chain indexer endpoint is configured for the escrow proof',
    UNREACHABLE:   'the origin-chain indexer served no usable escrow proof',
};

// The ANCHOR wire version that carries a checkpoint SECTION in its own right. Version 1 is the
// archive head, which carries its WRAPPER checkpoint's identity rather than being one, and
// version 2 is a continuation chunk with no identity at all. Kept as a local constant rather
// than imported from anchor-action-query.js's CHECKPOINT_VERSIONS, which deliberately admits
// the archive head for the getanchoraction read: an archive head's state_root columns are NULL
// (see sql/anchor_actions.sql), so admitting it here would select a rootless "checkpoint" that
// fails CHECKPOINT_ROOTLESS and turn a provable transfer into a refusal.
const ANCHOR_SECTION_VERSION = 0;

/**
 * Raised when the proof for a transfer cannot be obtained YET. The caller must DEFER the
 * block, never refuse the row: see the header.
 */
class BridgeProofUnavailableError extends Error {
    constructor(transferId, detail){
        super('bridge escrow proof unavailable for transfer ' + String(transferId).substring(0, 16) + '...: ' + detail);
        this.name        = 'BridgeProofUnavailableError';
        this.transferId  = transferId;
        this.detail      = detail;
        this.stallReason = BRIDGE_PROOF_BARRIER;
    }
}

// A finite non-negative integer, or null. Heights arrive from a MariaDB driver that may hand
// back a number, a string or a BigInt depending on its bigint options.
function _height(v){
    if(v === null || v === undefined) return null;
    if(typeof v === 'bigint') return (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
    const n = Number(v);
    return (Number.isFinite(n) && Number.isInteger(n) && n >= 0) ? n : null;
}

/**
 * The origin chain's indexer endpoint, resolved with the SAME three-tier idiom
 * anchor_proof_client.js and the hub use for their per-coin indexer calls, so a fleet already
 * wired for the hub needs no new variable:
 *   env <COIN>_INDEXER_API_URL -> env <COIN>_INDEXER_URL -> config <COIN>_INDEXER_URL
 *
 * @param {string} chain  - the origin chain's coin symbol
 * @param {Object} config - the indexer config
 * @returns {{url: string, apiKey: string}} url '' when nothing is wired, which STALLS
 */
function resolveOriginEndpoint(chain, config){
    const c    = String(chain || '').toUpperCase();
    const conf = config || {};
    if(!/^[A-Z]{2,10}$/.test(c)) return { url: '', apiKey: '' };
    return {
        url: String(process.env[c + '_INDEXER_API_URL'] || process.env[c + '_INDEXER_URL']
                    || conf[c + '_INDEXER_URL'] || ''),
        apiKey: String(process.env[c + '_INDEXER_API_KEY'] || conf[c + '_INDEXER_API_KEY'] || '')
    };
}

/**
 * JSON-RPC over the node http/https core modules, matching AnchorProofClient._rpc and
 * HubClient._call. The indexer deliberately carries no HTTP client dependency and this read
 * sits on the block-processing path, so it does not get to add one.
 */
function _rpc(endpoint, method, params, timeoutMs){
    return new Promise((resolve, reject) => {
        const parsed  = urllib.parse(endpoint.url);
        const isHttps = parsed.protocol === 'https:';
        const lib     = isHttps ? https : http;
        const body    = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params });
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if(endpoint.apiKey) headers['x-api-key'] = endpoint.apiKey;
        const req = lib.request({
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname || '/',
            method:   'POST',
            headers:  headers,
            timeout:  timeoutMs
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const payload = JSON.parse(data);
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

/**
 * Rebuild the XCHECKPOINT v0 canonical for a mirrored state_checkpoints row. MUST byte-match
 * actions/anchor.js `_canonical` (FORMAT 0) and the hub's StateCheckpointEngine, which is why
 * the root suffix is appended UNCONDITIONALLY here too: anchor.js does it alone among the four
 * builders, deliberately, and recorded as D41 of the anchor-bundle spec. A gated suffix here
 * would reject every genuine mirrored checkpoint the fleet has signed.
 *
 * @param {Object} cp - a state_checkpoints row
 * @returns {string}
 */
function checkpointCanonical(cp){
    let base = ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    base += '|' + [String(cp.state_root || '').toLowerCase(), String(cp.state_root_version),
                   String(cp.block_merkle_root || '').toLowerCase(), String(cp.block_merkle_version)].join('|');
    const roundId = cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq;
    if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
    return base;
}

/**
 * Re-verify a mirrored checkpoint's own quorum against the capability snapshot at ITS OWN
 * snapshot_block. The CROSS_SETTLE rule verbatim, on the `oracle_publish` capability (the set
 * that signs checkpoints, not the `cross_chain` set that signs transfers): a signature counts
 * only if its pubkey is in the set AND verifies, a pubkey enters the seen-set only AFTER its
 * signature verifies, stake-weighted source-deduped two-thirds at or above
 * STAKE_WEIGHTED_QUORUM_ACTIVATION and 2f+1 below it.
 *
 * An ABSENT capability snapshot returns false, which drops the row from the candidate set and
 * therefore STALLS rather than refuses. That direction matters: treating an unreadable roster
 * as a pass would hand bridge_checkpoint_check an unverified root.
 *
 * @param {Object} cp - a state_checkpoints row
 * @param {Object} indexerDb
 * @returns {Promise<boolean>}
 */
async function verifyCheckpointQuorum(cp, indexerDb){
    const snapshotBlock = _height(cp.snapshot_block);
    if(snapshotBlock === null) return false;
    const weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, cp.network);
    const validators = weighted
        ? await indexerDb.getStakeWeightsByCapability('oracle_publish', snapshotBlock)
        : await indexerDb.getValidatorsByCapability('oracle_publish', snapshotBlock);
    const N = (validators && validators.length) ? validators.length : 0;
    if(N === 0) return false;

    let sigs;
    try { sigs = JSON.parse(cp.validator_signatures || '[]'); }
    catch(_){ sigs = []; }
    if(!Array.isArray(sigs)) return false;

    const canonical   = checkpointCanonical(cp);
    const snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
    const validSigners = [], seen = new Set();
    for(const s of sigs){
        const pk  = String((s && s.pubkey) || '').toLowerCase();
        const sig = String((s && s.sig) || '').toLowerCase();
        if(seen.has(pk)) continue;
        if(!/^[0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{128}$/.test(sig)) continue;
        if(!snapPubkeys.has(pk)) continue;
        if(!ed25519.verify(canonical, sig, pk)) continue;
        seen.add(pk);
        validSigners.push(pk);
    }
    return weighted
        ? swq.meetsStakeThreshold(validators, validSigners)
        : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
}

/**
 * Select the checkpoint this transfer is proven against, deterministically.
 *
 * THE RULE, and it is the one bridge_checkpoint_check.js's header names: the FIRST checkpoint
 * at or after row.snapshot_block for (row.src_chain, row.network), and at that height the
 * HIGHEST checkpoint_seq. "First at or after" and not "latest": a later checkpoint would also
 * commit the escrow credit, but "latest" is a moving target that differs on every node at every
 * instant, and the whole point of the rule is that two nodes holding the same rows pick the
 * same one. The highest seq at that height is the append-only table's own latest-wins rule
 * (state_checkpoints readers take MAX(checkpoint_seq); a reorged height is SUPERSEDED by a
 * higher seq rather than updated), so picking the lower seq would prove against a root the
 * federation itself has already replaced.
 *
 * Both sources are queried and the candidates are MERGED before the pick, rather than one
 * being preferred: a node that holds the anchor for height 105 and a mirrored row for 102 must
 * select 102, the same as a node that holds only the mirror, or "which source do I have" would
 * silently become an input to a consensus-visible verdict.
 *
 * @param {Object} row - the bridge_transfers row about to be applied
 * @param {Object} ctx - the settle-pass context { indexerDb, ... }
 * @returns {Promise<Object|null>} the checkpoint envelope member
 *          { chain, network, block_index, checkpoint_seq, snapshot_block, state_root,
 *            state_root_version, source }, or null when none is held locally (STALL)
 */
async function selectCheckpoint(row, ctx){
    const chain     = String(row.src_chain || '');
    const network   = String(row.network || '');
    const atOrAfter = _height(row.snapshot_block);
    if(!chain || !network || atOrAfter === null) return null;

    const db = ctx.indexerDb;
    const candidates = [];

    // Source 1: locally parsed ANCHOR v0 sections whose quorum this node verified at parse
    // time. status 'valid' ONLY: 'unverified' means this node had no capability snapshot and
    // stored the row without checking a signature, which is exactly the unverified checkpoint
    // the check must never be handed.
    let anchors = [];
    try {
        anchors = await db.doQuery(
            `SELECT a.chain, a.network, a.block_index, a.checkpoint_seq, a.snapshot_block,
                    a.state_root, a.state_root_version
             FROM anchor_actions a
             JOIN index_statuses s ON s.id = a.status_id
             WHERE a.version = ? AND a.chain = ? AND a.network = ? AND a.block_index >= ?
               AND a.state_root IS NOT NULL AND s.status = 'valid'
             ORDER BY a.block_index ASC, a.checkpoint_seq DESC
             LIMIT 1`,
            [ANCHOR_SECTION_VERSION, chain, network, atOrAfter]);
    } catch(e){
        // An unreadable table is an absence, which stalls. It is never a refusal.
        anchors = [];
    }
    for(const a of anchors)
        candidates.push({ chain: a.chain, network: a.network, block_index: _height(a.block_index),
                          checkpoint_seq: _height(a.checkpoint_seq), snapshot_block: _height(a.snapshot_block),
                          state_root: a.state_root, state_root_version: a.state_root_version,
                          source: 'anchor_actions' });

    // Source 2: the hub-mirrored state_checkpoints copy, re-verified here. More than one row is
    // read because the LOWEST qualifying height is what the rule wants and a row at that height
    // may fail re-verification, in which case the next candidate up is the honest pick rather
    // than a stall. Bounded, because this runs inside the block loop.
    let mirrored = [];
    try {
        mirrored = await db._mirrorDb().doQuery(
            `SELECT * FROM state_checkpoints
             WHERE chain = ? AND network = ? AND block_index >= ? AND state_root IS NOT NULL
             ORDER BY block_index ASC, checkpoint_seq DESC
             LIMIT 8`,
            [chain, network, atOrAfter]);
    } catch(e){
        mirrored = [];
    }
    for(const m of mirrored){
        if(!await verifyCheckpointQuorum(m, db)) continue;
        candidates.push({ chain: m.chain, network: m.network, block_index: _height(m.block_index),
                          checkpoint_seq: _height(m.checkpoint_seq), snapshot_block: _height(m.snapshot_block),
                          state_root: m.state_root, state_root_version: m.state_root_version,
                          source: 'state_checkpoints' });
        // One verified mirrored candidate at the lowest qualifying height is all the rule can
        // use; the rows are already ordered, so the first that verifies is that height's pick.
        break;
    }

    const usable = candidates.filter(c => c.block_index !== null && c.checkpoint_seq !== null);
    if(usable.length === 0) return null;
    usable.sort((a, b) => (a.block_index - b.block_index) || (b.checkpoint_seq - a.checkpoint_seq));
    return usable[0];
}

/**
 * Ask the ORIGIN chain's indexer for the escrow balance proof at the selected checkpoint's
 * height, and assemble the envelope bridge_checkpoint_check.js reads.
 *
 * The checkpoint member is attached HERE, from the checkpoint this node selected and
 * established itself. It is never taken from the served payload: a served checkpoint would let
 * whoever answers the RPC choose the root its own proof is measured against, which is the
 * forgery the whole cross-check exists to stop. The handler does serve one of its own, and
 * overwriting it is deliberate even though the two normally agree, because "normally" is not a
 * security property. It also serves its state_root_version STAMPED rather than re-derived, and
 * the replacement keeps that property: the version below is the one carried on the checkpoint
 * row this node selected, so the check's derived-versus-stamped comparison stays a real
 * binding instead of comparing a number to itself.
 *
 * @param {Object} row - the bridge_transfers row
 * @param {Object} ctx - the settle-pass context { config, indexerDb, ... }
 * @param {Object} checkpoint - the selection from selectCheckpoint
 * @param {string} escrowAddress - the escrow address this node resolved from the ORIGIN
 *                                 chain's own coin config (never the envelope's)
 * @returns {Promise<Object|null>} the proof envelope, or null when the answer is unusable
 */
async function fetchEscrowProof(row, ctx, checkpoint, escrowAddress){
    const endpoint = resolveOriginEndpoint(row.src_chain, ctx.config);
    if(!endpoint.url) return null;
    const timeoutMs = parseInt(process.env.BRIDGE_PROOF_TIMEOUT_MS || '15000', 10);

    // THE HEIGHT IS THE CHECKPOINT'S OWN, never row.snapshot_block and never a tip. The handler
    // builds its answer at the exact height given: it reads state_tree_roots there and proves
    // the key against that block's balances_root, so any other height would prove a balance the
    // selected checkpoint's state_root does not commit. It reads only {address, tick,
    // block_index}; `chain` and `network` ride along as intent, and are ignored there because
    // an indexer serves exactly one pair.
    let result = null;
    try {
        result = await _rpc(endpoint, 'getbridgeescrowproof', {
            chain:       String(row.src_chain),
            network:     String(row.network),
            block_index: checkpoint.block_index,
            address:     escrowAddress,
            tick:        String(row.tick)
        }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000);
    } catch(e){
        console.warn('\t XBRIDGE : getbridgeescrowproof unreachable on ' + row.src_chain + ': ' + (e && e.message));
        return null;
    }
    // An {error} answer is the handler saying it cannot PROVE the key at that height: no
    // checkpoint there, or state_tree_nodes pruned below retention. Both are properties of that
    // node's storage and not of the transfer, so both return null here and reach the caller as a
    // STALL. Reading either as a refusal would let one origin node's pruning decide, for this
    // whole chain, that a legitimate transfer is forged.
    if(!result || typeof result !== 'object' || result.error) return null;

    // sub_roots must arrive COMPLETE: the binding inside the check is a full reassembly to the
    // signed state_root, so a served payload that dropped a slot reassembles to a different
    // root and reads as a forgery. Nothing is filled in or defaulted here; a missing slot is
    // left missing and the check refuses, which is the visible failure the header asks for.
    const subRoots = result.sub_roots || result.subRoots;
    if(!subRoots || typeof subRoots !== 'object') return null;

    return {
        chain:         String(row.src_chain),
        network:       String(row.network),
        block_index:   checkpoint.block_index,
        sub_roots:     subRoots,
        address:       escrowAddress,
        tick:          String(row.tick),
        balance:       result.balance,
        balance_proof: result.balance_proof || result.balanceProof,
        checkpoint: {
            chain:              checkpoint.chain,
            network:            checkpoint.network,
            block_index:        checkpoint.block_index,
            checkpoint_seq:     checkpoint.checkpoint_seq,
            snapshot_block:     checkpoint.snapshot_block,
            state_root:         checkpoint.state_root,
            state_root_version: checkpoint.state_root_version
        }
    };
}

/**
 * Build the proof envelope for one transfer, or STALL.
 *
 * Every failure here raises BridgeProofUnavailableError. There is no path that returns "no
 * proof, refuse the row": see the header. The caller is expected to let the error escape the
 * pass so the block loop defers the block under BRIDGE_PROOF_BARRIER.
 *
 * @param {Object} row - the bridge_transfers row about to be applied
 * @param {Object} ctx - the settle-pass context { config, indexerDb, ... }
 * @param {string} escrowAddress - the escrow address resolved from the ORIGIN chain's config
 * @returns {Promise<Object>} the envelope for ctx.proof
 * @throws {BridgeProofUnavailableError}
 */
async function buildEscrowProof(row, ctx, escrowAddress){
    const checkpoint = await selectCheckpoint(row, ctx);
    if(!checkpoint)
        throw new BridgeProofUnavailableError(row.transfer_id, PROOF_STALL_REASON.NO_CHECKPOINT);

    const endpoint = resolveOriginEndpoint(row.src_chain, ctx.config);
    if(!endpoint.url)
        throw new BridgeProofUnavailableError(row.transfer_id, PROOF_STALL_REASON.NO_ENDPOINT);

    const proof = await fetchEscrowProof(row, ctx, checkpoint, escrowAddress);
    if(!proof)
        throw new BridgeProofUnavailableError(row.transfer_id, PROOF_STALL_REASON.UNREACHABLE);
    return proof;
}

module.exports = {
    buildEscrowProof,
    selectCheckpoint,
    fetchEscrowProof,
    verifyCheckpointQuorum,
    checkpointCanonical,
    resolveOriginEndpoint,
    BridgeProofUnavailableError,
    BRIDGE_PROOF_BARRIER,
    PROOF_STALL_REASON,
    ANCHOR_SECTION_VERSION,
};
