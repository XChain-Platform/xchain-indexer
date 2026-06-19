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
 * XChain Indexer - API
 * 
 * This file parses in environmental variables and starts up the parsing API
 * 
 ********************************************************************/

// Load required libraries
// Note: express-rate-limit is intentionally omitted; the indexer API is
// internal-only (hub + xchain-node managed deployments) and is expected to
// sit behind a network perimeter or INDEXER_API_KEY auth gate rather than
// being exposed directly. Add rate limiting here if this API is ever
// publicly accessible (see sibling services: decoder, encoder, explorer, hub).
const dotenv        = require('dotenv');
const express       = require('express');
const bodyParser    = require('body-parser');
const helmet        = require('helmet');
const cors          = require('cors');
const XChainIndexer = require('./XChainIndexer');
const jsonRouter    = require('express-json-rpc-router');
const { buildHealthResponse } = require('./health');
const { getStakeSourceByPubkey } = require('./stake-source');
const merkle        = require('./merkle');

// Parse in .env config data
dotenv.config();

// Validate required environment variables
const REQUIRED_ENV = [
    'DECODER_DB_HOST','DECODER_DB_PORT','DECODER_DB_NAME','DECODER_DB_USER','DECODER_DB_PASS',
    'INDEXER_DB_HOST','INDEXER_DB_PORT','INDEXER_DB_NAME','INDEXER_DB_USER','INDEXER_DB_PASS'
];
for(const key of REQUIRED_ENV){
    if(!process.env[key]){
        console.error('Missing required environment variable: ' + key);
        process.exit(1);
    }
}

// Parse in the environmental variables
const INDEXER_API_PORT = process.env.INDEXER_API_PORT;
const INDEXER_NETWORK  = process.env.INDEXER_NETWORK;

// xchain-utxo-tracker config (optional, required by DISPENSER fresh-address check)
const UTXO_TRACKER_URL      = process.env.UTXO_TRACKER_URL || '';
const UTXO_TRACKER_API_PORT = process.env.UTXO_TRACKER_API_PORT || '';

// Decoder database config
const DECODER_DB_HOST  = process.env.DECODER_DB_HOST;
const DECODER_DB_PORT  = process.env.DECODER_DB_PORT;
const DECODER_DB_NAME  = process.env.DECODER_DB_NAME;
const DECODER_DB_USER  = process.env.DECODER_DB_USER;
const DECODER_DB_PASS  = process.env.DECODER_DB_PASS;

// Indexer database config
const INDEXER_DB_HOST  = process.env.INDEXER_DB_HOST;
const INDEXER_DB_PORT  = process.env.INDEXER_DB_PORT;
const INDEXER_DB_NAME  = process.env.INDEXER_DB_NAME;
const INDEXER_DB_USER  = process.env.INDEXER_DB_USER;
const INDEXER_DB_PASS  = process.env.INDEXER_DB_PASS;

// Hub database config (optional, local read-only copy of cross-chain data)
const HUB_DB_HOST = process.env.HUB_DB_HOST || '';
const HUB_DB_PORT = process.env.HUB_DB_PORT || '';
const HUB_DB_NAME = process.env.HUB_DB_NAME || '';
const HUB_DB_USER = process.env.HUB_DB_USER || '';
const HUB_DB_PASS = process.env.HUB_DB_PASS || '';

// API key for write + federation read methods (e.g. hub→indexer reward pushes).
// Optional, matching .env.example: unset disables the gate (single-host /
// regtest); when configured, the gated methods fail closed (401) without a
// valid key. Hard-requiring it at boot crash-looped every xchain-node-managed
// deployment (ConfigService injects no such var); the same over-tightening
// that took down the encoder pre-launch (see xchain-encoder e2bf7c4).
const INDEXER_API_KEY = process.env.INDEXER_API_KEY || '';
if(!INDEXER_API_KEY)
    console.warn('WARNING: INDEXER_API_KEY is not set; write and federation-read methods are UNAUTHENTICATED. Set a key for any shared deployment.');

// Set of write methods that require the API key when one is configured
const WRITE_METHODS = new Set(['pushvalidatorrewards']);

// Set of federation read methods that require the API key when one is
// configured. These expose the staked validator set and the pending
// attestation work queue (including provider URLs queued for external
// fetch), so they are gated to authenticated federation callers only;
// preventing unauthenticated enumeration and attestation pre-fetch
// contamination. Hub callers attach the key via the x-api-key header.
const FEDERATION_READ_METHODS = new Set([
    'getownstake',
    'getactivevalidators',
    'getactivestakeweights',
    'getcapabilityvalidators',
    'getstakeweightsbycapability',
    'getstakesourcebypubkey',
    'getfullnodeverifiers',
    'getpendingattestation_requests',
    'getopencrosschainorders',
    'getactionconfirmations',
    'getpendingcrosschaincalls',
    'getcrosschaincall',
    'getcrosschaincallresult'
]);

// Start up the API
async function startApi(){

    // Initialize the indexer (created before API so the controller can reference it)
    const indexer = new XChainIndexer(DECODER_DB_HOST, DECODER_DB_PORT, DECODER_DB_NAME, DECODER_DB_USER, DECODER_DB_PASS, INDEXER_DB_HOST, INDEXER_DB_PORT, INDEXER_DB_NAME, INDEXER_DB_USER, INDEXER_DB_PASS, HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, HUB_DB_USER, HUB_DB_PASS, UTXO_TRACKER_URL, UTXO_TRACKER_API_PORT);

    // Track indexer liveness so the health endpoint can report it (the indexer
    // process exits on a fatal error, but the flag still distinguishes a clean
    // run from one tearing down).
    let indexerRunning = true;
    let indexerError   = null;

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // Allow CORS (restricted to configured origin, defaults to localhost)
    app.use(cors({
        origin: process.env.CORS_ORIGIN || 'http://localhost',
        methods: ['POST']
    }));

    // API key enforcement for write + federation read methods. Enforced only
    // when a key is configured (matching .env.example): with INDEXER_API_KEY
    // set, these methods fail closed without a valid x-api-key; unset disables
    // the gate (single-host / regtest; no key plumbing exists in xchain-node
    // or the hub callers yet, so failing closed with no key 401'd every
    // federation read fleet-wide). Production deployments should set a key.
    app.use((req, res, next) => {
        let method = req.body && req.body.method;
        let normalized = method ? method.toLowerCase() : '';
        if(method && INDEXER_API_KEY && (WRITE_METHODS.has(normalized) || FEDERATION_READ_METHODS.has(normalized))){
            let provided = req.headers['x-api-key'] || '';
            if(provided !== INDEXER_API_KEY){
                return res.status(401).json({
                    jsonrpc: '2.0', id: req.body.id || null,
                    error: { code: -32001, message: 'Unauthorized' }
                });
            }
        }
        next();
    });

    const jsonRpcController = {

        // Handle returning a success response to ping requests
        async ping(){
            return { status: "success" };
        },

        // Health check that reports actual indexer state. ping only confirms the
        // HTTP server is up; this surfaces sync progress plus the circuit-breaker
        // state of BOTH database connections so an operator can tell a healthy,
        // syncing indexer apart from one silently stalled at an open circuit after
        // a database outage (the breaker trips after repeated connection failures).
        async health(){
            let lastIndexedBlock = null;
            try {
                if(indexer.indexerDb)
                    lastIndexedBlock = await indexer.indexerDb.getLatestBlockIndex();
            } catch (err) {
                // Database unreachable; leave lastIndexedBlock null. The circuit
                // state below tells the operator why.
            }
            return buildHealthResponse({
                indexer, indexerRunning, indexerError, lastIndexedBlock, now: Date.now()
            });
        },

        // Look up the active stake amount + latest block index for a single pubkey.
        // Used by xchain-hub's CapabilityRegistry to keep its own qualification
        // state in sync with on-chain stake without needing direct DB access.
        // Body: { pubkey }
        async getownstake({pubkey}){
            if(!pubkey || !/^[0-9a-fA-F]{64}$/.test(String(pubkey)))
                return { error: 'pubkey must be a 64-char hex string' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let pk = String(pubkey).toLowerCase();
            try {
                let blockIndex = await indexer.indexerDb.getLatestBlockIndex();
                // Effective-set view (direct stake minus revocations, plus delegated-key
                // resolution) so a delegation-only hub self-qualifies in step with the
                // federation. This is the federation-read-only consumer; consensus handlers
                // use getActiveStakeByPubkey (direct stake ownership) instead.
                let stake = await indexer.indexerDb.getEffectiveStakeByPubkey(pk, blockIndex);
                return {
                    pubkey:      pk,
                    block_index: blockIndex,
                    amount:      stake ? stake.amount : '0',
                    has_stake:   !!stake
                };
            } catch (err) {
                console.error('getownstake error:', err);
                return { error: 'failed to look up stake' };
            }
        },

        // Latest parsed block index. Used by xchain-hub's Consensus to
        // anchor its snapshot at a deterministic block boundary when the
        // hub's own chain-tip table is empty (no HUB_API_URL on the
        // indexer = no pushChainTip = no chain_tips rows).
        // Also exposes the decoder's current tip and a sync-status flag so
        // operators can see the indexer→decoder lag in a single call.
        async getlatestblock(){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            try {
                let block_index = await indexer.indexerDb.getLatestBlockIndex();
                return {
                    block_index,
                    decoder_block: indexer.lastDecoderBlock,
                    lag: indexer.lastDecoderBlock != null
                        ? indexer.lastDecoderBlock - block_index
                        : null,
                };
            } catch (err) {
                console.error('getlatestblock error:', err);
                return { error: 'failed to look up latest block' };
            }
        },

        // The stored per-block state-hash triple (+ the chain block hash from the
        // decoder DB) for a height; what the hub's StateCheckpointEngine reads,
        // independently re-fetches on every peer, and quorum-signs into the
        // XCHECKPOINT canonical (spec: protocol/actions/ANCHOR.md). Omitting
        // block_index returns the latest indexed block. Public read: these hashes
        // are the platform's verifiability primitive, not sensitive state.
        async getblockhashes({block_index}){
            if(!indexer.indexerDb || !indexer.decoderDb)
                return { error: 'indexer database not ready' };
            try {
                let target = (block_index !== undefined && block_index !== null)
                    ? Number(block_index)
                    : await indexer.indexerDb.getLatestBlockIndex();
                if(!Number.isFinite(target) || target < 0)
                    return { error: 'invalid block_index' };
                let stored = await indexer.indexerDb.getStoredBlockHashes(target);
                if(!stored)
                    return { error: 'block not indexed: ' + target };
                let blockHash = null;
                let rows = await indexer.decoderDb.doQuery(
                    'SELECT t.hash AS block_hash FROM blocks b ' +
                    'LEFT JOIN index_transactions t ON (t.id = b.block_hash_id) WHERE b.block_index = ? LIMIT 1',
                    [target]);
                if(rows.length > 0 && rows[0].block_hash) blockHash = String(rows[0].block_hash);
                return {
                    coin:          indexer.config['COIN'],
                    network:       indexer.config['NETWORK'],
                    block_index:   Number(stored.block_index),
                    block_time:    (stored.block_time != null) ? Number(stored.block_time) : null,
                    block_hash:    blockHash,
                    ledger_hash:   stored.ledger_hash   || null,
                    actions_hash:  stored.actions_hash  || null,
                    contract_hash: stored.contract_hash || null,
                    // Additive light-client roots (SPV spec §4/§5): null before the
                    // STATE_COMMITMENT flag-day, present after. Phase 2's checkpoint
                    // engine signs over state_root + block_merkle_root. The version
                    // bytes travel WITH their root (the frozen merkle.js scheme
                    // version under which the stored root was computed) so the hub
                    // signs root+version as a unit; null whenever the root is null.
                    balances_root:        stored.balances_root     || null,
                    stakes_root:          stored.stakes_root       || null,
                    state_root:           stored.state_root        || null,
                    state_root_version:   stored.state_root        ? merkle.STATE_ROOT_VERSION   : null,
                    block_merkle_root:    stored.block_merkle_root || null,
                    block_merkle_version: stored.block_merkle_root ? merkle.BLOCK_MERKLE_VERSION : null
                };
            } catch (err) {
                console.error('getblockhashes error:', err);
                return { error: 'failed to look up block hashes' };
            }
        },

        // Read-only native-coin fee pre-flight. Given an action + its wire params (and
        // optionally a proposed FEE_DESTINATION output value in satoshis), value the action's
        // XCHAIN protocol fee in the native coin at current oracle prices and judge a proposed
        // output against the on-chain tolerance, WITHOUT persisting anything. Lets a client size
        // the fee output and refuse to broadcast a doomed (under-sized / stale-priced) native-fee
        // tx, which would otherwise forfeit the fee. Public read (surfaced to wallets/SDK via the
        // explorer proxy); not a write or federation method.
        // Body: { action, params, source, feeOutputSats? }
        async feequote({action, params, source, feeOutputSats}){
            if(!action || typeof action !== 'string')
                return { error: 'action is required' };
            if(!indexer.indexerDb || !indexer.actions)
                return { error: 'indexer not ready' };
            try {
                return await indexer.actions.computeFeeQuote({ action, params, source, feeOutputSats });
            } catch (err) {
                console.error('feequote error:', err);
                return { error: 'failed to compute fee quote' };
            }
        },

        // OPT-IN phase-2 dry-run: runs the REAL action handler against current state inside a
        // forced-rollback transaction and returns authoritative { valid, error, status } for ANY
        // action (feequote's estimator only covers the create-action subset). Native-fee sizing is
        // merged in from computeFeeQuote. Never persists. See computeFeeQuoteDryRun for the trial
        // caveat (AUTO_INCREMENT skew); intended for an isolated regtest indexer for now.
        // Body: { action, params, source, feeOutputs? }
        async feequotedryrun({action, params, source, feeOutputs}){
            if(!action || typeof action !== 'string')
                return { error: 'action is required' };
            if(!indexer.indexerDb || !indexer.actions)
                return { error: 'indexer not ready' };
            try {
                return await indexer.actions.computeFeeQuoteDryRun({ action, params, source, feeOutputs });
            } catch (err) {
                console.error('feequotedryrun error:', err);
                return { error: 'dry-run failed: ' + ((err && err.message) ? err.message : String(err)) };
            }
        },

        // Read-only native-coin fee schedule + current oracle prices. Lets a client display the
        // gas schedule / tolerance band and rough-estimate a native fee before a per-action
        // feequote. Public read (surfaced to wallets/SDK via the explorer proxy).
        async feeschedule(){
            if(!indexer.indexerDb || !indexer.actions)
                return { error: 'indexer not ready' };
            try {
                return await indexer.actions.getFeeSchedule();
            } catch (err) {
                console.error('feeschedule error:', err);
                return { error: 'failed to fetch fee schedule' };
            }
        },

        // Whole-federation validator-set snapshot at a block boundary:
        // every pubkey with ANY active stake at the block, regardless of
        // capability. Used by xchain-hub's Consensus (config-change PBFT)
        // where quorum is over all stakers, not a capability subset.
        // Body: { block_index }
        async getactivevalidators({block_index}){
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            try {
                let latestBlock = await indexer.indexerDb.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await indexer.indexerDb.getActiveValidators(blk);
                return {
                    block_index: blk,
                    count:       validators.length,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:   validators.truncated === true,
                    validators:  validators
                };
            } catch (err) {
                console.error('getactivevalidators error:', err);
                return { error: 'failed to look up active validators' };
            }
        },

        // Source-keyed whole-federation weights at a block boundary; every staker
        // (no capability filter, no MIN_STAKE floor) with each effective key's
        // `source` + the source's aggregate `weight`. The STAKE_WEIGHTED_QUORUM
        // counterpart of getactivevalidators; used by xchain-hub's Consensus
        // (config-change PBFT) to weight governance quorum by stake.
        // Body: { block_index }
        async getactivestakeweights({block_index}){
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            try {
                let latestBlock = await indexer.indexerDb.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await indexer.indexerDb.getActiveStakeWeights(blk);
                let sources = new Set(validators.map(v => v.source));
                return {
                    block_index:  blk,
                    count:        validators.length,
                    source_count: sources.size,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:    validators.truncated === true,
                    validators:   validators
                };
            } catch (err) {
                console.error('getactivestakeweights error:', err);
                return { error: 'failed to look up active stake weights' };
            }
        },

        // Return the validator-set snapshot for a capability at a block boundary.
        // Used by xchain-hub's CapabilitySnapshot to lock PBFT quorum N for a
        // consensus round. Deterministic: every hub at the same block sees
        // the same set, so all hubs compute the same quorum.
        // Body: { capability, block_index, min_stake? }
        // min_stake (optional) lets a caller (the hub) supply its own authoritative
        // threshold so the validator set doesn't depend on this indexer's local
        // config. Omitted → indexer falls back to its local config (back-compat).
        async getcapabilityvalidators({capability, block_index, min_stake}){
            if(!capability || typeof capability !== 'string')
                return { error: 'capability is required' };
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // A capability absent from this indexer's STAKING.CAPABILITIES config would
            // otherwise produce an empty validator set indistinguishable from "no
            // qualified validators at this block". Surface it as an error so the hub's
            // CapabilitySnapshot treats it as a null snapshot (degraded mode) and the
            // operator gets a signal of config drift instead of a silent attestation drop.
            if(!indexer.indexerDb.isCapabilityConfigured(capability))
                return { error: 'capability not configured: ' + capability };
            try {
                let latestBlock = await indexer.indexerDb.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await indexer.indexerDb.getValidatorsByCapability(capability, blk, min_stake);
                // Confirm which threshold this snapshot actually filtered by, so a
                // hub↔indexer MIN_STAKE mismatch is visible in the indexer log
                // rather than surfacing only as a silently-divergent quorum N.
                let thresholdSource = (min_stake !== undefined && min_stake !== null)
                    ? String(min_stake) + ' (caller-supplied)'
                    : 'local-config';
                console.log('getcapabilityvalidators: capability=' + capability +
                    ' block=' + blk + ' min_stake=' + thresholdSource +
                    ' validators=' + validators.length);
                return {
                    capability:  capability,
                    block_index: blk,
                    count:       validators.length,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:   validators.truncated === true,
                    validators:  validators
                };
            } catch (err) {
                console.error('getcapabilityvalidators error:', err);
                return { error: 'failed to look up capability validators' };
            }
        },

        // Verified full-node set at a block (NODEPROOF / verified-validator tier):
        // validators with a passed possession proof inside PROOF_WINDOW_BLOCKS of
        // `block_index`. The hub unions this with FULLNODE.GENESIS_VERIFIERS to form
        // the eligible-verifier set for a challenge round, matching the indexer's
        // acceptance rule in actions/nodeproof.js. (Live-stake intersection is the
        // caller's via the capability snapshot.)
        async getfullnodeverifiers({block_index}){
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            try {
                // Intersect the proof-window set with the LIVE full_node capability
                // at this block (byte-identical to the eligibility rule in
                // actions/nodeproof.js (_eligibleVerifierSet) and the reward split in
                // actions/price.js, so the hub sizes quorum over the same set the
                // chain will accept.
                let raw = await indexer.indexerDb.getVerifiedFullNodeSet(blk);
                let validators = [];
                for(let v of raw){
                    if(await indexer.indexerDb.hasCapability(v.pubkey, 'full_node', blk))
                        validators.push(v);
                }
                return {
                    block_index: blk,
                    count:       validators.length,
                    validators:  validators
                };
            } catch (err) {
                console.error('getfullnodeverifiers error:', err);
                return { error: 'failed to look up full-node verifiers' };
            }
        },

        // Source-keyed validator weights for stake-weighted quorum (STAKE_WEIGHTED_QUORUM).
        // Like getcapabilityvalidators but returns each effective signing key's `source`
        // (staking address) + the source's aggregate `weight`. The hub mirrors these into
        // capability_snapshots so every validator dedupes voting weight by source; one
        // stake counts once no matter how many keys it has delegated (DELEGATE.md).
        async getstakeweightsbycapability({capability, block_index, min_stake}){
            if(!capability || typeof capability !== 'string')
                return { error: 'capability is required' };
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!indexer.indexerDb.isCapabilityConfigured(capability))
                return { error: 'capability not configured: ' + capability };
            try {
                let latestBlock = await indexer.indexerDb.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await indexer.indexerDb.getStakeWeightsByCapability(capability, blk, min_stake);
                let sources = new Set(validators.map(v => v.source));
                let thresholdSource = (min_stake !== undefined && min_stake !== null)
                    ? String(min_stake) + ' (caller-supplied)'
                    : 'local-config';
                console.log('getstakeweightsbycapability: capability=' + capability +
                    ' block=' + blk + ' min_stake=' + thresholdSource +
                    ' keys=' + validators.length + ' sources=' + sources.size);
                return {
                    capability:  capability,
                    block_index: blk,
                    count:       validators.length,
                    source_count: sources.size,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:   validators.truncated === true,
                    validators:  validators
                };
            } catch (err) {
                console.error('getstakeweightsbycapability error:', err);
                return { error: 'failed to look up stake weights' };
            }
        },

        // List ATTEST v0 (request) rows currently awaiting validator fulfillment.
        // Used by xchain-hub's AttestationRound to discover work. Returns
        // latest_block_index alongside so the hub can compute its
        // confirmation-wait threshold (block_index + CONFIRMATIONS <= latest)
        // in a single round-trip without a follow-up getlatestblock call.
        // Body: { provider_id?: string, limit?: number,
        //         after_block_index?: number, after_action_index?: number }
        //   The after_* pair is a keyset cursor for paging past the oldest
        //   `limit` rows (see getPendingAttestationRequests).
        async getpendingattestation_requests({provider_id, limit, after_block_index, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            // Optional keyset cursor: caller pages forward by passing the last
            // (block_index, action_index) it consumed. Only honoured when both
            // components are present and finite; otherwise a full sweep is returned.
            let cursor = null;
            if(Number.isFinite(Number(after_block_index)) && Number.isFinite(Number(after_action_index))){
                cursor = { after_block_index, after_action_index };
            }
            try {
                let latest  = await indexer.indexerDb.getLatestBlockIndex();
                let rows    = await indexer.indexerDb.getPendingAttestationRequests(provider_id, max, cursor);
                return {
                    latest_block_index: latest,
                    count:              rows.length,
                    requests:           rows
                };
            } catch (err) {
                console.error('getpendingattestation_requests error:', err);
                return { error: 'failed to look up pending attestation requests' };
            }
        },

        // Return this chain's OPEN cross-chain DEX offers (give_coin != get_coin) so the
        // xchain-hub federation can build the unified cross-chain order book. The "from"
        // chain is implicit (this indexer's COIN). Paginates by keyset on action_index.
        // Returns the latest block in the same round-trip so the federation can snapshot
        // its matching view without a follow-up getlatestblock.
        async getopencrosschainorders({to_coin, limit, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            try {
                let latest = await indexer.indexerDb.getLatestBlockIndex();
                // Unified cross-chain book: SWAP offers (Phase A, exact single-fill) + ORDER
                // offers (Phase B, price-time partial fills). Each is tagged with `kind`.
                let swaps  = await indexer.indexerDb.getOpenCrossChainSwaps(max, after_action_index, to_coin);
                let orders = await indexer.indexerDb.getOpenCrossChainOrders(max, after_action_index, to_coin);
                let merged = swaps.concat(orders);
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              merged.length,
                    orders:             merged
                };
            } catch (err) {
                console.error('getopencrosschainorders error:', err);
                return { error: 'failed to look up cross-chain orders' };
            }
        },

        // Pending XCALL v0 (cross-chain call request) rows awaiting federation
        // dispatch. Used by xchain-hub's CrossChainCallEngine to discover work;
        // the hub confirmation-gates on (block_index, latest_block_index) and
        // dedupes against its own cross_chain_calls table.
        // Body: { limit?: number }
        async getpendingcrosschaincalls({limit}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            try {
                let latest = await indexer.indexerDb.getLatestBlockIndex();
                let rows   = await indexer.indexerDb.getPendingCrossChainCallRequests(max);
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              rows.length,
                    calls:              rows
                };
            } catch (err) {
                console.error('getpendingcrosschaincalls error:', err);
                return { error: 'failed to look up pending cross-chain calls' };
            }
        },

        // Single XCALL request by call_id; the targeted re-verification a hub
        // follower runs before co-signing a leader's proposed dispatch row
        // (field-for-field, against its OWN view of this chain).
        // Body: { call_id }
        async getcrosschaincall({call_id}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!call_id || !/^[0-9a-fA-F]{64}$/.test(String(call_id)))
                return { error: 'call_id must be a 64-hex id' };
            try {
                let latest = await indexer.indexerDb.getLatestBlockIndex();
                let row    = await indexer.indexerDb.getCrossChainCallRequestById(String(call_id));
                if(!row){
                    return { exists: false, network: indexer.config['NETWORK'], latest_block_index: latest };
                }
                return {
                    exists:             true,
                    network:            indexer.config['NETWORK'],
                    latest_block_index: latest,
                    call: {
                        call_id:               row.call_id,
                        action_index:          Number(row.action_index),
                        block_index:           Number(row.block_index),
                        source_contract_index: Number(row.contract_index),
                        target_chain:          row.target_chain,
                        target_contract_index: Number(row.target_contract_index),
                        method:                row.method,
                        params_json:           row.params_json,
                        gas_limit:             Number(row.gas_limit),
                        cross_hops:            Number(row.cross_hops),
                        deadline_block:        Number(row.deadline_block),
                        request_status:        row.request_status
                    }
                };
            } catch (err) {
                console.error('getcrosschaincall error:', err);
                return { error: 'failed to look up cross-chain call' };
            }
        },

        // Execution outcome of an injected cross-chain call on THIS (target) chain.
        // Used by the hub to relay the result back to the source chain, and by hub
        // followers to re-verify a proposed result row byte-for-byte.
        // Body: { call_id }
        async getcrosschaincallresult({call_id}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!call_id || !/^[0-9a-fA-F]{64}$/.test(String(call_id)))
                return { error: 'call_id must be a 64-hex id' };
            try {
                let latest = await indexer.indexerDb.getLatestBlockIndex();
                let row    = await indexer.indexerDb.getCrossChainCallExecutionById(String(call_id));
                if(!row){
                    return { exists: false, network: indexer.config['NETWORK'], latest_block_index: latest };
                }
                return {
                    exists:               true,
                    network:              indexer.config['NETWORK'],
                    latest_block_index:   latest,
                    executed_block_index: Number(row.block_index),
                    status:               row.result_status,
                    return_payload_b64:   row.return_payload_b64 || '',
                    gas_used:             Number(row.gas_used)
                };
            } catch (err) {
                console.error('getcrosschaincallresult error:', err);
                return { error: 'failed to look up cross-chain call result' };
            }
        },

        // Existence + confirmation depth for a single action. Lets the xchain-hub
        // federation verify that a proposed cross-chain source action really exists
        // on this chain (and how deep it is buried) before co-signing an
        // attestation, instead of trusting the proposer's claim. Returns the latest
        // indexed block in the same round-trip so depth and tip are one snapshot.
        // Body: { action_index }
        async getactionconfirmations({action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let idx = Number(action_index);
            if(!Number.isInteger(idx) || idx <= 0)
                return { error: 'action_index must be a positive integer' };
            try {
                let latest = await indexer.indexerDb.getLatestBlockIndex();
                let row    = await indexer.indexerDb.getActionInfo(idx);
                if(!row){
                    return {
                        coin:               indexer.config['COIN'],
                        network:            indexer.config['NETWORK'],
                        action_index:       idx,
                        exists:             false,
                        latest_block_index: latest,
                        confirmations:      0
                    };
                }
                let blockIndex = Number(row.block_index);
                return {
                    coin:               indexer.config['COIN'],
                    network:            indexer.config['NETWORK'],
                    action_index:       idx,
                    exists:             true,
                    action:             row.action,
                    block_index:        blockIndex,
                    latest_block_index: latest,
                    confirmations:      (latest >= blockIndex) ? (latest - blockIndex + 1) : 0
                };
            } catch (err) {
                console.error('getactionconfirmations error:', err);
                return { error: 'failed to look up action confirmations' };
            }
        },

        // Receive validator reward records pushed from xchain-hub (anchor publish
        // rails only). oracle_round and attest_fee are DERIVED deterministically
        // during block processing; accepting a push for them would let a stale
        // hub race the derivation and open a replay-divergence window, so they
        // are rejected outright.
        // Body: { round, reward_type, block_index, rewards: [{pubkey, amount}, ...] }
        async pushvalidatorrewards({round, reward_type, block_index, rewards}){
            if(round === undefined || round === null)
                return { error: 'round is required' };
            if(!Array.isArray(rewards))
                return { error: 'rewards must be an array' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let type = reward_type || 'oracle_round';
            if(!/^anchor_[A-Za-z_]+$/.test(type))
                return { error: 'reward_type ' + type + ' is not pushable (derived during block processing)' };
            let blockIdx = block_index || 0;
            let written = 0;
            let skipped = 0;
            for(let r of rewards){
                if(!r || !r.pubkey || !r.amount){ skipped++; continue; }
                try {
                    let ok = await indexer.indexerDb.createValidatorReward(r.pubkey, round, type, r.amount, blockIdx);
                    if(ok) written++;
                    else skipped++;
                } catch (err) {
                    console.error('pushvalidatorrewards: error writing reward for ' + r.pubkey + ':', err);
                    skipped++;
                }
            }
            // Replace-on-push for anchor rewards: one logical anchor → exactly
            // one winner. Collapse any failover-race duplicates to the
            // deterministic (smallest-pubkey) winner so a loser row pushed to
            // this indexer can't survive as a phantom COLLECT-claimable reward
            // or diverge the recovery ledger hash (#3963).
            if(written > 0 && /^anchor_[A-Za-z_]+$/.test(type)){
                try {
                    let removed = await indexer.indexerDb.reconcileAnchorRewardWinner(round, type);
                    if(removed > 0)
                        console.log('pushvalidatorrewards: retracted ' + removed + ' superseded anchor reward(s) for ' + type + ' #' + round + ' (kept deterministic winner)');
                } catch (err) {
                    console.warn('pushvalidatorrewards: anchor reconciliation failed for ' + type + ' #' + round + ':', err && err.message);
                }
            }
            return { status: 'success', written: written, skipped: skipped };
        },

        // Resolve the staking source address that owned/delegated a signing
        // pubkey as of a block; stakes first, then DELEGATE v0 delegations
        // (same order as createValidatorReward). Block-scoped so every caller
        // gets the same answer at any time: the hub archive builder pins this
        // earn-time source into the ANCHOR archive, and follower hubs
        // re-resolve it before co-signing.
        // Body: { pubkey, block_index }. Logic lives in ./stake-source so it can
        // be unit-tested without standing up the Express/JSON-RPC stack.
        async getstakesourcebypubkey({pubkey, block_index}){
            return getStakeSourceByPubkey(indexer, { pubkey, block_index });
        }

    };

    // Plain REST status endpoint for monitoring tools that poll over a simple
    // GET: uptime checks, container liveness/readiness probes, and load-balancer
    // health checks that cannot speak the JSON-RPC envelope the methods above
    // require. Surfaces the indexer's current block height, the decoder's current
    // tip, the computed indexer→decoder lag, and the sync flag, so quantitative
    // lag is readable from the public API surface without direct database access.
    // The indexer block is read fresh from the DB (same source as the `health`
    // method) so it never reports a stale in-memory counter.
    app.get('/status', async (req, res) => {
        let indexerBlock = null;
        try {
            if(indexer.indexerDb)
                indexerBlock = await indexer.indexerDb.getLatestBlockIndex();
        } catch (err) {
            // Database unreachable; leave indexerBlock null so lag stays null
            // rather than reporting a misleading figure.
        }
        let decoderBlock = null;
        try {
            if(indexer.decoderDb)
                decoderBlock = await indexer.decoderDb.getBlockIndex('decoder', 'last');
            if(decoderBlock != null) decoderBlock = Number(decoderBlock);
        } catch (err) {
            // Database unreachable; use in-memory snapshot as fallback
            decoderBlock = (indexer.lastDecoderBlock != null) ? Number(indexer.lastDecoderBlock) : null;
        }
        // Age of the last successful hub-config fetch (null until the first success). A
        // climbing age here while the indexer otherwise looks synced is the signal that
        // the hub is unreachable and the live-polled governance params are stale.
        let lastHubConfigFetchAt = indexer.lastHubConfigFetchAt || null;
        let hubConfigAgeSeconds  = (lastHubConfigFetchAt != null)
                                    ? Math.floor((Date.now() - lastHubConfigFetchAt) / 1000)
                                    : null;
        res.json({
            indexerBlock: indexerBlock,
            decoderBlock: decoderBlock,
            lag:          (decoderBlock != null && indexerBlock != null)
                            ? decoderBlock - indexerBlock
                            : null,
            isSynced:     indexer.isSynced(),
            // Why the block counter is not advancing, or null when advancing normally:
            // a hub-sync barrier timeout (price/oracle/match/call/snapshot) or a VM
            // executor host fault. Lets a monitoring probe tell these stalls apart from
            // a healthy catch-up, all of which otherwise present only as a growing lag.
            stallReason:  indexer.stallReason || null,
            lastHubConfigFetchAt: lastHubConfigFetchAt,
            hubConfigAgeSeconds:  hubConfigAgeSeconds
        });
    });

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}));

    // Start the server
    app.listen(INDEXER_API_PORT, () => {
      console.log('API listening on port ' + INDEXER_API_PORT);
    });

    // Start the Indexer (trap any errors and log them before exiting the indexer)
    indexer.start().catch((error) => {
        console.error('Fatal indexer error:', error);
        indexerRunning = false;
        indexerError   = error;
        process.exit(1);
    });

}

startApi();