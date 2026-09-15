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
 * This file parses in environmental variables and starts up the parsing API.
 * As the process entry it keeps the boot-time env reads, the three auth tier sets
 * and the one handler a sibling guard reads here by path; the middleware, the
 * JSON-RPC route families and the status route live under src/api/ and receive
 * all of that through the one object apiContext() builds.
 * 
 ********************************************************************/
// Load required libraries
const dotenv        = require('dotenv');
// Parse in .env config data BEFORE any local require. src/config.js captures the
// environment once at module load, and XChainIndexer below loads it, so a later
// dotenv.config() would leave every .env-supplied setting at its default.
dotenv.config();
const express       = require('express');
const XChainIndexer = require('./XChainIndexer');
const jsonRouter    = require('express-json-rpc-router');
const { installMiddleware } = require('./api/middleware');
const { buildRpcController } = require('./api/rpc');
const { mountStatusRoute } = require('./api/status_endpoint');
const { createShutdown, createIndexerDrain } = require('./api/shutdown');
const crypto        = require('crypto');
const { installCrashHandlers } = require('./actions/anchor/diagnostic_events.js');

// Before anything else logs. The env-validation failures immediately below are
// exactly the lines an operator needs levelled and timestamped, and
// installObservability does not run until startApi installs the middleware.
const { patchConsole } = require('./observability');
const { getLogger } = require('./observability/index.js');
const fs   = require('fs');
const path = require('path');
const { CONFIG_ENV } = require('./config.js');
patchConsole({
    service: 'xchain-indexer',
    version: require('../package.json').version,
    coin:    CONFIG_ENV.INDEXER_COIN || '',
    network: CONFIG_ENV.INDEXER_NETWORK || ''
});

// Validate required environment variables
const REQUIRED_ENV = [
    'DECODER_DB_HOST','DECODER_DB_PORT','DECODER_DB_NAME','DECODER_DB_USER','DECODER_DB_PASS',
    'INDEXER_DB_HOST','INDEXER_DB_PORT','INDEXER_DB_NAME','INDEXER_DB_USER','INDEXER_DB_PASS'
];
// Read through CONFIG_ENV, which dotenv.config() at the top of this file populated before
// config.js loaded. Every REQUIRED_ENV key is a CONFIG_ENV key; a name missing from that
// object would read undefined and fail this check loudly at boot, never pass silently.
for(const key of REQUIRED_ENV){
    if(!CONFIG_ENV[key]){
        getLogger().error('Missing required environment variable: ' + key);
        process.exit(1);
    }
}

// Parse in the environmental variables
const INDEXER_API_PORT = CONFIG_ENV.INDEXER_API_PORT;
const INDEXER_NETWORK  = CONFIG_ENV.INDEXER_NETWORK;

// xchain-utxo-tracker config (optional, required by DISPENSER fresh-address check)
const UTXO_TRACKER_URL      = CONFIG_ENV.UTXO_TRACKER_URL || '';
const UTXO_TRACKER_API_PORT = CONFIG_ENV.UTXO_TRACKER_API_PORT || '';

// Decoder database config
const DECODER_DB_HOST  = CONFIG_ENV.DECODER_DB_HOST;
const DECODER_DB_PORT  = CONFIG_ENV.DECODER_DB_PORT;
const DECODER_DB_NAME  = CONFIG_ENV.DECODER_DB_NAME;
const DECODER_DB_USER  = CONFIG_ENV.DECODER_DB_USER;
const DECODER_DB_PASS  = CONFIG_ENV.DECODER_DB_PASS;

// Indexer database config
const INDEXER_DB_HOST  = CONFIG_ENV.INDEXER_DB_HOST;
const INDEXER_DB_PORT  = CONFIG_ENV.INDEXER_DB_PORT;
const INDEXER_DB_NAME  = CONFIG_ENV.INDEXER_DB_NAME;
const INDEXER_DB_USER  = CONFIG_ENV.INDEXER_DB_USER;
const INDEXER_DB_PASS  = CONFIG_ENV.INDEXER_DB_PASS;

// Hub database config (optional, local read-only copy of cross-chain data)
const HUB_DB_HOST = CONFIG_ENV.HUB_DB_HOST || '';
const HUB_DB_PORT = CONFIG_ENV.HUB_DB_PORT || '';
const HUB_DB_NAME = CONFIG_ENV.HUB_DB_NAME || '';
const HUB_DB_USER = CONFIG_ENV.HUB_DB_USER || '';
const HUB_DB_PASS = CONFIG_ENV.HUB_DB_PASS || '';

// API key for write + federation read methods (e.g. hub→indexer reward pushes).
// Optional, matching .env.example: unset disables the gate (single-host /
// regtest); when configured, the gated methods fail closed (401) without a
// valid key. Hard-requiring it at boot crash-looped every xchain-node-managed
// deployment (ConfigService injects no such var); the same over-tightening
// that took down the encoder pre-launch (see xchain-encoder e2bf7c4).
const INDEXER_API_KEY = CONFIG_ENV.INDEXER_API_KEY || '';

// Explicit escape hatch for keyless single-host / regtest nodes. When no API
// key is configured the gated methods (validator-reward writes, federation
// reads, gated exec) fail closed by default; setting this to 'true' restores
// the old keyless pass-through. A blind hard-fail would 401 every keyless
// xchain-node-managed indexer fleet-wide, so the escape hatch keeps that an
// opt-in operator decision rather than a silent breakage.
const ALLOW_UNAUTHED = (CONFIG_ENV.INDEXER_ALLOW_UNAUTHENTICATED === 'true');
if(!INDEXER_API_KEY && ALLOW_UNAUTHED)
    getLogger().warn('WARNING: INDEXER_API_KEY is not set and INDEXER_ALLOW_UNAUTHENTICATED=true; write and federation-read methods are UNAUTHENTICATED. Never use this in production.');
else if(!INDEXER_API_KEY)
    getLogger().warn('WARNING: INDEXER_API_KEY is not set; write and federation-read methods will be REJECTED (fail-closed). Set INDEXER_API_KEY for a shared deployment, or INDEXER_ALLOW_UNAUTHENTICATED=true to allow keyless single-host/regtest access.');

// feequotedryrun runs the REAL action handler with NO action deny-list: DEPLOY
// constructor / full EXECUTE including emit subtrees, up to the VM CPU cap, while
// holding the shared transaction mutex, under caller-shaped feeOutputs and the full
// block watchdog. It is not gated for a consensus reason, since that question is settled (block
// hashes cover canonical strings, and in-transaction index ids are dense-explicit and
// roll back; see the 06-18 trial + Actions.dryRunAction), so this gate is about
// UNMETERED COMPUTE on a public port: the default `feequote` dry-runs safely behind a
// deny-list + admission cap + short timeout, while this raw surface stays OPT-IN:
// registered ONLY on a regtest node with INDEXER_ENABLE_DRYRUN explicitly set.
// Anywhere else the method is removed entirely (calls get method-not-found), so it can
// never ship silently public on a shared/mainnet node.
const ENABLE_DRYRUN = INDEXER_NETWORK === 'regtest'
    && (CONFIG_ENV.INDEXER_ENABLE_DRYRUN === 'true' || CONFIG_ENV.INDEXER_ENABLE_DRYRUN === '1');

// Set of write methods that require the API key when one is configured.
//
// EMPTY, and that is the finished state of the PUSH-ANCHOR endgame, not an
// oversight. `pushvalidatorrewards` was the only member: a key-authenticated
// rail that minted COLLECT-spendable validator_rewards rows. Every reward it
// carried is now derived from on-chain bytes by every indexer, the hub holds no
// caller for it any more (xchain-hub/src/anchor/reward_tracker.js has no push loop and
// no terminal-refusal predicate), and mainnet is past both reward flag-days with
// no pre-flag reward history to reinterpret. With no caller left to answer, the
// method is gone rather than kept as a refusing stub: an unknown method answers
// -32601 method-not-found, which is what a caller that should not exist deserves.
//
// The set itself stays because the gate (src/api/auth_gate.js) is shaped around three sets and a
// future write method must land in one of them rather than ship ungated by
// default. Anything that writes goes HERE.
const WRITE_METHODS = new Set([]);

// Methods that execute the VM / mutate AUTO_INCREMENT and must fail closed (401)
// without a valid x-api-key when a key is configured, even though they roll back.
const GATED_EXEC_METHODS = new Set(['feequotedryrun']);

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
    'getrelayedattestation_requests',
    'getopencrosschainorders',
    'getactionconfirmations',
    'getanchoraction',
    'getpricebatches',
    'getanchorconfirmations',
    'getrollcallsigners',
    'getarchiveanchor',
    'getreorghistory',
    'getpendingcrosschaincalls',
    'getcrosschaincall',
    'getcrosschaincallresult'
]);

// sha256 of THIS indexer's vendored action-manifest.json, cached after the first
// read. The BTC-side epoch close compares it against its own vendored copy and
// DEFERS on a mismatch.
//
// Why this exists at all: a DOGE indexer running a decoder that predates the
// ROLLCALL allowlist entry drops every roll call at decode
// (XChainDecoder VALID_ACTION_NAMES) and would then answer a perfectly
// well-formed "nobody signed" -- which the BTC side would read as a
// federation-wide absence and act on. Depth cannot detect a peer's software
// version, so the manifest hash is the version signal, and it converts that
// silent wrong answer into a loud stall.
let _rollcallManifestHash = null;
function rollcallManifestHash(){
    if(_rollcallManifestHash !== null) return _rollcallManifestHash;
    try {
        const p    = path.join(__dirname, '..', 'test', 'fixtures', 'action-manifest.json');
        _rollcallManifestHash = crypto.createHash('sha256')
            .update(fs.readFileSync(p)).digest('hex');
    } catch (e) {
        // Fail LOUD rather than silently agreeing with every peer: a null hash can
        // never equal the caller's, so the close defers instead of trusting an
        // indexer whose manifest we could not read.
        getLogger().error('rollcallManifestHash: cannot read vendored action-manifest.json:', e.message);
        _rollcallManifestHash = null;
        return null;
    }
    return _rollcallManifestHash;
}

// The one route family the entry keeps: xchain-hub's cross_chain_call_engine.test.js
// reads THIS file by literal path, slices from the getcrosschaincall header to the
// next eight-space async member and compiles the success literal into the fixture
// its dispatch pin validates against, so the handler stays here at that indentation.
// Its siblings are in src/api/rpc/cross_chain_calls.js.
function crossChainCallRpc({ indexer }){
    return {
        // Single XCALL request by call_id; the targeted re-verification a hub
        // follower runs before co-signing a leader's proposed dispatch row
        // (field-for-field, against its OWN view of this chain).
        // Body: { call_id }
        async getcrosschaincall({call_id}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!call_id || !/^[0-9a-fA-F]{64}$/.test(String(call_id)))
                return { error: 'call_id must be a 64-hex id' };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                // Source-chain reorg fence: the hub follower pins this call's
                // generation against the leader's proposed dispatch row
                // (CrossChainCallEngine.validateDispatch). The field is stamped on the row but
                // never enters the signed canonical, so the pin is what stops a Byzantine leader
                // inflating it to evade a later source-keyed retraction. Omitting it here made
                // the follower re-derive 0 for every call, which matched only until the first
                // rollback on this chain bumped the generation - after that no honest follower
                // could ever co-sign a dispatch again.
                //
                // Read the generation BEFORE the row, same ordering and for the
                // same reason as getopencrosschainorders (src/api/rpc/orders.js) and
                // getpendingcrosschaincalls (src/api/rpc/cross_chain_calls.js).
                let pushGeneration = await db.getPushGeneration(indexer.config['COIN']);
                let row    = await db.getCrossChainCallRequestById(String(call_id));
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
                        request_status:        row.request_status,
                        push_generation:       pushGeneration
                    }
                };
            } catch (err) {
                getLogger().error('getcrosschaincall error:', err);
                return { error: 'failed to look up cross-chain call' };
            }
        },
    };
}

// Everything the middleware, the route families and the status route need from
// this file, built once per boot. The env-derived values are read at module load
// above and handed over here rather than re-read by each part, so a boot under a
// fresh environment grades every part against the same snapshot.
function apiContext(indexer, liveness){
    return {
        indexer, liveness, XChainIndexer, CONFIG_ENV, INDEXER_NETWORK, ENABLE_DRYRUN,
        INDEXER_API_KEY, ALLOW_UNAUTHED, WRITE_METHODS, FEDERATION_READ_METHODS, GATED_EXEC_METHODS,
        rollcallManifestHash
    };
}

// Graceful shutdown, bound to the server and the settled block loop.
function installShutdown(indexer, server, indexerExited, liveness){
    // Graceful shutdown. node is PID 1 in the image, so `docker stop` delivers
    // SIGTERM to this process; before this handler existed the default action
    // killed the block loop wherever it stood, which meant an aborted MariaDB
    // write transaction and InnoDB crash recovery on every routine restart.
    // The handler is bounded by its own hard-exit timer (see src/api/shutdown.js):
    // installing it removes node's default terminate, so a drain that hangs must
    // still end the process rather than linger until the supervisor's SIGKILL.
    const shutdown = createShutdown({
        drain: createIndexerDrain({
            indexer:     indexer,
            server:      server,
            loopSettled: indexerExited,
            // Flip BEFORE stop(): stop() only sets stopFlag and the loop may take a
            // whole block to notice it, and /status must not report a draining
            // indexer as running through that window.
            onDraining:  () => { liveness.indexerRunning = false; }
        })
    });
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
}

// Start up the API
async function startApi(){

    // Initialize the indexer (created before API so the controller can reference it)
    const indexer = new XChainIndexer(DECODER_DB_HOST, DECODER_DB_PORT, DECODER_DB_NAME, DECODER_DB_USER, DECODER_DB_PASS, INDEXER_DB_HOST, INDEXER_DB_PORT, INDEXER_DB_NAME, INDEXER_DB_USER, INDEXER_DB_PASS, HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, HUB_DB_USER, HUB_DB_PASS, UTXO_TRACKER_URL, UTXO_TRACKER_API_PORT);

    // Track indexer liveness so the health endpoint can report it (the indexer
    // process exits on a fatal error, but the flag still distinguishes a clean
    // run from one tearing down). One object, so the health handler reads the
    // flip at call time rather than the value it was built with.
    const liveness = { indexerRunning: true, indexerError: null };

    // Create the app, then the middleware stack, the JSON-RPC controller and the
    // REST status route, all off the one context.
    const app = express();
    const ctx = apiContext(indexer, liveness);
    installMiddleware(app, ctx);
    const jsonRpcController = buildRpcController(ctx, [crossChainCallRpc]);
    mountStatusRoute(app, ctx);

    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}));

    // Start the server. The handle is kept so the shutdown drain below can stop
    // accepting connections and let in-flight requests finish.
    const server = app.listen(INDEXER_API_PORT, () => {
      getLogger().info('API listening on port ' + INDEXER_API_PORT);
    });

    // Start the Indexer (trap any errors and log them before exiting the indexer).
    // start() awaits the block loop, so this promise SETTLES when the loop breaks:
    // on a fatal error here, or on the stopFlag the drain sets at a block boundary.
    const indexerExited = indexer.start().catch((error) => {
        getLogger().error('Fatal indexer error:', error);
        liveness.indexerRunning = false;
        liveness.indexerError   = error;
        process.exit(1);
    });

    installShutdown(indexer, server, indexerExited, liveness);

    // Crash visibility. Registered here rather than at module scope because
    // several suites require modules of this repo in-process under mocha, which
    // installs its own handlers: a module-scope handler that exits would abort
    // the whole run instead of failing one test.
    installCrashHandlers();

}

startApi();
