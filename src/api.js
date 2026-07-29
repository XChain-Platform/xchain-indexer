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
// Note: express-rate-limit is mounted per-IP below (INDEXER_RATE_LIMIT_RPM,
// default 600). The indexer API is intended to be internal-only (hub +
// xchain-node managed deployments), but the stock xchain-node topology can
// publish the port on all host interfaces, so a generous limiter keeps an
// anonymous loop off GET /status and the ungated JSON-RPC reads (each of which
// costs pooled DB round-trips) without affecting the handful of legitimate
// hub/explorer callers (see sibling services: decoder, encoder, explorer, hub).
const dotenv        = require('dotenv');
const express       = require('express');
const bodyParser    = require('body-parser');
const helmet        = require('helmet');
const cors          = require('cors');
const rateLimit     = require('express-rate-limit');
const XChainIndexer = require('./XChainIndexer');
const jsonRouter    = require('express-json-rpc-router');
const { buildHealthResponse } = require('./health');
const { getStakeSourceByPubkey } = require('./stake-source');
const { canonicalizeRewardType } = require('./reward-push-gate');
const anchorActionQuery = require('./anchor-action-query');
const reorgHistoryQuery = require('./reorg-history-query');
const merkle        = require('./merkle');
const stateSubtree  = require('./state_subtree_activation');
const ar            = require('./anchor_reward_activation.js');
const crypto        = require('crypto');
const { installObservability } = require('./observability');   // : default-off /metrics + structured log shim

// Constant-time API-key comparison. A plain `!==` short-circuits at the first
// mismatching byte, leaking the key that guards reward-forging writes through
// response-time differences; timingSafeEqual needs equal-length buffers, so
// length is guarded first (a length mismatch is not itself the secret).
function keyEquals(provided, expected){
    const a = Buffer.from(String(provided == null ? '' : provided));
    const b = Buffer.from(String(expected == null ? '' : expected));
    if(a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

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

// Explicit escape hatch for keyless single-host / regtest nodes. When no API
// key is configured the gated methods (validator-reward writes, federation
// reads, gated exec) fail closed by default; setting this to 'true' restores
// the old keyless pass-through. A blind hard-fail would 401 every keyless
// xchain-node-managed indexer fleet-wide, so the escape hatch keeps that an
// opt-in operator decision rather than a silent breakage.
const ALLOW_UNAUTHED = (process.env.INDEXER_ALLOW_UNAUTHENTICATED === 'true');
if(!INDEXER_API_KEY && ALLOW_UNAUTHED)
    console.warn('WARNING: INDEXER_API_KEY is not set and INDEXER_ALLOW_UNAUTHENTICATED=true; write and federation-read methods are UNAUTHENTICATED. Never use this in production.');
else if(!INDEXER_API_KEY)
    console.warn('WARNING: INDEXER_API_KEY is not set; write and federation-read methods will be REJECTED (fail-closed). Set INDEXER_API_KEY for a shared deployment, or INDEXER_ALLOW_UNAUTHENTICATED=true to allow keyless single-host/regtest access.');

// feequotedryrun runs the REAL action handler with NO action deny-list: DEPLOY
// constructor / full EXECUTE including emit subtrees, up to the VM CPU cap, while
// holding the shared transaction mutex, under caller-shaped feeOutputs and the full
// block watchdog. The consensus question that originally gated it is resolved (block
// hashes cover canonical strings, and in-transaction index ids are dense-explicit and
// roll back; see the 06-18 trial + Actions._dryRunAction), so this gate is about
// UNMETERED COMPUTE on a public port: the default `feequote` dry-runs safely behind a
// deny-list + admission cap + short timeout, while this raw surface stays OPT-IN:
// registered ONLY on a regtest node with INDEXER_ENABLE_DRYRUN explicitly set.
// Anywhere else the method is removed entirely (calls get method-not-found), so it can
// never ship silently public on a shared/mainnet node.
const ENABLE_DRYRUN = INDEXER_NETWORK === 'regtest'
    && (process.env.INDEXER_ENABLE_DRYRUN === 'true' || process.env.INDEXER_ENABLE_DRYRUN === '1');

// Set of write methods that require the API key when one is configured
const WRITE_METHODS = new Set(['pushvalidatorrewards']);

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
    'getopencrosschainorders',
    'getactionconfirmations',
    'getanchoraction',
    'getreorghistory',
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

    // Per-IP rate limit, generous by default (the real callers are a handful of
    // hub/explorer processes). Bounds an anonymous flood against GET /status and
    // the ungated JSON-RPC read methods, both of which cost pooled DB round-trips
    // per hit, so the perimeter assumption is no longer the only guard.
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: parseInt(process.env.INDEXER_RATE_LIMIT_RPM) || 600,
        standardHeaders: true,
        legacyHeaders: false
    }));

    // : Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
    // Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
    // log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set. The coin/network
    // labels let one Prometheus scrape distinguish the per-chain indexers.
    // See src/observability/README.md.
    let indexerVersion = '';
    try { indexerVersion = require('../package.json').version; } catch { /* version label is cosmetic */ }
    installObservability(app, {
        service: 'xchain-indexer',
        version: indexerVersion,
        coin:    process.env.INDEXER_COIN || '',
        network: INDEXER_NETWORK || ''
    });

    // API key enforcement for write + federation read + gated exec methods.
    // These methods forge spendable validator_rewards rows or enumerate the
    // staked validator set, so they must never be reachable by an unauthenticated
    // peer. The gate fails closed by default: with INDEXER_API_KEY set, a valid
    // x-api-key is required; with no key set and no explicit escape hatch, the
    // call is rejected. Only INDEXER_ALLOW_UNAUTHENTICATED=true restores keyless
    // pass-through for a single-host / regtest node.
    app.use((req, res, next) => {
        // A JSON-RPC batch arrives as an array of call objects; a single call as
        // one object. express-json-rpc-router dispatches every element of an
        // array body, so the gate must inspect ALL of them: require the key if
        // ANY element invokes a gated method. Reading req.body.method off an
        // array leaves it undefined, which would smuggle a gated method (e.g.
        // pushvalidatorrewards, which forges spendable validator_rewards rows)
        // past the check unauthenticated inside a one-element batch.
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let id = (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null;
        let gated = calls.some(call => {
            let method = call && call.method;
            let normalized = method ? method.toLowerCase() : '';
            return method && (WRITE_METHODS.has(normalized) || FEDERATION_READ_METHODS.has(normalized) || GATED_EXEC_METHODS.has(normalized));
        });
        if(gated){
            if(INDEXER_API_KEY){
                let provided = req.headers['x-api-key'] || '';
                if(!keyEquals(provided, INDEXER_API_KEY)){
                    return res.status(401).json({
                        jsonrpc: '2.0', id,
                        error: { code: -32001, message: 'Unauthorized' }
                    });
                }
            } else if(!ALLOW_UNAUTHED){
                return res.status(401).json({
                    jsonrpc: '2.0', id,
                    error: { code: -32001, message: 'Unauthorized: this method requires INDEXER_API_KEY, or set INDEXER_ALLOW_UNAUTHENTICATED=true for keyless single-host/regtest access' }
                });
            }
            // else: no key configured and ALLOW_UNAUTHED set, pass through.
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
            let reorgStats = null;
            try {
                if(indexer.indexerDb)
                    reorgStats = await indexer.indexerDb.getReorgHealthStats();
            } catch (err) {
                // DB unreachable; leave reorg counters null (getReorgHealthStats is
                // already non-throwing, this is belt-and-braces).
            }
            return buildHealthResponse({
                indexer, indexerRunning, indexerError, lastIndexedBlock, now: Date.now(), reorgStats
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
            // Federation READ isolation ( / H2 residual): route every read
            // through apiView() so it draws an independent pooled connection and
            // sees only COMMITTED state. A federation read landing mid-block must
            // never join the block's open ACID transaction: sharing that physical
            // connection with the block loop is a per-block atomicity hazard, and
            // reading the block's uncommitted rows can hand a hub a validator set
            // the block may still roll back on a reorg/throw.
            let db = indexer.indexerDb.apiView();
            let pk = String(pubkey).toLowerCase();
            try {
                let blockIndex = await db.getLatestBlockIndex();
                // Effective-set view (direct stake minus revocations, plus delegated-key
                // resolution) so a delegation-only hub self-qualifies in step with the
                // federation. This is the federation-read-only consumer; consensus handlers
                // use getActiveStakeByPubkey (direct stake ownership) instead.
                let stake = await db.getEffectiveStakeByPubkey(pk, blockIndex);
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
                    // bytes travel WITH their root (the scheme version under which
                    // the stored root was computed) so the hub signs root+version as
                    // a unit; null whenever the root is null.
                    //
                    // state_root_version is DERIVED AT THE ROW'S OWN HEIGHT, not read
                    // off the static merkle constant and NOT derived at the chain tip.
                    // This response is the only place the version is minted: the hub's
                    // checkpoint engine copies it verbatim into the signed canonical
                    // and from there into the anchor row, so a wrong value here is
                    // signed by the validator set rather than merely displayed. Tip
                    // derivation is the specific trap: it passes any "no static
                    // constant" check while relabelling every below-boundary
                    // checkpoint as version 2 once a slot arms, which is a lie about
                    // what those blocks committed.
                    balances_root:        stored.balances_root     || null,
                    stakes_root:          stored.stakes_root       || null,
                    state_root:           stored.state_root        || null,
                    state_root_version:   stored.state_root
                        ? stateSubtree.stateRootVersion(Number(stored.block_index),
                                                        indexer.config['NETWORK'], indexer.config['COIN'])
                        : null,
                    block_merkle_root:    stored.block_merkle_root || null,
                    block_merkle_version: stored.block_merkle_root ? merkle.BLOCK_MERKLE_VERSION : null
                };
            } catch (err) {
                console.error('getblockhashes error:', err);
                return { error: 'failed to look up block hashes' };
            }
        },

        // Read-only native-coin fee pre-flight. Phase 2: runs the REAL action handler in a
        // forced-rollback dry-run (Actions.computeFeeQuote), so `valid`/`error` are the
        // handler's own verdict for ANY quotable action (class-A fee/price failures AND
        // class-B action failures: insufficient balance, taken ticker, ...), and the fee is
        // the handler's staged number valued at current oracle prices, judged (optionally)
        // against the on-chain tolerance. Nothing persists. VM/compound actions never reach the
        // dry-run engine here: DEPLOY/EXECUTE answer with a schedule-priced fee carrying
        // `valid:null` (payable, unverified), XEXEC/BATCH stay unquotable. Quotes are
        // admission-capped and time-boxed so this public read can't starve the block loop
        // (see computeFeeQuote).
        // Public read (surfaced to wallets/SDK via the explorer proxy); not a write or
        // federation method.
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

        // Oracle usage fee quote . A Mode B dispenser (ORACLE_ADDRESS set) must
        // carry a native-coin output paying the oracle operator, sized from the escrow
        // this action adds. A payer calls this to learn the amount, then adds the output.
        //
        // Backed by the SAME utility.quoteOracleFee() the consensus check calls, so a
        // quote and an acceptance can never drift apart; a drift would either reject an
        // honest create or underpay the oracle. Unlike feequote this needs no dry-run:
        // the amount is a pure function of the two oracle prices and the escrow.
        //
        // Body: { oracleAddress, giveCoin, giveTick, fiatCode, getCoin, giveEscrow, blockTime? }
        // blockTime defaults to the indexer's current tip time; a caller quoting for a
        // specific block may pass one.
        async oraclefeequote({oracleAddress, giveCoin, giveTick, fiatCode, getCoin, giveEscrow, blockTime}){
            if(!oracleAddress || !giveTick || !fiatCode)
                return { error: 'oracleAddress, giveTick and fiatCode are required' };
            if(!indexer.indexerDb || !indexer.util)
                return { error: 'indexer not ready' };
            try {
                let ts = Number(blockTime);
                if(!Number.isFinite(ts) || ts <= 0){
                    let tip = await indexer.indexerDb.getLatestBlockIndex();
                    ts = Number(await indexer.indexerDb.getBlockTime(tip)) || 0;
                }
                if(!Number.isFinite(ts) || ts <= 0)
                    return { error: 'no indexed block to quote against' };
                let quote = await indexer.util.quoteOracleFee(ts, {
                    ORACLE_ADDRESS: oracleAddress,
                    GIVE_COIN:      giveCoin || indexer.config['COIN'],
                    GIVE_TICK:      giveTick,
                    FIAT_CODE:      fiatCode,
                    GET_COIN:       getCoin  || indexer.config['COIN'],
                    GIVE_ESCROW:    giveEscrow,
                }, indexer.indexerDb);
                if(!quote.valid)
                    return { valid: false, error: quote.error };
                let native = indexer.util.bcformat(quote.expectedFee, 8);
                return {
                    valid:             true,
                    oracleAddress:     oracleAddress,
                    blockTime:         ts,
                    requiredFeeNative: native,
                    requiredFeeSats:   Number(indexer.util.bcformat(
                                          indexer.util.bcmul(quote.expectedFee, '100000000', 0), 0)),
                    belowDust:         !!quote.belowDust,
                    note:              quote.belowDust
                        ? 'fee is below the dust threshold; no output required'
                        : 'add a native-coin output of at least this amount to ' + oracleAddress
                };
            } catch (err) {
                console.error('oraclefeequote error:', err);
                return { error: 'failed to compute oracle fee quote' };
            }
        },

        // Public validity-first pre-flight : "would the indexer accept this action?"
        // decoupled from native-coin fee support. Same forced-rollback dry-run engine and the
        // same admission cap / timeout / guardInert as feequote, but the response is the
        // action's validity STATUS (not a fee band), and supported:true whenever the handler
        // actually ran. VM actions stay denylisted; settlement/lifecycle actions stay
        // feeExempt. Height-keyed memo collapses same-height re-runs. Public read (surfaced to
        // wallets/SDK via the explorer /{COIN}/api/preflight proxy); NOT gated like
        // feequotedryrun. Never persists.
        // `feeMode` ('xchain' | 'native', optional) says how the caller's real transaction will
        // settle the protocol fee, because the verdict differs : the XCHAIN mode debits
        // the payer's balance and the native mode pays a coin output. Omitted, the indexer picks
        // the mode the chain itself defaults to.
        // Body: { action, params, source, feeMode? }
        async preflight({action, params, source, feeMode}){
            if(!action || typeof action !== 'string')
                return { error: 'action is required' };
            if(!indexer.indexerDb || !indexer.actions)
                return { error: 'indexer not ready' };
            try {
                return await indexer.actions.computePreflight({ action, params, source, feeMode });
            } catch (err) {
                console.error('preflight error:', err);
                return { error: 'failed to compute pre-flight' };
            }
        },

        // OPT-IN raw dry-run: same engine as feequote but with no action deny-list, no
        // admission cap, the caller's literal feeOutputs (no probe injection), and the full
        // block watchdog as timeout. That unrestricted surface (VM actions on demand) is why
        // it stays regtest-gated (see ENABLE_DRYRUN) even though the default feequote now
        // dry-runs publicly. Never persists.
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latestBlock = await db.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await db.getActiveValidators(blk);
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latestBlock = await db.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await db.getActiveStakeWeights(blk);
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            // A capability absent from this indexer's STAKING.CAPABILITIES config would
            // otherwise produce an empty validator set indistinguishable from "no
            // qualified validators at this block". Surface it as an error so the hub's
            // CapabilitySnapshot treats it as a null snapshot (degraded mode) and the
            // operator gets a signal of config drift instead of a silent attestation drop.
            if(!db.isCapabilityConfigured(capability))
                return { error: 'capability not configured: ' + capability };
            try {
                let latestBlock = await db.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await db.getValidatorsByCapability(capability, blk, min_stake);
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                // Intersect the proof-window set with the LIVE full_node capability
                // at this block (byte-identical to the eligibility rule in
                // actions/nodeproof.js (_eligibleVerifierSet) and the reward split in
                // actions/price.js, so the hub sizes quorum over the same set the
                // chain will accept.
                let raw = await db.getVerifiedFullNodeSet(blk);
                let validators = [];
                for(let v of raw){
                    if(await db.hasCapability(v.pubkey, 'full_node', blk))
                        validators.push(v);
                }
                return {
                    block_index: blk,
                    count:       validators.length,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:   raw.truncated === true,
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            if(!db.isCapabilityConfigured(capability))
                return { error: 'capability not configured: ' + capability };
            try {
                let latestBlock = await db.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await db.getStakeWeightsByCapability(capability, blk, min_stake);
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest  = await db.getLatestBlockIndex();
                let rows    = await db.getPendingAttestationRequests(provider_id, max, cursor);
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                // Source-chain reorg fence (item 5308): stamp each offer with this chain's current
                // push generation. The hub copies it onto the matched leg's a_/b_push_generation so a
                // deferred retraction fences by generation and a re-published order at a recycled
                // action_index (higher generation) survives. Per-COIN, so one read covers the book.
                //
                // Read the generation BEFORE the rows (HUB-RETRACT-1): a concurrent rollback bumps the
                // generation atomically with deleting the orphaned rows (rollback.js, in-transaction).
                // Reading the generation first guarantees safety wherever that commit lands - gen G
                // then rows are pre-commit orphans (stamped G, which the fence <= G covers) or already
                // gone; gen G+1 means the commit happened, so the orphaned rows are already gone. The
                // reverse order (rows then generation) could read orphaned rows pre-commit and stamp
                // them with the post-commit G+1, letting them escape the fence permanently.
                let pushGeneration = await db.getPushGeneration(indexer.config['COIN']);
                // Effective expiration filter (XCC-2): drop offers already past their (edit-
                // overlaid) expiration relative to the tip's block_time, so a stale 'open' offer
                // awaiting its next block-loop expiry pass cannot occupy a bounded slot. A missing
                // block_time (older-schema gap) yields a non-finite value → the filter is skipped
                // (fail open, unchanged behavior) rather than dropping the whole book.
                // getBlockTime returns the `false` sentinel on a missing block / older-schema gap;
                // coerce that (and any non-finite) to null so the filter is skipped rather than
                // running as a `>= 0` no-op or, worse, a `>= NaN` that drops the whole book.
                let rawBlockTime = await db.getBlockTime(latest);
                let blockTime = (rawBlockTime !== false && Number.isFinite(Number(rawBlockTime)))
                    ? Number(rawBlockTime) : null;
                // Unified cross-chain book (XCC-2): SWAP (Phase A, exact single-fill) + ORDER
                // (Phase B, price-time partial fills) drawn in one UNION ALL so a single global
                // LIMIT + keyset cursor bounds the whole book. Each offer is tagged `kind`; the
                // returned array carries .truncated + .next_cursor out-of-band.
                let merged = await db.getOpenCrossChainOffers(max, after_action_index, to_coin, blockTime);
                let truncated = merged.truncated === true;
                if(truncated)
                    console.warn('getopencrosschainorders hit the cap of ' + max + ' at block ' + latest + ' - the open cross-chain book is truncated (newer offers dropped); the hub should page via next_cursor or raise its limit.');
                for(let o of merged) o.push_generation = pushGeneration;
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              merged.length,
                    truncated:          truncated,
                    // Keyset cursor for the hub's page loop: feed back as after_action_index.
                    next_cursor:        (merged.next_cursor != null) ? merged.next_cursor : null,
                    orders:             merged
                };
            } catch (err) {
                console.error('getopencrosschainorders error:', err);
                return { error: 'failed to look up cross-chain orders' };
            }
        },

        // BET parimutuel betting reads (spec claude/specs/BETTING_SYSTEM_SPEC.md
        // section 8: raw reads for ops tooling and e2e; the PUBLIC surface is the
        // explorer REST layer). Paged listing of betting feeds.
        // Body: { status?, source?, tick?, limit?, after_action_index? }
        async getbetfeeds({status, source, tick, limit, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            // Committed-only read off an independent pooled connection 
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getBetFeedRows({ status, source, tick, limit: max, after_action_index });
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              rows.length,
                    next_cursor:        (rows.length === max) ? rows[rows.length - 1].action_index : null,
                    feeds:              rows
                };
            } catch (err) {
                console.error('getbetfeeds error:', err);
                return { error: 'failed to look up bet feeds' };
            }
        },

        // One betting feed + its per-outcome open pools.
        // Body: { action_index }
        async getbetfeed({action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!Number.isFinite(Number(action_index)))
                return { error: 'action_index must be numeric' };
            let db = indexer.indexerDb.apiView();
            try {
                let feed = await db.getBetFeedInfo(Number(action_index));
                if(!feed)
                    return { error: 'unknown feed' };
                let pools = await db.getBetFeedPools(Number(action_index));
                return {
                    network: indexer.config['NETWORK'],
                    feed:    feed,
                    pools:   pools
                };
            } catch (err) {
                console.error('getbetfeed error:', err);
                return { error: 'failed to look up bet feed' };
            }
        },

        // Paged listing of bets.
        // Body: { feed?, source?, status?, limit?, after_action_index? }
        async getbets({feed, source, status, limit, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getBetRows({ feed, source, status, limit: max, after_action_index });
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              rows.length,
                    next_cursor:        (rows.length === max) ? rows[rows.length - 1].action_index : null,
                    bets:               rows
                };
            } catch (err) {
                console.error('getbets error:', err);
                return { error: 'failed to look up bets' };
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                // Source-chain reorg fence (item 5308): stamp each call with this chain's current
                // push generation. The hub copies it onto the dispatch row (and the result row
                // inherits it), so a source-keyed deferred retraction fences by generation. Per-COIN.
                // Read the generation BEFORE the rows (HUB-RETRACT-1): the rollback bumps the
                // generation atomically with deleting the orphaned rows, so gen-first is safe wherever
                // that commit lands, while rows-then-gen could stamp a pre-commit orphan with the
                // post-commit generation and let it escape the fence. See getopencrosschainorders.
                let pushGeneration = await db.getPushGeneration(indexer.config['COIN']);
                let rows   = await db.getPendingCrossChainCallRequests(max);
                for(let c of rows) c.push_generation = pushGeneration;
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                // Source-chain reorg fence (item 5308): the hub follower pins this call's
                // generation against the leader's proposed dispatch row
                // (CrossChainCallEngine._validateDispatch). The field is stamped on the row but
                // never enters the signed canonical, so the pin is what stops a Byzantine leader
                // inflating it to evade a later source-keyed retraction. Omitting it here made
                // the follower re-derive 0 for every call, which matched only until the first
                // rollback on this chain bumped the generation - after that no honest follower
                // could ever co-sign a dispatch again.
                //
                // Read the generation BEFORE the row (HUB-RETRACT-1), same ordering and for the
                // same reason as getopencrosschainorders / getpendingcrosschaincalls above.
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let row    = await db.getCrossChainCallExecutionById(String(call_id));
                if(!row){
                    let res = { exists: false, network: indexer.config['NETWORK'], latest_block_index: latest };
                    // Surface refusal diagnostics (XDISP-1): a quorum-starved dispatch has
                    // no execution row, but the injection pass records WHY it keeps being
                    // refused. Node-local advisory only (never quorum-verified relay data).
                    let rejection = await db.getCrossChainCallRejectionById(String(call_id));
                    if(rejection){
                        res.rejection = {
                            reason:      rejection.reason,
                            detail:      rejection.detail || '',
                            attempts:    Number(rejection.attempts),
                            first_block: Number(rejection.first_block),
                            last_block:  Number(rejection.last_block)
                        };
                    }
                    return res;
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
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let row    = await db.getActionInfo(idx);
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

        // Look up the on-chain ANCHOR checkpoint record (from anchor_actions, the
        // permanent full-parse record) for a checkpoint identity, with its DOGE
        // confirmation depth. Serves the hub's anchor-gossip verification: before a
        // hub trusts an XANC_V0_DONE / XANC_FINALIZED (which stamps anchor_txid and
        // mirrors a reward), it confirms via THIS method that a matching anchor
        // actually landed on-chain (payload hashes match, status is not 'invalid',
        // confirmations >= XCHAIN_CONFIRMATIONS_DOGE), independently of the announced
        // txid, defeating a phantom txid and a Byzantine ELECTED publisher alike.
        // `chain`/`network` are the CHECKPOINTED chain (e.g. BTC/regtest); this
        // indexer serves the anchor chain (DOGE), so confirmations are DOGE-relative.
        // Optional `txid` / `version` narrow the lookup to a SPECIFIC anchor
        // transaction rather than "the newest anchor for this checkpoint". Without
        // them the answer is only "this checkpoint is anchored at depth", which a
        // Byzantine ELECTED publisher can satisfy while announcing a never-mined or
        // real-but-different txid (XANC-ELECTED-FORGE-1). `checkpoint_anchored` is
        // returned alongside `exists` so a filtering caller can distinguish a benign
        // not-yet-anchored checkpoint from a positively-detected txid forge.
        //
        // The candidate rows are read with doQuery + the SQL owned by
        // anchor-action-query.js rather than a db.js accessor, keeping this read
        // surface isolated (db.js is under concurrent edit). db.js's single-row
        // getAnchorActionByCheckpoint is superseded by this path and should be
        // folded back here once db.js is free.
        async getanchoraction({chain, network, block_index, checkpoint_seq, txid, version}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let v = anchorActionQuery.validateAnchorActionParams({ chain, network, block_index, checkpoint_seq, txid, version });
            if(!v.ok) return { error: v.error };
            // Federation READ isolation : committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.doQuery(anchorActionQuery.ANCHOR_ACTIONS_SQL,
                    [chain, network, v.block_index, v.checkpoint_seq, ...anchorActionQuery.CHECKPOINT_VERSIONS]);
                let row    = anchorActionQuery.selectAnchorRow(rows, { txid: v.txid, version: v.version });
                return anchorActionQuery.buildAnchorActionResponse(indexer.config, latest, row,
                    { checkpoint_anchored: Array.isArray(rows) && rows.length > 0 });
            } catch (err) {
                console.error('getanchoraction error:', err);
                return { error: 'failed to look up anchor action' };
            }
        },

        // Reorg history WITH the orphaned block hashes, from the decoder's `events`
        // table (code='REORG', data = [{block_index, block_hash}]).
        //
        // Serves xchain-hub's ReorgHandler (REORG-OLDHASH-UNVERIFIED-1): the handler
        // can confirm the announced NEW hash is what its own node serves at the reorg
        // height, but nothing today proves the announced OLD hash was ever canonical
        // there, so one Byzantine validator can drive a fake-reorg rollback with a
        // fabricated oldHash. db.js's getReorgsSince() keeps only the deepest
        // block_index and drops the hashes, so this is a separate read.
        //
        // Pass block_index + block_hash to ask the precise question: "did you orphan
        // THIS hash at THIS height?" -> `matched` is the answer. Both must occur on the
        // SAME orphaned block. Reads the DECODER db (events is a decoder table).
        async getreorghistory({since_id, block_index, block_hash, limit}){
            if(!indexer.decoderDb)
                return { error: 'decoder database not ready' };
            let v = reorgHistoryQuery.validateReorgHistoryParams({ since_id, block_index, block_hash, limit });
            if(!v.ok) return { error: v.error };
            // Federation READ isolation : route through apiView for symmetry
            // with the indexerDb federation reads. The decoder DB never opens a block
            // transaction (its doQuery already pools), so this is defense-in-depth, but
            // keeping every federation read on the pooled view removes the whole class.
            let db = indexer.decoderDb.apiView();
            try {
                let rows = await db.doQuery(reorgHistoryQuery.REORG_EVENTS_SQL, [v.since_id, v.limit]);
                // #2736: live REORG_HALT probe so the hub can tell "no recent reorgs" apart from
                // "decoder halted, history frozen". Best-effort: a probe fault falls back to the
                // indexer's last-known flag rather than failing the whole read.
                let decoderReorgHalted;
                try {
                    // Route through the same apiView db (pool-direct, never the block tx connection).
                    let probe = await db.isReorgHalted();
                    decoderReorgHalted = !!(probe && probe.halted);
                } catch (probeErr) {
                    decoderReorgHalted = !!indexer.decoderReorgHalted;
                }
                return reorgHistoryQuery.buildReorgHistoryResponse(rows,
                    { block_index: v.block_index, block_hash: v.block_hash },
                    { decoderReorgHalted });
            } catch (err) {
                console.error('getreorghistory error:', err);
                return { error: 'failed to look up reorg history' };
            }
        },

        // Receive validator reward records pushed from xchain-hub (anchor publish
        // rails only). oracle_round and attest_fee are DERIVED deterministically
        // during block processing; accepting a push for them would let a stale
        // hub race the derivation and open a replay-divergence window, so they
        // are rejected outright.
        // #5311 (staged retirement): per-chain anchor rewards become on-chain DERIVED
        // at/above the ANCHOR_REWARD flag-day, so this endpoint rejects them there (see
        // the gate below).  extends the same retirement to anchor_archive at/above
        // the ARCHIVE_REWARD flag-day (derived from the ANCHOR v6 publisher attestation).
        // The handler remains the transport for pre-flag-day rounds until pre-v4/pre-v6
        // history is buried, at which point the whole handler + its WRITE_METHODS entry
        // are deleted (the decisive close of the forge vector).
        // Body: { round, reward_type, block_index, rewards: [{pubkey, amount}, ...] }
        async pushvalidatorrewards({round, reward_type, block_index, rewards}){
            if(round === undefined || round === null)
                return { error: 'round is required' };
            if(!Array.isArray(rewards))
                return { error: 'rewards must be an array' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Canonicalize the reward_type case BEFORE any gate/store/reconcile.
            // The validator_rewards column is utf8_general_ci and the derived
            // winner is written as 'anchor_' + CHAIN.toUpperCase(), so a mixed-case
            // push (e.g. 'anchor_btc') would otherwise slip the case-sensitive
            // flag-day gate below AND collation-collide with the derived winner in
            // reconcileAnchorRewardWinner, deleting the legit row (forge/fork).
            let type = canonicalizeRewardType(reward_type || 'oracle_round');
            if(!/^anchor_[A-Za-z_]+$/.test(type))
                return { error: 'reward_type ' + type + ' is not pushable (derived during block processing)' };
            let blockIdx = block_index || 0;
            // #5311 staged retirement: at/above the ANCHOR_REWARD flag-day a per-chain anchor
            // reward (anchor_<CHAIN>) is DERIVED on-chain from the ANCHOR v4/v5 publisher
            // attestation, so accepting an unauthenticated push for it is exactly the forge
            // vector this change retires; reject it (defense in depth; the upgraded hub no
            // longer pushes it). Pre-flag-day anchor_<CHAIN> rewards still push. block_index
            // is the BTC snapshot_block the flag-day is keyed on. The handler itself stays
            // until pre-v4/pre-v6 history is buried.
            if(/^anchor_(BTC|LTC|DOGE)$/.test(type) &&
               ar.isAnchorRewardActive(Number(blockIdx), indexer.config && indexer.config['NETWORK']))
                return { error: 'reward_type ' + type + ' at block ' + blockIdx +
                                ' is derived on-chain from ANCHOR v4/v5; push retired (#5311)' };
            // : the same staged retirement for the ARCHIVE leg. At/above the
            // ARCHIVE_REWARD flag-day anchor_archive is DERIVED on-chain from the ANCHOR v6
            // publisher attestation, so accepting a key-authenticated push for it is exactly
            // the insider-with-key forge surface  retires; reject it (the upgraded hub
            // no longer pushes it). The canonicalizer above pins the type's case so no
            // collation-variant can slip this case-sensitive comparison.
            if(type === 'anchor_archive' &&
               ar.isArchiveRewardActive(Number(blockIdx), indexer.config && indexer.config['NETWORK']))
                return { error: 'reward_type anchor_archive at block ' + blockIdx +
                                ' is derived on-chain from ANCHOR v6; push retired ' };
            let written = 0;
            let skipped = 0;
            // apiView(): these writes land on an independent pooled connection. A
            // push arriving while a block is mid-processing must never join the
            // block's open transaction: the block's reorg/error rollback would
            // silently revert rewards this handler already acked with
            // {status:'success'}, and the hub never retries a successful push.
            let apiDb = indexer.indexerDb.apiView();
            for(let r of rewards){
                if(!r || !r.pubkey || !r.amount){ skipped++; continue; }
                try {
                    let ok = await apiDb.createValidatorReward(r.pubkey, round, type, r.amount, blockIdx);
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
                    let removed = await apiDb.reconcileAnchorRewardWinner(round, type, blockIdx, null);
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

    // Unregister the opt-in dry-run unless explicitly enabled on a regtest node
    // (see ENABLE_DRYRUN). Removing the method means a non-regtest / unflagged node
    // returns method-not-found instead of exposing unauthenticated VM execution.
    if(!ENABLE_DRYRUN)
        delete jsonRpcController.feequotedryrun;
    else
        console.warn('WARNING: feequotedryrun is ENABLED (regtest + INDEXER_ENABLE_DRYRUN). It runs the real VM in a rolled-back txn; keep this node isolated.');

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
        let indexerDbUnreachable = false;
        try {
            if(indexer.indexerDb)
                indexerBlock = await indexer.indexerDb.getLatestBlockIndex();
        } catch (err) {
            // Database unreachable; leave indexerBlock null so lag stays null
            // rather than reporting a misleading figure.
            indexerDbUnreachable = true;
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
        // Age + explicit staleness via the one shared helper (same threshold as buildHealthResponse).
        let hubConfig            = XChainIndexer.hubConfigStaleness(lastHubConfigFetchAt, Date.now());
        let hubConfigAgeSeconds  = hubConfig.ageSeconds;
        let hubConfigStale       = hubConfig.stale;
        // Status-code contract for the xchain-node http_get healthcheck (wget
        // exits 0 on any 2xx): 503 when the indexer DB is unreachable or the
        // block counter is genuinely WEDGED, matching the encoder / utxo-tracker /
        // sync siblings. A set stallReason ALONE no longer trips 503 : a
        // BTC-mainnet indexer perpetually defers the newest block behind a price
        // mirror one block back, so it is almost always mid-barrier at probe time
        // even though it advances every few seconds. Reserve 503 for a stall with
        // no committed block inside the grace window; a stalled-but-advancing
        // indexer stays 200 with degraded:true. isSynced=false alone likewise
        // stays 200: a healthy initial catch-up must not trip restart loops.
        let stalled   = !!indexer.stallReason;
        let wedged    = XChainIndexer.stallWedged(indexer.stallReason, indexer.lastBlockCommittedAt,
                                                  indexer.healthStallGraceMs, Date.now());
        let unhealthy = indexerDbUnreachable || wedged;
        res.status(unhealthy ? 503 : 200).json({
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
            // true when a sync barrier is deferring blocks but the counter is still
            // advancing (healthy-degraded, stays 200); distinct from a wedge, which is
            // stalled AND making no progress inside the grace window (503).
            degraded:     stalled && !wedged,
            // epoch-ms of the most recent successful block commit (null until the first),
            // so a probe can read advance-recency directly rather than infer it from lag.
            lastBlockCommittedAt: indexer.lastBlockCommittedAt || null,
            lastHubConfigFetchAt: lastHubConfigFetchAt,
            hubConfigAgeSeconds:  hubConfigAgeSeconds,
            hubConfigStale:       hubConfigStale
        });
    });

    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

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