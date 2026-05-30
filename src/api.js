/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Indexer - API
 * 
 * This file parses in environmental variables and starts up the parsing API
 * 
 ********************************************************************/

// Load required libraries
const dotenv        = require('dotenv');
const express       = require('express');
const bodyParser    = require('body-parser');
const helmet        = require('helmet');
const cors          = require('cors');
const XChainIndexer = require('./XChainIndexer');
const jsonRouter    = require('express-json-rpc-router');

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

// xchain-utxo-tracker config (optional — required by DISPENSER fresh-address check)
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

// Hub database config (optional — local read-only copy of cross-chain data)
const HUB_DB_HOST = process.env.HUB_DB_HOST || '';
const HUB_DB_PORT = process.env.HUB_DB_PORT || '';
const HUB_DB_NAME = process.env.HUB_DB_NAME || '';
const HUB_DB_USER = process.env.HUB_DB_USER || '';
const HUB_DB_PASS = process.env.HUB_DB_PASS || '';

// Optional API key for write methods (e.g. hub→indexer reward pushes)
const INDEXER_API_KEY = process.env.INDEXER_API_KEY || '';

// Set of write methods that require the API key when one is configured
const WRITE_METHODS = new Set(['pushvalidatorrewards']);

// Set of federation read methods that require the API key when one is
// configured. These expose the staked validator set and the pending
// attestation work queue (including provider URLs queued for external
// fetch), so they are gated to authenticated federation callers only —
// preventing unauthenticated enumeration and attestation pre-fetch
// contamination. Hub callers attach the key via the x-api-key header.
const FEDERATION_READ_METHODS = new Set([
    'getownstake',
    'getactivevalidators',
    'getcapabilityvalidators',
    'getpendingattestation_requests'
]);

// Start up the API
async function startApi(){

    // Initialize the indexer (created before API so the controller can reference it)
    const indexer = new XChainIndexer(DECODER_DB_HOST, DECODER_DB_PORT, DECODER_DB_NAME, DECODER_DB_USER, DECODER_DB_PASS, INDEXER_DB_HOST, INDEXER_DB_PORT, INDEXER_DB_NAME, INDEXER_DB_USER, INDEXER_DB_PASS, HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, HUB_DB_USER, HUB_DB_PASS, UTXO_TRACKER_URL, UTXO_TRACKER_API_PORT);

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

    // API key enforcement for write + federation read methods
    app.use((req, res, next) => {
        if(!INDEXER_API_KEY) return next();
        let method = req.body && req.body.method;
        let normalized = method ? method.toLowerCase() : '';
        if(method && (WRITE_METHODS.has(normalized) || FEDERATION_READ_METHODS.has(normalized))){
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
                let stake = await indexer.indexerDb.getActiveStakeByPubkey(pk, blockIndex);
                return {
                    pubkey:      pk,
                    block_index: blockIndex,
                    amount:      stake ? stake.amount : '0',
                    has_stake:   !!stake
                };
            } catch (err) {
                console.error('getownstake error:', err && err.message ? err.message : err);
                return { error: 'failed to look up stake' };
            }
        },

        // Latest parsed block index. Used by xchain-hub's Consensus to
        // anchor its snapshot at a deterministic block boundary when the
        // hub's own chain-tip table is empty (no HUB_API_URL on the
        // indexer = no pushChainTip = no chain_tips rows).
        async getlatestblock(){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            try {
                let block_index = await indexer.indexerDb.getLatestBlockIndex();
                return { block_index: block_index };
            } catch (err) {
                console.error('getlatestblock error:', err && err.message ? err.message : err);
                return { error: 'failed to look up latest block' };
            }
        },

        // Whole-federation validator-set snapshot at a block boundary —
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
                    validators:  validators
                };
            } catch (err) {
                console.error('getactivevalidators error:', err && err.message ? err.message : err);
                return { error: 'failed to look up active validators' };
            }
        },

        // Return the validator-set snapshot for a capability at a block boundary.
        // Used by xchain-hub's CapabilitySnapshot to lock PBFT quorum N for a
        // consensus round. Deterministic — every hub at the same block sees
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
            try {
                let latestBlock = await indexer.indexerDb.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await indexer.indexerDb.getValidatorsByCapability(capability, blk, min_stake);
                return {
                    capability:  capability,
                    block_index: blk,
                    count:       validators.length,
                    validators:  validators
                };
            } catch (err) {
                console.error('getcapabilityvalidators error:', err && err.message ? err.message : err);
                return { error: 'failed to look up capability validators' };
            }
        },

        // List ATTEST v0 (request) rows currently awaiting validator fulfillment.
        // Used by xchain-hub's AttestationRound to discover work. Returns
        // latest_block_index alongside so the hub can compute its
        // confirmation-wait threshold (block_index + CONFIRMATIONS <= latest)
        // in a single round-trip without a follow-up getlatestblock call.
        // Body: { provider_id?: string, limit?: number }
        async getpendingattestation_requests({provider_id, limit}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            try {
                let latest  = await indexer.indexerDb.getLatestBlockIndex();
                let rows    = await indexer.indexerDb.getPendingAttestationRequests(provider_id, max);
                return {
                    latest_block_index: latest,
                    count:              rows.length,
                    requests:           rows
                };
            } catch (err) {
                console.error('getpendingattestation_requests error:', err && err.message ? err.message : err);
                return { error: 'failed to look up pending attestation requests' };
            }
        },

        // Receive validator reward records pushed from xchain-hub after a finalized oracle round
        // Body: { round, reward_type, block_index, rewards: [{pubkey, amount}, ...] }
        async pushvalidatorrewards({round, reward_type, block_index, rewards}){
            if(round === undefined || round === null)
                return { error: 'round is required' };
            if(!Array.isArray(rewards))
                return { error: 'rewards must be an array' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let type = reward_type || 'oracle_round';
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
                    console.error('pushvalidatorrewards: error writing reward for ' + r.pubkey + ':', err.message);
                    skipped++;
                }
            }
            return { status: 'success', written: written, skipped: skipped };
        }

    };

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}));

    // Start the server
    app.listen(INDEXER_API_PORT, () => {
      console.log('API listening on port ' + INDEXER_API_PORT);
    });

    // Start the Indexer (trap any errors and log them before exiting the indexer)
    indexer.start().catch((error) => {
        console.error('Fatal indexer error:', error);
        process.exit(1);
    });

}

startApi();