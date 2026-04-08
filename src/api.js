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

// Start up the API
async function startApi(){

    // Initialize the indexer (created before API so the controller can reference it)
    const indexer = new XChainIndexer(DECODER_DB_HOST, DECODER_DB_PORT, DECODER_DB_NAME, DECODER_DB_USER, DECODER_DB_PASS, INDEXER_DB_HOST, INDEXER_DB_PORT, INDEXER_DB_NAME, INDEXER_DB_USER, INDEXER_DB_PASS, HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, HUB_DB_USER, HUB_DB_PASS);

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

    // API key enforcement for write methods
    app.use((req, res, next) => {
        if(!INDEXER_API_KEY) return next();
        let method = req.body && req.body.method;
        if(method && WRITE_METHODS.has(method.toLowerCase())){
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