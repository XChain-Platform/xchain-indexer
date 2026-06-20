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

// Load indexer actions
const address          = require('./actions/address.js');
const airdrop          = require('./actions/airdrop.js');
const batch            = require('./actions/batch.js');
// const bet              = require('./actions/bet.js');
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

class Actions {

    // Handle constructing a class instance
    constructor(indexer){
        // Parse in indexer configuration
        this.config    = indexer.config;

        // Setup alias to the utility class instance
        this.util      = indexer.util;

        // Setup alias to the mapper class instance
        this.mapper    =  indexer.mapper;

        // Setup alias to the indexer database connection
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;
        this.hubDb     = indexer.hubDb || null;

        // Setup alias to the hub client (for pushing PRICE data to xchain-hub)
        this.hubClient = indexer.hubClient || null;

        // Setup alias to the indexer protocol changes instance
        this.protocolChanges = indexer.protocolChanges;

        // Setup alias to the xchain-utxo-tracker client (used by DISPENSER fresh-address check)
        this.utxoTracker = indexer.utxoTracker || null;

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
                    // Canonical MAX_CODE_SIZE: xchain-documentation/protocol/constants.js
                    maxCodeSize:       65536
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

        // Define ACTION aliases
        this.actionAliases = {};

        // Legacy BRC20 formats
        this.actionAliases['TRANSFER'] = 'SEND';

        // Short aliases
        this.actionAliases['ADDR'] = 'ADDRESS';
        this.actionAliases['DROP'] = 'AIRDROP';
        this.actionAliases['CAST'] = 'BROADCAST';
        this.actionAliases['MSG']  = 'MESSAGE';

    }

    // Generalized function to handle processing a transaction
    // @param tx             object     Transaction object
    // @param tx.source      string     Source address
    // @param tx.data        string     Action `data`
    // @param tx.tx_hash     string     Transaction hash
    // @param tx.block_index integer    Block index of tx
    async processTransaction(tx){
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
        // Address creation is sequential (NOT Promise.all) so AUTO_INCREMENT assigns
        // address_ids in a deterministic source-before-destination order on every node.
        // Concurrent INSERTs land on separate pool connections, where the engine may
        // assign ids in either order, producing per-node address_id mismatches that
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

        // DEBUG : Force a specific action
        // action = 'DIVIDEND';

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
        await this.assignActionAddressIds(action, params, data);

        // Process the action with the correct handler
        if(action=='ADDRESS')            await this.actionAddress.parse(params, data, error);
        if(action=='AIRDROP')            await this.actionAirdrop.parse(params, data, error);
        if(action=='BATCH')              await this.actionBatch.parse(params, data, error);
        // if(action=='BET')                await this.actionBet.parse(params, data, error);
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
            case 'ADDRESS':   return this.actionAddress;
            default:          return null;
        }
    }

    // Pre-pass: assign deterministic, value-sorted index ids to the NEW wire-field
    // addresses an action introduces. See the call site in processAction and the
    // consensus note in src/addressRefFields.js.
    async assignActionAddressIds(action, params, data){
        // Only assign during block processing: createAddress only does explicit-counter
        // (deterministic) assignment inside a transaction. Outside one this is a no-op.
        if(this.indexerDb.transactionConnection == null)
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
        // Assign each the next explicit dense id, in sorted order, stamped at this block.
        for(let addr of pending)
            await this.indexerDb.createAddress(addr, data['BLOCK_INDEX']);
    }

    // Read-only estimator for the XCHAIN-denominated protocol fee ("fees.AMOUNT") an action
    // would be charged, computed against current chain state WITHOUT persisting anything.
    // Powers the native-coin fee pre-flight (see computeFeeQuote) so a client can size the
    // FEE_DESTINATION output before broadcasting. Reuses the same util fee helpers + per-handler
    // format strings the live handlers use, to keep drift minimal.
    //
    // Phase 1 scope (where the fee is computable from params + current tip + config alone):
    //   - ISSUE create (format 0): issuance fee, gated by ISSUANCE_FEE/UNIFIED_FEES.
    //   - ORDER / SWAP / DISPENSER create (format 0): expiration + ownership-escrow premium.
    // Everything else (edits, DIVIDEND/AIRDROP whose fee depends on enumerated recipients/holders,
    // DEPLOY/EXECUTE, ...) returns { supported:false } so the client falls back to XCHAIN-balance
    // mode rather than guessing. A future full-handler dry-run will supersede this and remove the
    // duplication. Returns { supported, amount }.
    async estimateActionFee(data, params){
        let action     = data['ACTION'];
        let format     = data['FORMAT'];
        let blockIndex = data['BLOCK_INDEX'];
        let unsupported = { supported: false, amount: '0' };

        if(action === 'ISSUE'){
            // Only a fresh create charges the issuance fee.
            if(format != 0) return unsupported;
            data = this.util.setActionParams(data, params, this.actionIssue.formats, format);
            if(this.util.isNull(data['TICK'])) return unsupported;
            // An already-existing token is a re-issue/edit; no issuance fee.
            let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], blockIndex, data['ACTION_INDEX']);
            if(tokenInfo) return { supported: true, amount: '0' };
            if(!(await this.protocolChanges.isEnabled('ISSUANCE_FEE', blockIndex)))
                return { supported: true, amount: '0' };
            // Subtoken (TICK has a parent segment whose token exists) charges the subtoken rate.
            let parentInfo = false;
            let parts = String(data['TICK']).split('.');
            if(parts.length > 1){
                let parent = parts.slice(0, -1).join('.');
                parentInfo = await this.indexerDb.getTokenInfo(parent, blockIndex, data['ACTION_INDEX']);
            }
            if(await this.protocolChanges.isEnabled('UNIFIED_FEES', blockIndex)){
                let schedule = this.config['GAS_SCHEDULE'];
                let gasCost  = parentInfo ? schedule.ISSUE_SUBTOKEN : schedule.ISSUE;
                return { supported: true, amount: this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8) };
            }
            return { supported: true, amount: parentInfo ? this.config['ISSUANCE_FEE_SUBTOKEN'] : this.config['ISSUANCE_FEE_TOKEN'] };
        }

        if(action === 'ORDER' || action === 'SWAP' || action === 'DISPENSER'){
            // Edits (format 2) need the prior on-chain record, out of phase-1 scope.
            if(format != 0) return unsupported;
            let handler = (action === 'ORDER') ? this.actionOrder
                        : (action === 'SWAP')  ? this.actionSwap
                        :                        this.actionDispenser;
            data = this.util.setActionParams(data, params, handler.formats, format);
            let isOwnershipGive = (data['GIVE_OWNERSHIP'] == 1);
            if(await this.protocolChanges.isEnabled('UNIFIED_FEES', blockIndex)){
                let fee = 0;
                if(!this.util.isNull(data['EXPIRATION'])){
                    let exp = this.util.getUnifiedExpirationFee(data, null);
                    fee = this.util.bcadd(fee, exp.fee, 8);
                }
                if(isOwnershipGive){
                    let own = this.util.getOwnershipEscrowFee();
                    fee = this.util.bcadd(fee, own.fee, 8);
                }
                return { supported: true, amount: fee };
            }
            if(!this.util.isNull(data['EXPIRATION']))
                return { supported: true, amount: this.util.getExpirationFee(data, null) };
            return { supported: true, amount: '0' };
        }

        return unsupported;
    }

    // Read-only native-coin fee pre-flight. Given an action + its wire params, compute the
    // XCHAIN protocol fee against current state, value it in the native coin via current oracle
    // prices, and (optionally) judge a proposed fee-output amount against the same tolerance the
    // on-chain validator enforces. Never persists. The SDK/wallet use the result to size the
    // FEE_DESTINATION output and to refuse broadcasting a doomed (under-sized / stale-priced) tx.
    // `feeOutputSats` (optional) is the proposed output value in satoshis.
    async computeFeeQuote({ action, params, source, feeOutputSats }){
        let coin           = this.config['COIN'];
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        let toleranceMin   = this.util.bcnum(this.config['FEE_TOLERANCE_MIN'] || '0.95');
        let toleranceMax   = this.util.bcnum(this.config['FEE_TOLERANCE_MAX'] || '1.10');

        action = String(action || '').toUpperCase();
        if(!Array.isArray(params)) params = String(params == null ? '' : params).split('|');
        params = params.map(v => String(v).trim());

        let blockIndex = await this.indexerDb.getLatestBlockIndex();
        let blockTime  = await this.indexerDb.getBlockTime(blockIndex);

        let data = {};
        data['ACTION']       = action;
        data['FORMAT']       = this.util.getFormatVersion(params[0]);
        data['BLOCK_INDEX']  = blockIndex;
        data['BLOCK_TIME']   = blockTime;       // current tip; expiration-fee day count is anchored here
        data['SOURCE']       = source || null;
        data['COIN']         = coin;
        data['ACTION_INDEX'] = null;

        let base = {
            supported:      true,
            action:         action,
            coin:           coin,
            blockIndex:     blockIndex,
            blockTime:      blockTime,
            feeDestination: feeDestination,
            toleranceMin:   this.util.bcformat(toleranceMin, 8),
            toleranceMax:   this.util.bcformat(toleranceMax, 8)
        };

        // Native-coin fees are off unless a real FEE_DESTINATION is configured.
        if(!feeDestination || feeDestination === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
            return Object.assign(base, { supported: false, valid: false, error: 'native coin fee not enabled (no FEE_DESTINATION configured)' });

        // 1) XCHAIN-denominated economic fee for this action against current state.
        let estimate;
        try {
            estimate = await this.estimateActionFee(data, params);
        } catch(e){
            return Object.assign(base, { supported: false, valid: false, error: 'fee estimate failed: ' + ((e && e.message) ? e.message : e) });
        }
        if(!estimate.supported)
            return Object.assign(base, { supported: false, valid: false, error: 'native fee pre-flight not supported for ' + action + ' (pay the fee in XCHAIN)' });

        let xchainFee = this.util.bcnum(estimate.amount);
        base.xchainFee = this.util.bcformat(xchainFee, 8);

        // No protocol fee => nothing to pay in native coin.
        if(this.util.bclte(xchainFee, 0)){
            return Object.assign(base, {
                valid: true, error: null, oracleRound: 0,
                requiredFeeNative: '0.00000000', requiredFeeSats: 0,
                expectedNative: '0.00000000', minAcceptable: '0.00000000', maxAcceptable: '0.00000000'
            });
        }

        // 2) Value it in native coin via current oracle prices (shared with validateNativeCoinFee).
        //    Staleness is judged against wall-clock now so the freshness verdict reflects real-world
        //    price age (a pre-flight isn't tied to a specific future block).
        let nowEpoch           = Math.floor(Date.now() / 1000);
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
        let prices = await this.util.getFeeOraclePrices(this.indexerDb, coin, blockIndex, nowEpoch, maxPriceAgeSeconds);
        if(prices.error)
            return Object.assign(base, { valid: false, error: prices.error });

        let band = this.util.computeNativeFeeBand(xchainFee, prices.xchainUsdPrice, prices.coinUsdPrice, toleranceMin, toleranceMax);

        // Recommended output (what the client should pay). Satoshi rounding is dwarfed by the
        // tolerance band, so plain 8-dp formatting is safe (only under-MIN risks forfeiture).
        let requiredFeeNative = this.util.bcformat(band.expectedNative, 8);
        let requiredFeeSats   = Number(this.util.bcformat(this.util.bcmul(band.expectedNative, 100000000, 0), 0));

        // 3) If the caller supplied a proposed output, judge it against the SAME lower-bound rule
        //    the on-chain validator enforces (validateNativeCoinFee rejects only below min).
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

    // Read-only "phase-2" fee/validity dry-run. Runs the REAL action handler against current
    // committed state inside a forced-rollback transaction (serialized against the block loop +
    // reorg path via the db transaction mutex), so it reports AUTHORITATIVE validity for ANY
    // action, not just the estimateActionFee create-action subset. Native-fee sizing is taken
    // from computeFeeQuote (which covers the supported create actions); extracting the
    // handler-computed fee for every action is a follow-up. Never persists (always rolls back).
    //
    // TRIAL CAVEAT: InnoDB does NOT roll back AUTO_INCREMENT, so a dry-run that inserts a novel
    // index_* row (always at least the synthetic tx_hash) advances that counter even after
    // rollback. Safe on an isolated single-node regtest indexer; do NOT enable on a live
    // consensus node until the id-vs-string block-hash question is resolved. This constraint
    // is now enforced, not just advisory: the `feequotedryrun` RPC is unregistered unless
    // INDEXER_NETWORK=regtest AND INDEXER_ENABLE_DRYRUN is set (api.js ENABLE_DRYRUN), and is
    // API-key-gated when a key is configured. Spec:
    // claude/reports/specs/2026-06-01_native-coin-fee-phase2-dryrun.md
    async computeFeeQuoteDryRun({ action, params, source, feeOutputs }){
        action = String(action || '').toUpperCase();
        if(!Array.isArray(params)) params = String(params == null ? '' : params).split('|');
        params = params.map(v => String(v).trim());

        // Native-fee sizing (oracle-priced) for the supported create actions; non-fatal when the
        // action is outside the estimator's set (the dry-run still reports handler validity).
        let feeQuote;
        try {
            feeQuote = await this.computeFeeQuote({ action, params, source });
        } catch(e){
            feeQuote = { supported: false, valid: false, error: 'fee quote failed: ' + ((e && e.message) ? e.message : e) };
        }

        // Pre-check: refuse an un-indexed source so the dry-run never burns an index_addresses
        // AUTO_INCREMENT slot for an address the real chain never created (id-skew mitigation).
        let sourceId = this.util.isNull(source) ? null : await this.indexerDb.getAddressId(source);
        if(this.util.isNull(source) || this.util.isNull(sourceId))
            return Object.assign({}, feeQuote, { dryRun: false, valid: false, status: null, error: 'source address not indexed (dry-run requires a known source)' });

        let blockIndex = await this.indexerDb.getLatestBlockIndex();
        let blockTime  = await this.indexerDb.getBlockTime(blockIndex);

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
            tx_outputs:    Array.isArray(feeOutputs) ? feeOutputs : [],
            raw_data:      null
        };

        let status = null, dryRunError = null;
        // beginTransaction acquires the db transaction mutex (serializes against block processing
        // and reorgs); the finally guarantees rollback + lock release even on a handler throw.
        await this.indexerDb.beginTransaction();
        try {
            // Bound the synthetic run with the SAME watchdog the block loop wraps
            // processTransaction in (XChainIndexer BLOCK_PROCESS_TIMEOUT). The dry-run holds
            // the shared _txLock for the whole handler, so a stuck VM/isolate would otherwise
            // wedge block advancement for the full hang; on timeout the catch+finally roll back
            // and release the lock within a bounded window instead.
            let resultData = await this.util.withTimeout(
                this.processTransaction(syntheticTx),
                this.config['BLOCK_PROCESS_TIMEOUT'],
                'feequotedryrun ' + (action || ''));
            status = (resultData && resultData['STATUS'] !== undefined) ? resultData['STATUS'] : null;
        } catch(e){
            dryRunError = 'handler threw: ' + ((e && e.message) ? e.message : e);
        } finally {
            await this.indexerDb.rollbackTransaction();
        }

        let valid = (status === 'valid');
        return Object.assign({}, feeQuote, {
            dryRun:            true,
            blockIndex:        blockIndex,
            valid:             valid,
            status:            status,
            error:             valid ? null : (dryRunError || status || 'dry-run produced no status'),
            requiredFeeNative: (feeQuote && feeQuote.supported) ? feeQuote.requiredFeeNative : null,
            feeSupported:      !!(feeQuote && feeQuote.supported)
        });
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

        // Current oracle prices (best-effort; a missing/stale feed doesn't fail the schedule call;
        // prices.available=false tells the client native fees can't be priced right now).
        let nowEpoch = Math.floor(Date.now() / 1000);
        let prices   = await this.util.getFeeOraclePrices(this.indexerDb, coin, blockIndex, nowEpoch, maxPriceAgeSeconds);
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
            prices:             priceInfo
        };
    }

}

module.exports = Actions;
