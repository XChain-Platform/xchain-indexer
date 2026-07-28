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
 * XChain Indexer - Actions class
 * 
 * This class loads up all action classes and sets up handlers to process transactions
 *
 * The XChain Indexer actions are defined in the specifications at :
 * https://github.com/XChain-platform/xchain-documentation/blob/master/actions/README.md
 * 
 ********************************************************************/

// Canonical ADDRESS-reference field map (consensus surface; byte-identical copy in xchain-sdk)
const { ADDRESS_REF_FIELDS } = require('./addressRefFields.js');

// Actions the PUBLIC feequote pre-flight refuses to dry-run. DEPLOY/EXECUTE run
// caller-supplied code in the VM (up to the VM CPU cap) while the dry-run holds the shared
// transaction mutex, XEXEC re-runs a target contract, and BATCH can smuggle any of them as
// a sub-action; quoting these on a shared node would hand unauthenticated callers a
// block-loop-stalling compute primitive. The raw `feequotedryrun` RPC (regtest +
// INDEXER_ENABLE_DRYRUN + API key) has no such restriction.
const FEE_QUOTE_DENYLIST = new Set(['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH']);

// Denied actions that still get a FEE-ONLY quote, priced from the gas schedule with no VM
// . The old blanket answer was `supported:false` + "pay the fee in XCHAIN", which is
// BTC-era advice: LTC/DOGE settle the protocol fee in native coin and have no XCHAIN fee lane,
// so a denied action there was composable but literally unpayable (no way to size the required
// output), and any client offering it burned a network fee on a guaranteed-invalid action.
//
// Safe because the fee these two stage is decided BEFORE the VM runs and is pure arithmetic
// over the gas schedule: deploy.js charges VM_DEPLOY_BASE + codeBytes * VM_DEPLOY_PER_BYTE and
// execute.js charges VM_EXECUTE_BASE, and that pre-VM number is exactly what
// validateNativeCoinFee judges the native output against (the post-VM recalculation from metered
// gas re-prices the recorded fee, never the acceptance rule). So a static quote reproduces the
// acceptance rule byte-for-byte while never entering the VM: no dry-run, no mutex, no compute
// primitive. What it CANNOT answer is on-chain validity (class-B: contract exists, source has
// funds, code compiles), so the quote reports `valid: null` and `validated: false` rather than
// claiming a verdict it did not compute.
//
// XEXEC and BATCH stay fee-unquotable: XEXEC is system-injected from the cross-chain mirror
// (never wallet-broadcast, so there is no caller to quote for), and a BATCH's fee is the sum of
// its sub-actions' state-dependent fees, which cannot be priced without running them. Quoting a
// BATCH from a partial schedule would under-size the output, which is the same funds-burning
// direction this closes.
const FEE_QUOTE_STATIC = new Set(['DEPLOY', 'EXECUTE']);

// Settlement and lifecycle legs that stage NO protocol fee: the fee was already charged when
// the originating ORDER/SWAP/DISPENSER was created, so there is nothing for feequote to price.
// They also can't be dry-run through the synthetic-tx harness: COINPAY/DISPENSE only settle
// against a native-coin output paying a specific payee/dispenser (coinpay.js/dispense.js
// early-exit "skip" when it's absent), and the *_MATCH/*_EXPIRE/*_CLOSE/CROSS_SETTLE/XCALL
// actions are system-synthesized during block processing, never wallet-broadcast (XCALL is
// VM-emitted/synthetic-only, like CROSS_SETTLE). Quoting any of them used to fall through to a
// misleading `dry-run produced no status`; instead answer honestly with a zero-fee, feeExempt
// result. This is a read-only preflight classification, never a consensus path: it changes
// what the quote reports, not what a handler charges on-chain.
// ATTEST is exempt (not denylisted) because it stages no wallet-priceable fee AND must never
// dry-run on the public path: ATTEST v0 is VM-emission-only, and ATTEST v1 (validator response)
// injects a contract callback EXECUTE (attest.js _injectCallbackExecute) that enters the VM while
// the dry-run holds the block-loop mutex. Its protocol fee is charged at the v0 request origin and
// settled by _settleRequestFee, so there is nothing for feequote to price; exempting it short-
// circuits classifyFeeQuoteAction before _dryRunAction, closing the unauthenticated VM-compute-
// under-mutex reachable by replaying a pending v1 response's mempool bytes into feequote/preflight.
const FEE_QUOTE_EXEMPT = new Set([
    'COINPAY', 'DISPENSE',
    'COINPAY_EXPIRE', 'ORDER_MATCH', 'ORDER_EXPIRE', 'SWAP_MATCH', 'SWAP_EXPIRE',
    'DISPENSER_CLOSE', 'DISPENSER_EXPIRE', 'CROSS_SETTLE', 'XCALL', 'ATTEST',
    'BET_EXPIRE'
]);

// ACTION aliases, expanded to canonical names before any gate. Single module-level source of
// truth (#3133): the constructor copies this via Object.assign into `this.actionAliases`, and
// classifyFeeQuoteAction normalizes through this same constant, so the fee-quote classifier
// de-aliases exactly as dispatch does. The conformance test binds ACTION_ALIASES to the manifest.
const ACTION_ALIASES = {
    // Legacy BRC20 formats
    'TRANSFER': 'SEND',
    // Short aliases
    'ADDR': 'ADDRESS',
    'DROP': 'AIRDROP',
    'CAST': 'BROADCAST',
    'MSG':  'MESSAGE'
};

// Pure classifier bound to the fee-quote deny/exempt sets. Applies the SAME normalization
// computeFeeQuote uses (trim, uppercase, single-pass de-alias), then returns exactly one of
// 'denied' | 'exempt' | 'quotable'. Deny-before-exempt ordering is preserved so this is the one
// classification path both the public feequote gate and the conformance test read.
function classifyFeeQuoteAction(action){
    let a = String(action == null ? '' : action).trim().toUpperCase();
    if(Object.prototype.hasOwnProperty.call(ACTION_ALIASES, a))
        a = ACTION_ALIASES[a];
    if(FEE_QUOTE_DENYLIST.has(a)) return 'denied';
    if(FEE_QUOTE_EXEMPT.has(a))   return 'exempt';
    return 'quotable';
}

// Load indexer actions
const address          = require('./actions/address.js');
const airdrop          = require('./actions/airdrop.js');
const batch            = require('./actions/batch.js');
const bet              = require('./actions/bet.js');
const bet_expire       = require('./actions/bet_expire.js');
const broadcast        = require('./actions/broadcast.js');
const callback         = require('./actions/callback.js');
const coinpay          = require('./actions/coinpay.js');
const coinpay_expire   = require('./actions/coinpay_expire.js');
const destroy          = require('./actions/destroy.js');
const dispenser        = require('./actions/dispenser.js');
const dispenser_close  = require('./actions/dispenser_close.js');
const dispenser_expire = require('./actions/dispenser_expire.js');
const dispense         = require('./actions/dispense.js');
const dividend         = require('./actions/dividend.js');
const file             = require('./actions/file.js');
const issue            = require('./actions/issue.js');
const link             = require('./actions/link.js');
const list             = require('./actions/list.js');
const message          = require('./actions/message.js');
const mint             = require('./actions/mint.js');
const order            = require('./actions/order.js');
const order_expire     = require('./actions/order_expire.js');
const order_match      = require('./actions/order_match.js');
const sleep            = require('./actions/sleep.js');
const send             = require('./actions/send.js');
const swap             = require('./actions/swap.js');
const swap_expire      = require('./actions/swap_expire.js');
const swap_match       = require('./actions/swap_match.js');
const cross_settle     = require('./actions/cross_settle.js');
const sweep            = require('./actions/sweep.js');
const unknown          = require('./actions/unknown.js');

// VM actions
const deploy             = require('./actions/deploy.js');
const execute            = require('./actions/execute.js');
const deposit            = require('./actions/deposit.js');
const withdraw           = require('./actions/withdraw.js');
const vote               = require('./actions/vote.js');

// VM runtime
let XChainVM;
try {
    XChainVM = require('xchain-vm');
} catch(e) {
    console.log('WARNING: xchain-vm not available; DEPLOY/EXECUTE will not run contract code', e);
}

// Staking actions
const stake              = require('./actions/stake.js');
const unstake            = require('./actions/unstake.js');
const delegate           = require('./actions/delegate.js');
const collect            = require('./actions/collect.js');
const slash              = require('./actions/slash.js');

// PRICE action (validator snapshots and user oracle prices)
const price              = require('./actions/price.js');

// External attestation framework (single action; v0=request, v1=response, v2=expire)
const attest             = require('./actions/attest.js');

// ANCHOR: DOGE-only on-chain state commitments (v0=checkpoint, v1=+archive, v2=continuation)
const anchor             = require('./actions/anchor.js');

// Cross-chain contract calls: XCALL (source-chain request/expiry) + XEXEC
// (target-chain mirror-driven execution injection)
const xcall              = require('./actions/xcall.js');
const xexec              = require('./actions/xexec.js');

// Full-node possession-proof verdict (verified-validator tier)
const nodeproof          = require('./actions/nodeproof.js');
const PreflightMemo      = require('./preflightMemo.js');

class Actions {

    constructor(indexer){
        this.config    = indexer.config;
        this.util      = indexer.util;
        this.mapper    =  indexer.mapper;
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;
        this.hubDb     = indexer.hubDb || null;

        // hub client pushes PRICE data to xchain-hub
        this.hubClient = indexer.hubClient || null;

        this.protocolChanges = indexer.protocolChanges;

        // utxo-tracker client used by DISPENSER fresh-address check
        this.utxoTracker = indexer.utxoTracker || null;

        // Public validity-first pre-flight verdict memo , keyed on
        // (action, params, source, blockIndex); a new tip changes the key.
        this._preflightMemo = new PreflightMemo(
            parseInt(process.env.INDEXER_PREFLIGHT_MEMO_MAX, 10) || 256);

        // Create action instances and pass database connections
        this.actionAddress         = new address(this);
        this.actionAirdrop         = new airdrop(this);
        this.actionBatch           = new batch(this);
        // this.actionBet             = new bet(this);
        this.actionBroadcast       = new broadcast(this);
        this.actionCallback        = new callback(this);
        this.actionCoinpay         = new coinpay(this);
        this.actionCoinpayExpire   = new coinpay_expire(this);
        this.actionDestroy         = new destroy(this);
        this.actionDispenser       = new dispenser(this);
        this.actionDispenserClose  = new dispenser_close(this);
        this.actionDispenserExpire = new dispenser_expire(this);
        this.actionDispense        = new dispense(this);
        this.actionFile            = new file(this);
        this.actionDividend        = new dividend(this);
        this.actionIssue           = new issue(this);
        this.actionLink            = new link(this);
        this.actionList            = new list(this);
        this.actionMessage         = new message(this);
        this.actionMint            = new mint(this);
        this.actionBet             = new bet(this);
        this.actionBetExpire       = new bet_expire(this);
        this.actionOrder           = new order(this);
        this.actionOrderExpire     = new order_expire(this);
        this.actionOrderMatch      = new order_match(this);
        this.actionSleep           = new sleep(this);
        this.actionSend            = new send(this);
        this.actionSwap            = new swap(this);
        this.actionSwapExpire      = new swap_expire(this);
        this.actionSwapMatch       = new swap_match(this);
        this.actionCrossSettle     = new cross_settle(this);
        this.actionSweep           = new sweep(this);
        this.actionUnknown         = new unknown(this);

        // VM runtime
        if(XChainVM){
            this.vm = new XChainVM({
                // Run every contract in a forked worker process. A contract that
                // aborts V8 (process-wide SIGABRT, e.g. a bulk allocation that
                // bypasses the isolate memory limit) then crashes only the worker,
                // never this indexer; the executor returns a deterministic
                // resource-failure result (gasUsed = ceiling) and respawns, so the
                // block still advances. REQUIRES the bundled xchain-vm to support
                // process isolation (process-executor.js / vm-worker.js).
                execution:   'subprocess',
                gasSchedule: this.config['GAS_SCHEDULE'],
                gasCeiling:  1000000,
                limits: {
                    maxCpuTimeMs:      30000,
                    maxMemory:         8,
                    maxEmissions:      50,
                    maxStateKeys:      10000,
                    maxStateValueSize: 65536,
                    // Canonical MAX_CODE_SIZE: single-sourced from deploy.js (which
                    // pins xchain-documentation/protocol/constants.js) so the isolate
                    // limit can never drift from the DEPLOY-time byte-length check.
                    maxCodeSize:       deploy.MAX_CODE_SIZE
                }
            });
        } else {
            this.vm = null;
        }

        // Consensus-runtime gate (non-fatal): the VM produces some
        // contract-observable bytes (native V8 error text, ICU-backed
        // primitives) that are NOT spec-mandated and vary across engine
        // versions. A validator on an off-pin V8/ICU can commit different
        // bytes for the same contract → divergent contract_hash → fork. We
        // warn loudly rather than refuse to start, so an operator notices the
        // hazard without an engine mismatch silently halting the chain. The
        // hard gate is the CI test (xchain-vm consensus-runtime-gate.test.js).
        if(this.vm && typeof XChainVM.checkConsensusRuntime === 'function'){
            const rt = XChainVM.checkConsensusRuntime();
            if(!rt.ok)
                console.log('WARNING: ' + XChainVM.describeRuntimeMismatch(rt));
        }

        // VM action instances
        this.actionDeploy           = new deploy(this);
        this.actionExecute          = new execute(this);
        this.actionDeposit          = new deposit(this);
        this.actionWithdraw         = new withdraw(this);
        this.actionVote             = new vote(this);

        // Staking action instances
        this.actionStake            = new stake(this);
        this.actionUnstake          = new unstake(this);
        this.actionDelegate         = new delegate(this);
        this.actionCollect          = new collect(this);
        this.actionSlash            = new slash(this);

        // PRICE action instance
        this.actionPrice            = new price(this);

        // Attestation framework action instance (single handler dispatches v0/v1/v2 internally)
        this.actionAttest           = new attest(this);

        // ANCHOR action instance (single handler dispatches v0/v1/v2 internally)
        this.actionAnchor           = new anchor(this);

        // NODEPROOF: full-node possession-proof verdict handler
        this.actionNodeproof        = new nodeproof(this);

        // Cross-chain contract call instances (XCALL dispatches v0/v2 internally;
        // XEXEC is the target-chain injection handler)
        this.actionXcall            = new xcall(this);
        this.actionXexec            = new xexec(this);

        // ACTION aliases: copied from the single module-level ACTION_ALIASES source (#3133,
        // was a hand-duplicated literal block that the 'single source of truth' comment
        // falsely claimed was a copy). Dispatch de-aliases through this.actionAliases and
        // classifyFeeQuoteAction through ACTION_ALIASES; both now derive from one constant.
        this.actionAliases = Object.assign({}, ACTION_ALIASES);

        // Lightweight in-process observability counters: accepted and rejected counts per
        // ACTION type, accumulated since this instance started. Pure in-memory, never
        // persisted, and never read on the consensus-hashed path, so they cannot affect
        // ledger output. Exposed via getActionCounters() for the health endpoint.
        this._actionCounters = {};

    }

    // Generalized function to handle processing a transaction
    // @param tx             object     Transaction object
    // @param tx.source      string     Source address
    // @param tx.data        string     Action `data`
    // @param tx.tx_hash     string     Transaction hash
    // @param tx.block_index integer    Block index of tx
    // isGenesis flags a synthetic genesis-bootstrap action (genesis.js): it is not decoded
    // from a real coin transaction, so it is fee-exempt and its TRANSFER owner may be a
    // wrong-network address on regtest. The flag is copied onto `data` (data['IS_GENESIS'])
    // and read by issue.js. Always false for real decoded transactions.
    async processTransaction(tx, isGenesis = false){
        let error       = false;
        let params      = String(tx.data).split('|');
        let source      = tx.source;
        let destination = tx.destination;
        let amount      = tx.amount;
        let tx_hash     = tx.tx_hash;
        let tx_data     = tx.data;
        let tx_vout     = tx.vout;
        let coin        = this.config['COIN'];
        let block_index = tx.block_index;
        let block_time  = tx.block_time;

        // Create database records and get ids for tx_hash and source address.
        // Address creation is sequential (NOT Promise.all) so the explicit dense
        // counter (getNextAddressId) assigns address_ids in a deterministic
        // source-before-destination order on every node. The counter is read-then-insert
        // per call, so concurrent INSERTs on separate pool connections would race and
        // assign ids in an unpredictable order, producing per-node mismatches that
        // feed the consensus ledger hash and fork it across validators.
        await this.indexerDb.createAddress(source);
        await this.indexerDb.createAddress(destination);
        await this.indexerDb.createTransaction(tx_hash);

        // Trim whitespace from any PARAMS
        params.forEach(function(value, idx){
            params[idx] = String(value).trim();
        });

        // Extract ACTION from PARAMS
        let action = String(params.shift()).toUpperCase();

        // Set correct ACTION for any aliases
        for(var alias in this.actionAliases){
            if(action==alias)
                action = this.actionAliases[alias];
        }

        // Legacy compatibility: VERSION 0 default injection for BTNS-style legacy
        // ISSUE/MINT/SEND that carry no explicit VERSION field. This is permanent
        // consensus behaviour, not a pre-release shim; do NOT remove.
        if(['ISSUE','MINT','SEND'].includes(action) && this.util.isLegacyActionFormat(params))
            params.splice(0,0,0);

        // Extract FORMAT from PARAMS
        let format = this.util.getFormatVersion(params[0]);

        // Define basic ACTION transaction data object
        let data = {};
        data['ACTION']           = action;      // Action (ISSUE, MINT, SEND, etc)
        data['FORMAT']           = format;      // Action FORMAT (0-255)
        data['BLOCK_INDEX']      = block_index; // Block index 
        data['BLOCK_TIME']       = block_time;  // Block time (seconds since epoch) 
        data['SOURCE']           = source;      // Source address
        data['COIN']             = coin;        // COIN network
        data['COIN_DESTINATION'] = destination; // COIN Destination address
        data['COIN_AMOUNT']      = amount;      // Amount of native COIN
        data['TX_HASH']          = tx_hash;     // Transaction Hash
        data['TX_VOUT']          = tx_vout;     // Transaction vout index
        data['TX_DATA']          = tx_data;     // Raw tx data string
        data['RAW_DATA']         = tx.raw_data; // Raw payload bytes (FILE ciphertext, etc.)
        data['FEE']              = tx.fee;      // Miners fee in satoshis
        data['SOURCE_PUBKEY']    = tx.source_pubkey; // Public key for the source address
        data['TX_OUTPUTS']       = tx.tx_outputs || []; // Full native-coin output set (fee detection)
        data['IS_GENESIS']       = isGenesis === true;  // synthetic genesis bootstrap action (genesis.js)
        // Guard-inert marker for the public feequote dry-run: when set, a controller guard
        // refuses at the _invokeController chokepoint instead of entering the VM (utility.js),
        // so the unauthenticated feequote endpoint cannot run caller-influenced contract code
        // while holding the block-loop mutex. Sourced from tx.guard_inert, which only
        // computeFeeQuote's synthetic tx carries; ALWAYS false for real decoded transactions.
        data['GUARD_INERT']      = tx.guard_inert === true;

        // Treat plain BTC transactions (empty data) as DISPENSE triggers
        // The decoder records these when the destination matches an active dispenser address
        if(action == '' && !this.util.isNull(destination)){
            action = 'DISPENSE';
            data['ACTION'] = action;
        }

        // Validate Action is known
        if(!this.protocolChanges.isDefined(action)){
            error = 'invalid: Unknown ACTION';
            data['ACTION'] = action = 'UNKNOWN';
        }

        // Verify ACTION is activated
        if(!error && await this.protocolChanges.isEnabled(action, tx.block_index) == false)
            error = 'invalid: ACTION is not yet activated';

        // Create a record of this transaction in the transactions table
        data['TX_INDEX'] = await this.indexerDb.createTxIndex(data);

        // Create a record of this action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(data);

        // Process the specific ACTION commands
        await this.processAction(action, params, data, error);

        // Return the populated data object. The block loop ignores this; the read-only
        // feequote dry-run (computeFeeQuoteDryRun) reads data['STATUS'] to report validity.
        return data;
    }

    // Generalized function to handle parsing and processing a specific ACTION
    // NOTE: If the action is UNKNOWN, fail silently (prevent crashing indexer on unsupported actions)
    async processAction(action, params, data, error){
        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // Deterministic index-id pre-pass: register the NEW wire-field addresses this
        // action introduces, in byte-sorted VALUE order, BEFORE the handler runs. This
        // pins each new address's index id to the VALUE it carries rather than to the
        // order the handler happens to intern it, so the wire ^<id> address form resolves
        // identically on every node and across code refactors. Runs after createActionIndex
        // (which already registered SOURCE first) and covers the BATCH path too, since
        // batch.js dispatches each sub-action back through processAction.
        await this.assignActionAddressIds(action, params, data, error);

        // Process the action with the correct handler
        if(action=='ADDRESS')            await this.actionAddress.parse(params, data, error);
        if(action=='AIRDROP')            await this.actionAirdrop.parse(params, data, error);
        if(action=='BATCH')              await this.actionBatch.parse(params, data, error);
        if(action=='BET')                await this.actionBet.parse(params, data, error);
        if(action=='BET_EXPIRE')         await this.actionBetExpire.parse(params, data, error);
        if(action=='BROADCAST')          await this.actionBroadcast.parse(params, data, error);
        if(action=='CALLBACK')           await this.actionCallback.parse(params, data, error);
        if(action=='COINPAY')             await this.actionCoinpay.parse(params, data, error);
        if(action=='COINPAY_EXPIRE')     await this.actionCoinpayExpire.parse(params, data, error);
        if(action=='DESTROY')            await this.actionDestroy.parse(params, data, error);
        if(action=='DISPENSER')          await this.actionDispenser.parse(params, data, error);
        if(action=='DISPENSER_CLOSE')    await this.actionDispenserClose.parse(params, data, error);
        if(action=='DISPENSER_EXPIRE')   await this.actionDispenserExpire.parse(params, data, error);
        if(action=='DISPENSE')           await this.actionDispense.parse(params, data, error);
        if(action=='DIVIDEND')           await this.actionDividend.parse(params, data, error);
        if(action=='FILE')               await this.actionFile.parse(params, data, error);
        if(action=='ISSUE')              await this.actionIssue.parse(params, data, error);
        if(action=='LIST')               await this.actionList.parse(params, data, error);
        if(action=='LINK')               await this.actionLink.parse(params, data, error);
        if(action=='MINT')               await this.actionMint.parse(params, data, error);
        if(action=='MESSAGE')            await this.actionMessage.parse(params, data, error);
        if(action=='ORDER')              await this.actionOrder.parse(params, data, error);
        if(action=='ORDER_EXPIRE')       await this.actionOrderExpire.parse(params, data, error);
        if(action=='ORDER_MATCH')        await this.actionOrderMatch.parse(params, data, error);
        if(action=='SLEEP')              await this.actionSleep.parse(params, data, error);
        if(action=='SEND')               await this.actionSend.parse(params, data, error);
        if(action=='SWAP')               await this.actionSwap.parse(params, data, error);
        if(action=='SWAP_EXPIRE')        await this.actionSwapExpire.parse(params, data, error);
        if(action=='SWAP_MATCH')         await this.actionSwapMatch.parse(params, data, error);
        if(action=='CROSS_SETTLE')       await this.actionCrossSettle.parse(params, data, error);
        if(action=='SWEEP')              await this.actionSweep.parse(params, data, error);
        if(action=='UNKNOWN')            await this.actionUnknown.parse(params, data, error);

        // VM actions
        if(action=='DEPLOY')             await this.actionDeploy.parse(params, data, error);
        if(action=='EXECUTE')            await this.actionExecute.parse(params, data, error);
        if(action=='DEPOSIT')            await this.actionDeposit.parse(params, data, error);
        if(action=='WITHDRAW')           await this.actionWithdraw.parse(params, data, error);
        if(action=='VOTE')               await this.actionVote.parse(params, data, error);

        // Staking actions (DELEGATE handles both rotate v0/v1 and revoke v2/v3 internally)
        if(action=='STAKE')              await this.actionStake.parse(params, data, error);
        if(action=='UNSTAKE')            await this.actionUnstake.parse(params, data, error);
        if(action=='DELEGATE')           await this.actionDelegate.parse(params, data, error);
        if(action=='COLLECT')            await this.actionCollect.parse(params, data, error);
        if(action=='SLASH')              await this.actionSlash.parse(params, data, error);

        // PRICE action (validator snapshots and user oracles)
        if(action=='PRICE')              await this.actionPrice.parse(params, data, error);

        // Attestation framework: handler dispatches on VERSION (v0=request, v1=response, v2=expire)
        if(action=='ATTEST')             await this.actionAttest.parse(params, data, error);

        // ANCHOR: DOGE-only on-chain state commitments (v0=checkpoint, v1=+archive, v2=continuation)
        if(action=='ANCHOR')             await this.actionAnchor.parse(params, data, error);

        // Cross-chain contract calls: XCALL (VM-emitted request / synthetic expiry),
        // XEXEC (system-injected, mirror-driven target-chain execution)
        if(action=='XCALL')              await this.actionXcall.parse(params, data, error);
        if(action=='XEXEC')              await this.actionXexec.parse(params, data, error);

        // Full-node possession-proof verdict (verified-validator tier)
        if(action=='NODEPROOF')          await this.actionNodeproof.parse(params, data, error);

        // Increment the in-memory observability counter for this action type. STATUS
        // is 'valid' for accepted actions and an 'invalid: ...' string (or undefined
        // when an earlier gate short-circuits) for rejected ones. This read happens
        // AFTER the handler has written its final status, so the bucket is accurate.
        // Pure observability: not on any hashed path and not persisted.
        let bucket = this._actionCounters[action];
        if(!bucket){
            bucket = { accepted: 0, rejected: 0 };
            this._actionCounters[action] = bucket;
        }
        if(data['STATUS'] === 'valid')
            bucket.accepted++;
        else
            bucket.rejected++;
    }

    // Return a snapshot of the per-type accepted/rejected counters accumulated since
    // this process started. The caller receives a plain object (not a live reference)
    // so mutations outside this class cannot corrupt the counters. Surfaced by the
    // health endpoint as a lightweight operational signal; never on any consensus path.
    getActionCounters(){
        let out = {};
        for(let type of Object.keys(this._actionCounters)){
            let b = this._actionCounters[type];
            out[type] = { accepted: b.accepted, rejected: b.rejected };
        }
        return out;
    }

    // Map an ACTION name to the handler whose `formats` strings (and setActionParams
    // positional layout) define the wire fields. Only handlers that parse with
    // util.setActionParams are listed: their fixed positional layout lets the pre-pass
    // extract field values IDENTICALLY to the handler. SEND / ISSUE / SWEEP / DEPLOY use
    // bespoke parsing (repeating recipients, variable-length constructor params, etc.),
    // so they are deliberately absent here and their new addresses keep deterministic
    // handler-order assignment (still reorg-safe via the explicit index-id counter).
    _setActionParamHandler(action){
        switch(action){
            case 'MINT':      return this.actionMint;
            case 'MESSAGE':   return this.actionMessage;
            case 'DISPENSER': return this.actionDispenser;
            case 'ORDER':     return this.actionOrder;
            case 'SWAP':      return this.actionSwap;
            // ADDRESS is intentionally absent: ADDRESS_REF_FIELDS has no 'ADDRESS' key,
            // so assignActionAddressIds returns early before ever reaching this switch.
            // A case here would be unreachable dead code.
            default:          return null;
        }
    }

    // Pre-pass: assign deterministic, value-sorted index ids to the NEW wire-field
    // addresses an action introduces. See the call site in processAction and the
    // consensus note in src/addressRefFields.js.
    async assignActionAddressIds(action, params, data, error){
        // Only assign during block processing: createAddress only does explicit-counter
        // (deterministic) assignment inside a transaction. Outside one this is a no-op.
        if(this.indexerDb.transactionConnection == null)
            return;
        // #4888: skip pre-handler-rejected actions (unknown / not-yet-activated). Such an
        // action never reaches its handler, so interning its wire-field addresses would mint
        // index ids for an action that does nothing. (A semantic rejection INSIDE the handler
        // still interns, by design: the pre-pass exists to pin id-assignment ORDER, and the
        // cross-version divergence that creates is foreclosed pre-launch by clean reindex.)
        if(error)
            return;
        let specs = ADDRESS_REF_FIELDS[action];
        if(!specs || specs.length === 0)
            return;
        // Resolve the wire fields exactly as the handler will. Multi-value (repeating
        // SEND recipients) and type-gated (LIST.ITEM) fields are skipped here and keep
        // handler-order assignment; the handler interns them in a fixed, cross-node
        // deterministic order. Only handlers with a fixed setActionParams layout are
        // resolved (see _setActionParamHandler).
        let handler = this._setActionParamHandler(action);
        if(!handler || !handler.formats)
            return;
        let format = data['FORMAT'];
        if(format === null || format === undefined || handler.formats[format] === undefined)
            return;
        let fields = this.util.setActionParams({}, params, handler.formats, format);
        // Collect single-value candidate address strings.
        let candidates = [];
        for(let spec of specs){
            if(spec.multi || spec.listType)
                continue;
            let val = fields[spec.field];
            if(this.util.isNull(val) || val === '')
                continue;
            // DEPLOY's BURN sentinel never reaches here (DEPLOY is not a setActionParams
            // handler), so no BURN resolution is needed in this path.
            candidates.push(String(val));
        }
        if(candidates.length === 0)
            return;
        // Drop already-known references and addresses that already hold an id; dedupe by
        // string value.
        let pending = [];
        let seen    = new Set();
        for(let val of candidates){
            // A wire ^<id> is already a reference to an existing id; never a new assignment.
            if(val.substring(0,1) === '^')
                continue;
            // Only real crypto addresses get index ids (contract C:<CHAIN>:<idx> and
            // config-pinned addresses are created on their own deterministic paths).
            if(!this.util.isCryptoAddress(val))
                continue;
            if(seen.has(val))
                continue;
            seen.add(val);
            // Already assigned (an earlier block, or SOURCE created in createActionIndex,
            // or an earlier candidate this action) -> skip.
            let existing = await this.indexerDb.getAddressId(val);
            if(existing != null)
                continue;
            pending.push(val);
        }
        if(pending.length === 0)
            return;
        // Byte (binary) sort by value: the consensus tiebreak (matches the utf8_bin
        // collation intent; independent of field layout and of any DB collation).
        pending.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
        // #4889: stamp from the SINGLE authoritative block source. createAddress defaults
        // blockIndex to this.indexerDb.blockIndex (= blockToParse), the same source
        // createActionIndex uses to stamp SOURCE, so every id created in a block lands under
        // one block_index value and the rollback "WHERE block_index >= ?" delete cannot split
        // a block's ids. data['BLOCK_INDEX'] equals it today; warn loudly if it ever diverges.
        if(data['BLOCK_INDEX'] != this.indexerDb.blockIndex)
            console.warn('Index id invariant: action BLOCK_INDEX (' + data['BLOCK_INDEX'] +
                ') != indexer blockIndex (' + this.indexerDb.blockIndex + '); stamping from indexer blockIndex.');
        // Assign each the next explicit dense id, in sorted order, stamped at this block.
        for(let addr of pending)
            await this.indexerDb.createAddress(addr);
    }

    // Run the REAL action handler for a proposed action against current committed state inside
    // a forced-rollback transaction, and extract the handler's verdict plus the
    // XCHAIN-denominated fee it staged (the `fees` row, read back before rollback discards it).
    // The single dry-run engine behind BOTH the public feequote pre-flight (computeFeeQuote)
    // and the raw regtest-only feequotedryrun RPC. Never persists; and because in-transaction
    // index_* ids are assigned dense-explicitly (db.createAddress/createTicker MAX(id)+1) they
    // roll back with the row, so a dry-run leaves no id skew. That retires the 06-18
    // unindexed-source refusal: quoting from a fresh (never-seen) address is a supported case.
    //
    // `feeOutputs` is the synthetic tx's native-coin output set. When the caller supplies none
    // and `probeFeeDestination` is set, a deliberately OVERSIZED fee output is injected so
    // LTC/DOGE's mandatory-native detection sees payment-mode 1 and the handler validates and
    // records the fee without an XCHAIN debit. The on-chain acceptance rule is lower-bound-only
    // (util.validateNativeCoinFee), so oversizing can never be the reason a quote rejects;
    // sizing the real output is the caller's job (computeFeeQuote prices the extracted fee).
    //
    // `feeBalanceTick` (optional) asks for the SOURCE's balance of that tick, read at
    // pre-action state inside the same transaction the handler runs in. Advisory only: it
    // never changes the verdict, and it degrades to null rather than failing the run.
    //
    // Returns { blockIndex, blockTime, status, error, xchainFee, sourceFeeBalance } where
    // xchainFee is the handler-recorded fee ('0' for a valid zero-fee action, null when the
    // run never got far enough to stage one).
    async _dryRunAction({ action, params, source, feeOutputs, probeFeeDestination, timeoutMs, label, guardInert, feeBalanceTick }){
        let blockIndex = await this.indexerDb.getLatestBlockIndex();
        let blockTime  = await this.indexerDb.getBlockTime(blockIndex);

        let txOutputs = Array.isArray(feeOutputs) ? feeOutputs : [];
        if(txOutputs.length === 0 && probeFeeDestination)
            // Decimal coin units (decoder-shaped outputs); 21M coin exceeds any fee band.
            txOutputs = [{ address: probeFeeDestination, value: '21000000.00000000' }];

        // Synthetic transaction mirroring what the decoder feeds processTransaction. The tx_hash
        // is unique + clearly marked; it and any handler writes vanish on rollback.
        let syntheticTx = {
            data:          [action].concat(params).join('|'),
            source:        source,
            destination:   null,
            amount:        null,
            tx_hash:       'DRYRUN-' + blockIndex + '-' + (this._dryRunSeq = (this._dryRunSeq || 0) + 1),
            vout:          0,
            block_index:   blockIndex,
            block_time:    blockTime,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    txOutputs,
            raw_data:      null,
            // Marks a run whose controller guards must NOT enter the VM (the public
            // feequote path; see computeFeeQuote). Set only here on the synthetic tx and
            // only when the caller asks, so it is absent from every decoder-fed block tx
            // and from the API-key-gated feequotedryrun path (which opts to run the VM).
            guard_inert:   guardInert === true
        };

        let status = null, feeRecord = null, dryRunError = null, sourceFeeBalance = null;
        // beginTransaction acquires the db transaction mutex (serializes against block processing
        // and reorgs); the finally guarantees rollback + lock release even on a handler throw.
        await this.indexerDb.beginTransaction();
        // Fence the dry-run's writes to THIS transaction's epoch (M-16), same as the block
        // loop: on watchdog timeout the finally below rolls back and bumps the epoch, but the
        // abandoned processTransaction can still resume and try to write on the shared
        // connection, which by then may belong to a REAL block's transaction. The stale epoch
        // rejects those zombie writes inside the db layer before they reach the driver.
        let dryRunEpoch = this.indexerDb.currentTxEpoch();
        try {
            // : the payer's fee-token balance at PRE-action state, read inside this
            // transaction so it is the same snapshot the handler's own balance check reads.
            // Read-only by construction: getAddressId returns null for an address the ledger
            // has never seen (createAddress would WRITE one), so quoting from a fresh address
            // stays a pure read. Strictly advisory - any failure degrades to null and the
            // handler's verdict stands untouched.
            if(feeBalanceTick && !this.util.isNull(source)){
                try {
                    sourceFeeBalance = await this.indexerDb.runInTxEpoch(dryRunEpoch, async () => {
                        let addressId = await this.indexerDb.getAddressId(source);
                        if(addressId === null || addressId === undefined) return '0';
                        let tickId = await this.indexerDb.getTickerId(feeBalanceTick);
                        if(tickId === null || tickId === undefined) return null;
                        let balances = await this.indexerDb.getAddressBalances(addressId);
                        let balance  = balances ? balances[tickId] : null;
                        return (balance === null || balance === undefined) ? '0' : String(balance);
                    });
                } catch(e){
                    console.warn('dry-run fee-balance read failed: ' + ((e && e.message) ? e.message : e));
                    sourceFeeBalance = null;
                }
            }
            // Bound the synthetic run. The dry-run holds the shared _txLock for the whole
            // handler, so a stuck handler would otherwise wedge block advancement for the full
            // hang; on timeout the catch+finally roll back and release the lock within the
            // caller's bounded window instead.
            let dryRunProcessing = this.indexerDb.runInTxEpoch(dryRunEpoch,
                () => this.processTransaction(syntheticTx));
            // Keep the abandoned promise's late settlement (typically the epoch fence firing)
            // from surfacing as an unhandledRejection; the fence, not this handler, is what
            // stops the zombie's writes.
            dryRunProcessing.catch((e) => {
                console.warn('Abandoned fee-quote dry-run settled after watchdog: ' +
                    ((e && e.message) ? e.message : e));
            });
            let resultData = await this.util.withTimeout(
                dryRunProcessing,
                timeoutMs,
                label || ('feequote dry-run ' + (action || '')));
            status = (resultData && resultData['STATUS'] !== undefined) ? resultData['STATUS'] : null;
            // Extract the handler-computed fee while the transaction is still open (the row
            // vanishes on rollback). `amount` is XCHAIN-denominated in every payment mode.
            let actionIndex = (resultData && resultData['ACTION_INDEX'] !== undefined) ? resultData['ACTION_INDEX'] : null;
            if(actionIndex !== null)
                feeRecord = await this.indexerDb.getFeeRecord(actionIndex);
        } catch(e){
            dryRunError = 'handler threw: ' + ((e && e.message) ? e.message : e);
        } finally {
            await this.indexerDb.rollbackTransaction();
        }

        return {
            blockIndex: blockIndex,
            blockTime:  blockTime,
            status:     status,
            error:      dryRunError,
            xchainFee:  feeRecord ? String(feeRecord.amount)
                       : ((status === 'valid') ? '0' : null),
            sourceFeeBalance: sourceFeeBalance
        };
    }

    // Price an XCHAIN-denominated fee in the native coin via current oracle prices, and
    // (optionally) judge a proposed fee-output amount against the same lower-bound rule the
    // on-chain validator enforces (util.validateNativeCoinFee rejects only below min). Pure
    // pricing, shared by computeFeeQuote and computeFeeQuoteDryRun; extends and returns `base`.
    async _priceFeeQuote(base, xchainFeeRaw, feeOutputSats){
        let coin         = this.config['COIN'];
        let toleranceMin = this.util.bcnum(this.config['FEE_TOLERANCE_MIN'] || '0.95');
        let toleranceMax = this.util.bcnum(this.config['FEE_TOLERANCE_MAX'] || '1.10');

        let xchainFee  = this.util.bcnum(xchainFeeRaw == null ? '0' : xchainFeeRaw);
        base.xchainFee = this.util.bcformat(xchainFee, 8);

        // No protocol fee => nothing to pay in native coin.
        if(this.util.bclte(xchainFee, 0)){
            return Object.assign(base, {
                valid: true, error: null, oracleRound: 0,
                requiredFeeNative: '0.00000000', requiredFeeSats: 0,
                expectedNative: '0.00000000', minAcceptable: '0.00000000', maxAcceptable: '0.00000000'
            });
        }

        // Value it in native coin via current oracle prices (shared with validateNativeCoinFee).
        let blockIndex         = (base.blockIndex !== undefined && base.blockIndex !== null)
                               ? base.blockIndex : await this.indexerDb.getLatestBlockIndex();
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
        // : anchor the WHOLE price read (round selection, staleness, flag-day gate) on the
        // quoted block's own time, because that is the single quantity the on-chain check uses
        // (validateNativeCoinFee passes BLOCK_TIME). A pre-flight anchored on the operator's wall
        // clock answers a different question from the chain and disagrees with it in both
        // directions: it calls a pair stale during a reference-chain block drought that the chain
        // would price off the round the next block carries, and on any venue whose chain clock
        // runs ahead of real time the non-BTC time-keyed selection (block_timestamp <= refTime)
        // excludes every round the chain can see, leaving LTC/DOGE quotes structurally dead.
        // Wall clock is the fallback only when the quote carries no usable block time at all.
        let chainTime          = Number(base.blockTime);
        let refTime            = Number.isFinite(chainTime) ? chainTime : Math.floor(Date.now() / 1000);
        let prices = await this.util.getFeeOraclePrices(this.indexerDb, coin, blockIndex, refTime, maxPriceAgeSeconds);
        if(prices.error)
            return Object.assign(base, { valid: false, error: prices.error });

        let band = this.util.computeNativeFeeBand(xchainFee, prices.xchainUsdPrice, prices.coinUsdPrice, toleranceMin, toleranceMax);

        // Recommended output (what the client should pay). Satoshi rounding is dwarfed by the
        // tolerance band, so plain 8-dp formatting is safe (only under-MIN risks forfeiture).
        let requiredFeeNative = this.util.bcformat(band.expectedNative, 8);
        let requiredFeeSats   = Number(this.util.bcformat(this.util.bcmul(band.expectedNative, 100000000, 0), 0));

        // If the caller supplied a proposed output, judge it against the SAME lower-bound rule
        // the on-chain validator enforces (validateNativeCoinFee rejects only below min).
        let valid = true, error = null;
        if(feeOutputSats !== undefined && feeOutputSats !== null && String(feeOutputSats) !== ''){
            let paidCoin = this.util.bcdiv(this.util.bcnum(feeOutputSats), 100000000, 8);
            if(this.util.bclt(paidCoin, band.minAcceptable)){
                valid = false;
                error = 'native fee output too small (provided: ' + this.util.bcformat(paidCoin, 8) +
                        ', min: ' + this.util.bcformat(band.minAcceptable, 8) + ')';
            }
        }

        return Object.assign(base, {
            valid:             valid,
            error:             error,
            oracleRound:       prices.oracleRound,
            xchainUsdPrice:    this.util.bcformat(prices.xchainUsdPrice, 8),
            coinUsdPrice:      this.util.bcformat(prices.coinUsdPrice, 8),
            expectedNative:    requiredFeeNative,
            minAcceptable:     this.util.bcformat(band.minAcceptable, 8),
            maxAcceptable:     this.util.bcformat(band.maxAcceptable, 8),
            requiredFeeNative: requiredFeeNative,
            requiredFeeSats:   requiredFeeSats
        });
    }

    // True when this chain has no XCHAIN fee lane, so a protocol fee can ONLY be paid with a
    // native-coin output. Mirrors the runtime rule in utility.detectFeePaymentMode (BTC falls
    // back to an XCHAIN balance debit when no fee output is present; every other coin rejects).
    // Message-shaping only: nothing consensus-bearing reads this.
    _nativeFeeMandatory(){
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        if(!feeDestination || feeDestination === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') return false;
        return this.config['COIN'] !== 'BTC';
    }

    // Decode a DEPLOY's inline CODE_ENCODING to its UTF-8 source byte count, byte-identically to
    // deploy.js (same DEPLOY_BASE64_CODE flag-day gate, same canonical-base64 round-trip, same
    // lenient pre-activation hex). Only the SIZE is wanted, but the decode has to match exactly:
    // codeBytes is multiplied by VM_DEPLOY_PER_BYTE, so a decode that differs from the handler's
    // would quote a fee the chain does not accept. Returns { bytes } or { error } with the
    // handler's own verbatim reject string.
    async _decodeDeployCodeBytes(encoded, blockIndex){
        if(this.util.isNull(encoded))
            return { error: 'invalid: CODE_ENCODING (required)' };
        // Bound the decode before doing it: this runs on an unauthenticated endpoint, and no
        // encoding of a legal contract is longer than hex's 2x of MAX_CODE_SIZE. Anything past
        // that is over the size cap whatever it decodes to, so reject it without the work.
        if(String(encoded).length > deploy.MAX_CODE_SIZE * 2)
            return { error: 'invalid: CODE_ENCODING (exceeds max size)' };
        let code = '';
        if(await this.protocolChanges.isEnabled('DEPLOY_BASE64_CODE', blockIndex)){
            try {
                let b64 = String(encoded);
                code = Buffer.from(b64, 'base64').toString('utf8');
                // Buffer.from is lenient; round-trip so non-canonical base64 rejects here the
                // same way it will on-chain instead of being quoted a fee it would forfeit.
                if(Buffer.from(code, 'utf8').toString('base64') !== b64)
                    return { error: 'invalid: CODE_ENCODING (base64 decode failed)' };
            } catch(e){
                return { error: 'invalid: CODE_ENCODING (base64 decode failed)' };
            }
        } else {
            try {
                code = Buffer.from(String(encoded), 'hex').toString('utf8');
            } catch(e){
                return { error: 'invalid: CODE_ENCODING (hex decode failed)' };
            }
        }
        let bytes = Buffer.byteLength(code, 'utf8');
        if(bytes > deploy.MAX_CODE_SIZE)
            return { error: 'invalid: CODE_ENCODING (exceeds max size)' };
        return { bytes: bytes };
    }

    // Gas-schedule-only price for a FEE_QUOTE_STATIC action : the XCHAIN-denominated
    // protocol fee the handler stages BEFORE it enters the VM, which is the amount
    // validateNativeCoinFee checks the native output against. Reproduces the handler arithmetic
    // per DEPLOY format family:
    //   v0/v1 inline   - VM_DEPLOY_BASE + codeBytes * VM_DEPLOY_PER_BYTE (deploy.js)
    //   v2/v3 chunked  - VM_DEPLOY_BASE only; the v4 carriers already paid per-byte (deploy.js)
    //   v4 carrier     - CODE_PART bytes * VM_DEPLOY_PER_BYTE (deploy_chunk.js)
    //   EXECUTE        - VM_EXECUTE_BASE (execute.js; metered gas re-prices only the record)
    // Returns { gasCost, xchainFee }, { error } for an input the handler would reject outright,
    // or null when the action has no statically knowable fee.
    async _staticProtocolFee(action, params, blockIndex){
        let schedule = this.config['GAS_SCHEDULE'] || {};
        let gasCost  = null;

        if(action === 'EXECUTE'){
            gasCost = schedule.VM_EXECUTE_BASE;
        } else if(action === 'DEPLOY'){
            let format = this.util.getFormatVersion(params[0]);
            if(format === 0 || format === 1){
                let decoded = await this._decodeDeployCodeBytes(params[1], blockIndex);
                if(decoded.error) return { error: decoded.error };
                gasCost = schedule.VM_DEPLOY_BASE + (decoded.bytes * schedule.VM_DEPLOY_PER_BYTE);
            } else if(format === 2 || format === 3){
                gasCost = schedule.VM_DEPLOY_BASE;
            } else if(format === 4){
                // The carrier is billed on the base64 slice as carried, not on decoded bytes.
                gasCost = Buffer.byteLength(String(params[4] == null ? '' : params[4]), 'utf8')
                        * schedule.VM_DEPLOY_PER_BYTE;
            } else {
                return { error: 'invalid: VERSION (unknown)' };
            }
        }

        if(gasCost === null || !Number.isFinite(Number(gasCost)))
            return null;
        return { gasCost: gasCost, xchainFee: this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8) };
    }

    // The denied-action answer for the public feequote . FEE_QUOTE_STATIC actions get a
    // real, payable fee sized from the gas schedule (see _staticProtocolFee) so a client can build
    // the FEE_DESTINATION output on a native-fee chain; everything else keeps the flat refusal,
    // worded for the chain it is answering on (advising "pay it in XCHAIN" on LTC/DOGE, which have
    // no XCHAIN fee lane, is what made those actions unpayable rather than merely unverified).
    //
    // The engine is never invoked on this path, so `valid` is deliberately null, not true: a
    // sized fee is not a verdict. The one verdict this path CAN reach is a negative one (a caller-
    // supplied output below the band's minimum, or an input the handler rejects before the VM),
    // and those stay valid:false because they are computed, not assumed.
    async _staticFeeQuote(base, action, params, feeOutputSats){
        if(!FEE_QUOTE_STATIC.has(action))
            return Object.assign(base, { supported: false, valid: false, denied: true,
                error: 'native fee pre-flight not supported for ' + action +
                       (this._nativeFeeMandatory()
                        ? ' (no fee quote is available for it on ' + this.config['COIN'] + ')'
                        : ' (pay the fee in XCHAIN)') });

        let blockIndex = await this.indexerDb.getLatestBlockIndex();
        let blockTime  = await this.indexerDb.getBlockTime(blockIndex);
        base.blockIndex = blockIndex;
        base.blockTime  = blockTime;

        // A schedule that cannot price the action (a key missing or mistyped) fails CLOSED, back
        // to the refusal: quoting a fee from a half-read schedule is how an output gets under-sized.
        let staticFee = await this._staticProtocolFee(action, params, blockIndex);
        if(staticFee === null)
            return Object.assign(base, { supported: false, valid: false, denied: true,
                error: 'native fee pre-flight not supported for ' + action });

        base.staticQuote = true;
        base.validated   = false;
        if(staticFee.error)
            return Object.assign(base, { valid: false, error: staticFee.error, xchainFee: null });

        base.gasCost = staticFee.gasCost;
        let quote = await this._priceFeeQuote(base, staticFee.xchainFee, feeOutputSats);
        if(quote.valid === true) quote.valid = null;
        quote.note = action + ' is priced from the gas schedule without a dry-run: the fee is the ' +
            'protocol fee the chain checks the native-coin output against, but on-chain validity ' +
            'is NOT pre-judged (the public pre-flight never runs caller-supplied VM code).';
        return quote;
    }

    // Read-only native-coin fee pre-flight (the public `feequote` JSON-RPC). Phase 2: runs the
    // REAL action handler in a forced-rollback dry-run (_dryRunAction), so validity is
    // authoritative for any quotable action: class-A failures (fee sizing, oracle price) AND
    // class-B failures the Phase-1 estimator could never see (insufficient balance, taken
    // ticker, expired order, ...), surfaced verbatim in `error`/`status`. The fee is the
    // handler's own staged number, so there is no estimator to drift (estimateActionFee is
    // retired) and no supported-subset restriction. The VM/compound actions in
    // FEE_QUOTE_DENYLIST never reach the engine here; DEPLOY/EXECUTE instead get a
    // schedule-priced, verdict-free quote (FEE_QUOTE_STATIC / _staticFeeQuote) and XEXEC/BATCH
    // stay unquotable. Never persists.
    //
    // Guardrails for a public endpoint: quotes serialize against the block loop on the db
    // transaction mutex, so each is time-boxed (INDEXER_FEEQUOTE_TIMEOUT_MS, default 10s,
    // instead of the 300s block watchdog) and admission-capped
    // (INDEXER_FEEQUOTE_MAX_PENDING, default 8; beyond it callers get a retryable busy error
    // rather than a queue that could starve block processing).
    // `feeOutputSats` (optional) is the proposed output value in satoshis.
    async computeFeeQuote({ action, params, source, feeOutputSats }){
        let coin           = this.config['COIN'];
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        let toleranceMin   = this.util.bcnum(this.config['FEE_TOLERANCE_MIN'] || '0.95');
        let toleranceMax   = this.util.bcnum(this.config['FEE_TOLERANCE_MAX'] || '1.10');

        // Normalize exactly as processTransaction will before dispatch: trim then uppercase,
        // then resolve ACTION aliases. Otherwise a whitespace-padded or aliased name would
        // classify differently here than at dispatch, letting a caller skip the denylist and
        // still reach the real VM-compute pre-flight.
        action = String(action || '').trim().toUpperCase();
        for(var alias in this.actionAliases){
            if(action == alias)
                action = this.actionAliases[alias];
        }
        if(!Array.isArray(params)) params = String(params == null ? '' : params).split('|');
        params = params.map(v => String(v).trim());

        let base = {
            supported:      true,
            action:         action,
            coin:           coin,
            feeDestination: feeDestination,
            toleranceMin:   this.util.bcformat(toleranceMin, 8),
            toleranceMax:   this.util.bcformat(toleranceMax, 8)
        };

        // Native-coin fees are off unless a real FEE_DESTINATION is configured.
        if(!feeDestination || feeDestination === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
            return Object.assign(base, { supported: false, valid: false, error: 'native coin fee not enabled (no FEE_DESTINATION configured)' });

        // Single classification path (classifyFeeQuoteAction) shared with the conformance test;
        // it re-applies the same trim/uppercase/de-alias normalization (idempotent on the already
        // normalized `action` above) and preserves deny-before-exempt ordering.
        let feeClass = classifyFeeQuoteAction(action);

        if(feeClass === 'denied')
            return await this._staticFeeQuote(base, action, params, feeOutputSats);

        // Fee-exempt settlement/lifecycle actions: no protocol fee to price, and their required
        // native outputs can't be reproduced by the dry-run harness. Answer zero, skip the engine.
        if(feeClass === 'exempt')
            return Object.assign(base, {
                valid:             true,
                feeExempt:         true,
                xchainFee:         '0.00000000',
                requiredFeeNative: '0.00000000',
                requiredFeeSats:   0,
                note:              action + ' carries no protocol fee (settlement/lifecycle action); no native fee output required'
            });

        let maxPending = parseInt(process.env.INDEXER_FEEQUOTE_MAX_PENDING, 10) || 8;
        if((this._feeQuotePending || 0) >= maxPending)
            return Object.assign(base, { valid: false, busy: true, retryable: true,
                error: 'fee quote busy (' + maxPending + ' quotes already pending); retry shortly' });

        let timeoutMs = parseInt(process.env.INDEXER_FEEQUOTE_TIMEOUT_MS, 10) || 10000;
        this._feeQuotePending = (this._feeQuotePending || 0) + 1;
        let run;
        try {
            run = await this._dryRunAction({
                action, params, source,
                probeFeeDestination: feeDestination,
                timeoutMs: timeoutMs,
                label: 'feequote ' + action,
                // Public unauthenticated path: a controller guard must never enter the VM
                // here (see _invokeController). feequotedryrun deliberately omits this.
                guardInert: true
            });
        } finally {
            this._feeQuotePending--;
        }

        base.blockIndex = run.blockIndex;
        base.blockTime  = run.blockTime;
        base.status     = run.status;
        base.validated  = true;

        // A controlled token whose guard the feequote path refused (never entered the VM,
        // see _invokeController): the native-fee verdict genuinely depends on a controller
        // guard we do not run on this public surface, so report it as not natively quotable
        // rather than surfacing the sentinel as a spurious class-B invalidity.
        if(typeof run.status === 'string' && run.status.indexOf('FEE_QUOTE_CONTROLLER_UNSUPPORTED') !== -1)
            return Object.assign(base, { supported: false, valid: false,
                error: 'native fee pre-flight not supported for a controller-bound ' + action + ' (pay the fee in XCHAIN)' });

        // The handler's verdict is authoritative; its reason (class-A or class-B) verbatim.
        if(run.status !== 'valid')
            return Object.assign(base, {
                valid:     false,
                error:     run.error || run.status || 'dry-run produced no status',
                xchainFee: (run.xchainFee == null) ? null : this.util.bcformat(this.util.bcnum(run.xchainFee), 8)
            });

        return await this._priceFeeQuote(base, run.xchainFee, feeOutputSats);
    }

    // Raw fee/validity dry-run (the regtest-only `feequotedryrun` JSON-RPC). Same engine as the
    // public feequote (_dryRunAction) but with NO deny-list, NO admission cap, the caller's
    // literal `feeOutputs` (no probe injection: absent outputs exercise the BTC xchain-balance
    // fallback / LTC-DOGE mandatory-native rejection exactly as a real broadcast would), and
    // the full block watchdog as its timeout. That unrestricted surface (VM actions on demand,
    // attacker-shaped outputs) is why it stays OPT-IN: the RPC is unregistered unless
    // INDEXER_NETWORK=regtest AND INDEXER_ENABLE_DRYRUN is set (api.js ENABLE_DRYRUN), and is
    // API-key-gated when a key is configured. The 06-18 trial's AUTO_INCREMENT concern is
    // resolved (block hashes cover canonical strings; in-transaction index ids are dense-
    // explicit and roll back), so the gate is about compute, not consensus. Spec:
    // claude/reports/specs/2026-06-01_native-coin-fee-phase2-dryrun.md
    async computeFeeQuoteDryRun({ action, params, source, feeOutputs }){
        action = String(action || '').toUpperCase();
        if(!Array.isArray(params)) params = String(params == null ? '' : params).split('|');
        params = params.map(v => String(v).trim());

        let coin           = this.config['COIN'];
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        let nativeEnabled  = !!(feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

        let run = await this._dryRunAction({
            action, params, source, feeOutputs,
            probeFeeDestination: null,
            timeoutMs: this.config['BLOCK_PROCESS_TIMEOUT'],
            label: 'feequotedryrun ' + (action || '')
        });

        let valid  = (run.status === 'valid');
        let result = {
            supported:      true,
            dryRun:         true,
            action:         action,
            coin:           coin,
            feeDestination: feeDestination,
            blockIndex:     run.blockIndex,
            blockTime:      run.blockTime,
            valid:          valid,
            status:         run.status,
            error:          valid ? null : (run.error || run.status || 'dry-run produced no status'),
            xchainFee:      (run.xchainFee == null) ? null : this.util.bcformat(this.util.bcnum(run.xchainFee), 8),
            requiredFeeNative: null,
            feeSupported:   false
        };

        // Native-fee sizing for the extracted fee, merged without letting a pricing failure
        // (missing/stale oracle) overwrite the handler's validity verdict: on this raw surface
        // the handler verdict is the headline and sizing is best-effort.
        if(valid && nativeEnabled){
            // Carry blockTime: it is what _priceFeeQuote anchors the whole price read on (round
            // selection, staleness, flag-day gate). Without it this raw surface would silently
            // fall back to wall clock and quote off a different price set than the chain.
            let priced = await this._priceFeeQuote({ blockIndex: run.blockIndex, blockTime: run.blockTime }, run.xchainFee, undefined);
            if(priced.valid !== false){
                result.feeSupported      = true;
                result.oracleRound       = priced.oracleRound;
                result.xchainUsdPrice    = priced.xchainUsdPrice;
                result.coinUsdPrice      = priced.coinUsdPrice;
                result.expectedNative    = priced.expectedNative;
                result.minAcceptable     = priced.minAcceptable;
                result.maxAcceptable     = priced.maxAcceptable;
                result.requiredFeeNative = priced.requiredFeeNative;
                result.requiredFeeSats   = priced.requiredFeeSats;
            } else {
                result.feeError = priced.error;
            }
        }

        return result;
    }

    // Public validity-first pre-flight . Answers "would the indexer accept this action?"
    // decoupled from native-coin fee support: unlike computeFeeQuote (which returns
    // supported:false when no FEE_DESTINATION is configured, conflating "no fee config" with
    // "didn't run"), this reports supported:true whenever the handler actually ran, and its
    // verdict is the action's on-chain validity STATUS. Reuses the same forced-rollback dry-run
    // engine, the same admission cap + timeout, and guardInert:true (controller guards never
    // enter the VM on this unauthenticated surface). VM actions stay denylisted; settlement/
    // lifecycle actions stay feeExempt (no dry-runnable verdict). A block-height-keyed memo
    // (this._preflightMemo) collapses identical same-height re-runs. Echoes the dry-run's own
    // `xchainFee`  but no PRICING fields: converting that to a native-coin output is
    // computeFeeQuote's job. Surfaced publicly via the explorer's /{COIN}/api/preflight
    // proxy. Never persists (the dry-run always rolls back).
    //
    // FEE SETTLEMENT MODE . The verdict is only truthful if the dry-run settles the
    // protocol fee the way the payer's real transaction will. computeFeeQuote always injects
    // the probe fee output (it is pricing a NATIVE output, so native mode is the question it
    // asks), and pre-flight used to copy that unconditionally - which silently exempted every
    // quote from the XCHAIN balance debit and made "payer holds zero XCHAIN" invisible: the
    // endpoint answered valid, the wallet signed, the miner fee was spent, and the chain
    // indexed `invalid: insufficient funds (FEE)`. So the mode is chosen here:
    //   - `feeMode: 'native'`  injects the probe output (fee settles from a coin output).
    //   - `feeMode: 'xchain'`  injects nothing, so detectFeePaymentMode picks the XCHAIN
    //                          balance debit and the handler checks the payer's balance.
    //   - default: 'native' on a mandatory-native chain (LTC/DOGE, where no other mode
    //     exists), 'xchain' everywhere else - which is the mode a BTC wallet composes by
    //     default. A configured-but-unusable FEE_DESTINATION falls back to 'xchain'.
    // The mode is part of the memo key, so the two answers can never be served for each other.
    // Native-fee OUTPUT SIZING is still out of scope here (spec §4.3): this surface prices
    // nothing, and the SDK Tier-1 keeps native-fee-output aspects `unverified` regardless.
    async computePreflight({ action, params, source, feeMode }){
        let coin           = this.config['COIN'];
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        let probeDest      = (feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') ? feeDestination : null;
        let feeTick        = this.config['GAS'];

        let requestedMode  = String(feeMode == null ? '' : feeMode).trim().toLowerCase();
        let resolvedMode   = (requestedMode === 'native' || requestedMode === 'xchain')
                           ? requestedMode
                           : (this._nativeFeeMandatory() ? 'native' : 'xchain');
        // Native settlement needs somewhere to pay: with no usable FEE_DESTINATION the chain
        // itself falls back to the XCHAIN debit (utility.detectFeePaymentMode), so match it.
        if(resolvedMode === 'native' && !probeDest) resolvedMode = 'xchain';

        // Normalize identically to computeFeeQuote / dispatch (trim, uppercase, de-alias).
        action = String(action || '').trim().toUpperCase();
        for(var alias in this.actionAliases){
            if(action == alias) action = this.actionAliases[alias];
        }
        if(!Array.isArray(params)) params = String(params == null ? '' : params).split('|');
        params = params.map(v => String(v).trim());

        let base = { supported: true, action: action, coin: coin };

        // Same classification path as the fee-quote gate (deny-before-exempt).
        let feeClass = classifyFeeQuoteAction(action);
        if(feeClass === 'denied')
            return Object.assign(base, { supported: false, denied: true, valid: null,
                error: action + ' is not available on the public pre-flight endpoint (VM action; use the authenticated dry-run)' });
        if(feeClass === 'exempt')
            return Object.assign(base, { supported: false, feeExempt: true, valid: null,
                note: action + ' is a settlement/lifecycle action with no dry-runnable verdict' });

        // Verdict memo keyed on (action, params, source, blockIndex, feeMode). A new tip
        // changes the key; so does the settlement mode, whose verdicts genuinely differ.
        let blockIndex = await this.indexerDb.getLatestBlockIndex();
        let memoKey    = this._preflightMemo.key(action, params, source, blockIndex, resolvedMode);
        let cached     = this._preflightMemo.get(memoKey);
        if(cached) return Object.assign({}, cached, { cached: true });

        let maxPending = parseInt(process.env.INDEXER_FEEQUOTE_MAX_PENDING, 10) || 8;
        if((this._feeQuotePending || 0) >= maxPending)
            return Object.assign(base, { valid: null, busy: true, retryable: true,
                error: 'pre-flight busy (' + maxPending + ' dry-runs already pending); retry shortly' });

        let timeoutMs = parseInt(process.env.INDEXER_FEEQUOTE_TIMEOUT_MS, 10) || 10000;
        this._feeQuotePending = (this._feeQuotePending || 0) + 1;
        let run;
        try {
            run = await this._dryRunAction({
                action, params, source,
                probeFeeDestination: (resolvedMode === 'native') ? probeDest : null,
                timeoutMs: timeoutMs,
                label: 'preflight ' + action,
                guardInert: true,
                feeBalanceTick: feeTick
            });
        } finally {
            this._feeQuotePending--;
        }

        // A controller-bound token whose guard the public path refused to run: the validity
        // verdict genuinely depends on a guard we do not enter here. Surface it as a boolean
        // so the client falls through to its authenticated/certified tier rather than trusting
        // a guard-less verdict.
        let guardInert = (typeof run.status === 'string' && run.status.indexOf('FEE_QUOTE_CONTROLLER_UNSUPPORTED') !== -1);
        let valid      = (run.status === 'valid');

        // The dry-run already staged the handler's fee record, so echoing it costs nothing and
        // saves the caller a second round-trip to /feequote purely to disclose the fee .
        // `xchainFee` is the XCHAIN-denominated protocol fee in EVERY payment mode (the fee row
        // is always XCHAIN-denominated; native mode only changes how it is settled), which is
        // exactly what a confirm screen owes the user in the default XCHAIN mode. Sizing the
        // native-coin output stays computeFeeQuote's job: this surface never prices the fee, so
        // the probe output injected above cannot mislead. null when the run never staged a fee
        // (rejected before the handler recorded one); '0.00000000' for a valid zero-fee action.
        let xchainFee = (run.xchainFee == null) ? null : this.util.bcformat(this.util.bcnum(run.xchainFee), 8);

        // The payer's fee-token balance next to the fee it owes . Two callers need it:
        // a client that wants to say "you need N XCHAIN, you hold M" instead of relaying a bare
        // error string, and a native-mode caller, whose verdict above deliberately does NOT
        // depend on the XCHAIN balance but whose user may still want to see it. null when the
        // read was unavailable (no source, unknown fee tick), never a guessed zero.
        let feeTokenBalance = (run.sourceFeeBalance == null)
                            ? null : this.util.bcformat(this.util.bcnum(run.sourceFeeBalance), 8);
        // Only meaningful for the mode that settles from that balance; null (not false) in
        // native mode so nobody reads "cannot afford" into a fee that is not paid in XCHAIN.
        // Judged on the RAW values, not the 8dp display strings: a ledger balance carries more
        // precision than the display, and rounding it up to 8dp could call a fractionally
        // short payer affordable, which is exactly the false PASS this field exists to end.
        let feeAffordable = (resolvedMode !== 'xchain' || run.sourceFeeBalance == null || run.xchainFee == null)
                          ? null
                          : this.util.bcgte(this.util.bcnum(run.sourceFeeBalance), this.util.bcnum(run.xchainFee));

        let result = Object.assign(base, {
            valid:      guardInert ? null : valid,
            status:     run.status,
            error:      valid ? null : (run.error || run.status || 'dry-run produced no status'),
            guardInert: guardInert,
            feeExempt:  false,
            xchainFee:  xchainFee,
            feeMode:    resolvedMode,
            feeTick:    feeTick,
            feeTokenBalance: feeTokenBalance,
            feeAffordable:   feeAffordable,
            blockIndex: run.blockIndex,
            blockTime:  run.blockTime
        });

        this._preflightMemo.set(memoKey, result);
        return result;
    }

    // Read-only fee schedule + current oracle prices for native-coin fee payment. Lets a client
    // display the gas schedule / tolerance band and do a rough native-fee estimate before issuing
    // a per-action computeFeeQuote. Surfaced publicly via the explorer's /{COIN}/api/feeschedule
    // proxy. Never persists.
    async getFeeSchedule(){
        let coin           = this.config['COIN'];
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        let enabled        = !!(feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
        let blockIndex     = await this.indexerDb.getLatestBlockIndex();
        let blockTime      = await this.indexerDb.getBlockTime(blockIndex);

        // Current oracle prices (best-effort; a missing/stale feed doesn't fail the schedule call;
        // prices.available=false tells the client native fees can't be priced right now).
        // Anchored on the tip block's time for the same reason _priceFeeQuote is : this
        // view exists to predict what the chain will charge, so it has to read the prices the
        // chain reads, not the ones the operator's clock happens to agree with.
        let chainTime = Number(blockTime);
        let refTime   = Number.isFinite(chainTime) ? chainTime : Math.floor(Date.now() / 1000);
        let prices    = await this.util.getFeeOraclePrices(this.indexerDb, coin, blockIndex, refTime, maxPriceAgeSeconds);
        let priceInfo = prices.error
            ? { available: false, error: prices.error }
            : {
                available:   true,
                xchainUsd:   this.util.bcformat(prices.xchainUsdPrice, 8),
                coinUsd:     this.util.bcformat(prices.coinUsdPrice, 8),
                oracleRound: prices.oracleRound
              };

        return {
            coin:               coin,
            network:            this.config['NETWORK'],
            nativeFeeEnabled:   enabled,
            feeDestination:     enabled ? feeDestination : null,
            gasPrice:           this.config['GAS_PRICE'] || null,
            gasSchedule:        this.config['GAS_SCHEDULE'] || null,
            toleranceMin:       this.config['FEE_TOLERANCE_MIN'] || '0.95',
            toleranceMax:       this.config['FEE_TOLERANCE_MAX'] || '1.10',
            maxPriceAgeSeconds: maxPriceAgeSeconds,
            blockIndex:         blockIndex,
            // The instant the price read above was judged against, so a client can tell a stale
            // feed from an indexer whose tip is behind.
            blockTime:          blockTime,
            prices:             priceInfo
        };
    }

}

module.exports = Actions;
// Pure fee-quote classifier and read-only views of the deny/exempt sets, exported for the
// ActionManifestConformance test to bind classification to the dispatch table. The getters
// return fresh Sets so callers cannot mutate module state.
module.exports.classifyFeeQuoteAction = classifyFeeQuoteAction;
module.exports.getFeeQuoteDenylist    = () => new Set(FEE_QUOTE_DENYLIST);
module.exports.getFeeQuoteExempt      = () => new Set(FEE_QUOTE_EXEMPT);
module.exports.getFeeQuoteStatic      = () => new Set(FEE_QUOTE_STATIC);
