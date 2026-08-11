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
 * XChain Platform Action - EXECUTE
 *
 * This action executes a method on a deployed smart contract.
 *
 * PARAMS:
 * - VERSION              - Format Version
 * - CONTRACT_ACTION_INDEX - Action index of the deployed contract
 * - METHOD               - Method name to call
 * - PARAMS               - Method parameters (pipe-delimited after method)
 *
 * FORMATS:
 * - 0 = Execute a contract method
 *
 ********************************************************************/

const crypto = require('crypto');
const ProviderRegistry = require('../attestation/providerRegistry.js');

// Per-provider deadline windows, injected into the VM gateway so a contract's
// attestation.request() rejects an over-limit deadlineBlocks at call time rather
// than landing on-chain and being silently rejected here by the DEADLINE check.
// Sourced from the single provider registry so the two caps cannot drift.
const PROVIDER_DEADLINE_WINDOWS = new ProviderRegistry().getDeadlineWindows();

// Gas ceiling for a top-level EXECUTE. Must match the gasCeiling the VM is
// constructed with in actions.js. (Previously a function-local const in
// parse(); module-scoped now that processEmission validates against it too.)
const GAS_CEILING = 1000000;

// Cross-contract call protocol constants. Vendored single source of truth:
// ../protocol/constants.js (byte-identical to xchain-documentation/protocol/
// constants.js, VM_MAX_CALL_DEPTH / VM_MIN_CALL_GAS). The VM enforces both at
// emit time (gateway-emit.js); these host-side checks are defense in depth so
// an older/compromised bundled VM cannot bypass them.
const PROTO = require('../protocol/constants.js');
const MAX_CALL_DEPTH = PROTO.VM_MAX_CALL_DEPTH;
const MIN_CALL_GAS   = PROTO.VM_MIN_CALL_GAS;

// Reserved method name a controller-bound token's contract must export. The
// indexer invokes it before a guarded native action (SEND/ORDER/SWAP/DISPENSER)
// on the token settles; the contract returns normally to ALLOW or reverts to
// DENY. Canonical: protocol/Controller_Bound_Tokens.md.
const GUARD_METHOD = 'guard';

// Cross-chain call (XCALL) host-side guards, mirrored from actions/xcall.js
// (canonical: xchain-documentation/protocol/constants.js).
const { XCALL_MIN_GAS, XCALL_MAX_GAS, XCALL_MAX_HOPS } = require('./xcall.js');
const { rethrowIfInfraFault } = require('./faultGuard.js');
const { SYNTH_EXEC_TX_HASH } = require('./execContext.js');

// Amount-bearing fields of every emittable action, mapping each amount param to the param
// that names the tick it is denominated in (item 5346). processEmission normalizes each to
// that tick's decimals before dispatch, so a contract that computes an over-precise amount
// (e.g. an AMM's 64-digit bignum payout) emits a tick-precise amount that passes
// isValidAmountFormat and matches what the ledger stores. ISSUE declares the new tick's
// decimals inline (`declared`) because the tick is not in the issues table yet. Emittable
// actions with no tick-denominated amount are absent (CALLBACK/XCALL/EXECUTE/BROADCAST/
// COINPAY/FILE/LINK/LIST/MESSAGE/SWEEP); COINPAY's amount is a native-coin value, not a tick.
// SLASH is handled inline, not here. KEEP IN SYNC with buildActionParams: the emission-map
// coverage test (test/unit/execute-emission-truncation.test.js) fails if a new amount-bearing
// emittable action is missing here.
const EMISSION_AMOUNT_FIELDS = {
    SEND:      [{ amount: 'quantity',   tick: 'tick' }],
    MINT:      [{ amount: 'quantity',   tick: 'tick' }],
    DESTROY:   [{ amount: 'quantity',   tick: 'tick' }],
    AIRDROP:   [{ amount: 'quantity',   tick: 'tick' }],
    DIVIDEND:  [{ amount: 'quantity',   tick: 'dividendTick' }],
    ORDER:     [{ amount: 'giveAmount', tick: 'giveTick' }, { amount: 'getAmount', tick: 'getTick' }],
    DISPENSER: [{ amount: 'giveAmount', tick: 'giveTick' }, { amount: 'giveEscrow', tick: 'giveTick' }, { amount: 'getAmount', tick: 'getTick' }],
    ATTEST:    [{ amount: 'feeAmount',  tick: 'feeTick' }],
    ISSUE:     [{ amount: 'maxSupply',  declared: true }, { amount: 'maxMint', declared: true }, { amount: 'mintSupply', declared: true }, { amount: 'callbackAmount', tick: 'callbackTick' }],
    // VOTE v0's DEPOSIT and GAS_ESCROW are denominated in the fixed GAS tick
    // (config GAS), not a tick named by a param; `gas: true` resolves it.
    // VOTE v1 (ballot) has neither param, so both fields skip as empty.
    VOTE:      [{ amount: 'deposit',    gas: true }, { amount: 'gasEscrow', gas: true }],
};

class Execute {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Monotonic per-instance ordinal appended to each controller-guard
        // savepoint name so every guard invocation gets a globally-unique name
        // within the transaction. (action_index, contractIndex, seq) alone can
        // repeat: up to three guards run on one SEND leg sharing the leg's seq,
        // and two can share a contractIndex (token-controller == address-controller,
        // or a self-send), so they would otherwise build the same name. The name
        // is a transaction-local artifact (never hashed, replicated, or persisted),
        // so a per-process counter that diverges across nodes is harmless.
        this.guardSavepointCounter = 0;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...';
    }

    // Handle parsing the EXECUTE transaction
    async parse(params, data, error){

        //  host-side assert: post-SYNTH_EXEC_TX_HASH every injected/emitted
        // execution context MUST carry a TX_HASH (real or synthesized via
        // actions/execContext.js). A hashless context reaching the VM silently
        // strands anything the contract emits (the VM derives a request_id, gas is
        // charged, then the indexer hard-rejects the emission), so a regressing
        // injector site is an infrastructure bug, not a contract outcome: throw a
        // fault-classed error that faultGuard propagates, halting the block loudly
        // instead of committing the stranding. Pre-activation the two legacy
        // hashless sites are still live, so the assert stays dark (replay safety).
        if(data['IS_EMISSION'] && !data['TX_HASH'] &&
           await this.actions.protocolChanges.isEnabled(SYNTH_EXEC_TX_HASH, data['BLOCK_INDEX'])){
            let fault = new Error('EXECUTE injected without TX_HASH (SYNTH_EXEC_TX_HASH active): ' +
                'injector sites must build their context via actions/execContext.js');
            fault.code = 'EXEC_CONTEXT_TX_HASH_MISSING';
            throw fault;
        }

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Extract params
        data['CONTRACT_ACTION_INDEX'] = params[1];
        data['METHOD']                = params[2];
        // Remaining params are method arguments
        data['METHOD_PARAMS']         = params.slice(3).join('|');

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Contract Validations
         ****************************************************************/

        // Verify CONTRACT_ACTION_INDEX is provided
        if(!error && this.util.isNull(data['CONTRACT_ACTION_INDEX']))
            error = 'invalid: CONTRACT_ACTION_INDEX (required)';

        // Verify CONTRACT_ACTION_INDEX is a canonical integer index (see deposit.js).
        // Host-derived reentrant calls (emitted EXECUTE / XEXEC) pass integer indexes,
        // which String() renders canonically, so this only rejects malformed wire input.
        if(!error && !/^\d+$/.test(String(data['CONTRACT_ACTION_INDEX'])))
            error = 'invalid: CONTRACT_ACTION_INDEX (format)';

        // Verify METHOD is provided
        if(!error && this.util.isNull(data['METHOD']))
            error = 'invalid: METHOD (required)';

        // Verify contract exists and is active
        let contractInfo = null;
        if(!error){
            contractInfo = await this.indexerDb.getContract(data['CONTRACT_ACTION_INDEX']);
            if(!contractInfo)
                error = 'invalid: CONTRACT_ACTION_INDEX (unknown)';
        }

        // Verify contract is valid/active
        if(!error && contractInfo){
            let contractStatus = await this.indexerDb.getStatusString(contractInfo.status_id);
            if(contractStatus !== 'valid')
                error = 'invalid: contract (not active)';
        }

        /*****************************************************************
         * Gas Fee Calculation
         ****************************************************************/

        let schedule = this.config['GAS_SCHEDULE'];
        // Base execution gas (actual VM gas will be metered during execution)
        let gasCost = schedule.VM_EXECUTE_BASE;
        let fee = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);

        // Get source address balances
        let gas = this.config['GAS'];
        let tokenInfo = await this.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Validate gas fee payment (native coin or XCHAIN balance).
        // System-injected EXECUTEs (e.g. attestation callbacks injected by
        // attest.js:_injectCallbackExecute) skip fee accounting: those run against
        // the request's gas_escrow, not the synthetic SOURCE's wallet. Fee deduction
        // from gas_escrow on the request row is not currently wired.
        let feePaymentMode = 2; // default: xchain balance
        let skipFee = Boolean(data['IS_EMISSION']);
        if(!error && !skipFee && tokenInfo && this.util.bcgt(fee, 0)){
            let pmMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(pmMode === 'native'){
                let tempFees = { AMOUNT: fee };
                let validation = await this.util.validateNativeCoinFee(data, tempFees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    feePaymentMode = 1;
                    data['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    data['NATIVE_COIN']        = validation.nativeCoin;
                    data['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(pmMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                if(!this.util.hasBalance(balances, tokenInfo['TICK_ID'], fee))
                    error = 'invalid: insufficient funds (GAS)';
            }
        }

        // Adjust balances to reduce by gas fee (only for XCHAIN deduction mode, never for system-injected)
        if(!error && !skipFee && tokenInfo && feePaymentMode === 2)
            balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], fee);

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        /*****************************************************************
         * VM Execution
         ****************************************************************/

        let gasUsed = gasCost;
        let emittedCount = 0;
        let vmError = null;
        let vmReturnValue = null;

        // Per-call gas ceiling. A cross-contract callee (reached via emit.execute)
        // runs against its caller-funded reservation (VM_GAS_LIMIT, validated in
        // processEmission); top-level EXECUTEs and system-injected callbacks (which
        // carry IS_EMISSION but no VM_GAS_LIMIT) use the protocol ceiling.
        let execCeiling = (data['IS_EMISSION'] && Number.isInteger(data['VM_GAS_LIMIT']))
            ? data['VM_GAS_LIMIT'] : GAS_CEILING;

        // Unused cross-contract gas reservations accumulated from this run's
        // emitted EXECUTEs (each callee's gasLimit minus what it was billed).
        // Refunded at the fee settlement below; zeroed if the emission savepoint
        // rolls back (no refunds on a failed tree).
        let nestedGasUnused = 0;

        // Fail CLOSED when the VM executor is unavailable, exactly as DEPLOY
        // (deploy.js: EXECUTOR_UNAVAILABLE) and the controller guard below
        // (runControllerGuard throws the same code) already do. Without this, a node whose
        // optional require('xchain-vm') failed (actions.js sets this.vm=null and
        // only warns) would SKIP the whole VM block below and record this EXECUTE
        // 'valid' with base gas, no state changes and no emissions, while the rest
        // of the fleet applies real ones: a host-condition-induced ledger fork.
        // Throwing EXECUTOR_UNAVAILABLE writes NO verdict at all - faultGuard and
        // XChainIndexer.js treat the code as an infra halt, so the block rolls back
        // and retries without committing until the native VM is rebuilt. Placed at
        // the VM block rather than earlier so an EXECUTE already rejected by a
        // VM-independent rule still records the same verdict as a healthy node.
        // No consensus rule changes, so no flag-day is needed.
        if(!error && contractInfo && !this.actions.vm){
            let e = new Error('execute VM executor unavailable');
            e.code = 'EXECUTOR_UNAVAILABLE';
            throw e;
        }

        if(!error && this.actions.vm && contractInfo){
            // Load contract state from DB. BLOCK_INDEX drives the state_key collation
            // flag-day (binary-collation reload at/after activation, so case-colliding
            // keys survive; see state_key_collation_activation.js).
            let contractState = await this.indexerDb.getContractState(data['CONTRACT_ACTION_INDEX'], data['BLOCK_INDEX']);

            // Load read-only data for gateway (price data lives in local hub DB when configured)
            let oracleData = await ((this.actions && this.actions.hubDb) || this.indexerDb).getOracleDataForVM(data['BLOCK_INDEX'], data['BLOCK_TIME'], parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800);
            let crossChainData = await this.indexerDb.getCrossChainDataForVM(data['BLOCK_INDEX']);
            // : expose each poll's electorate TICK in the VM snapshot at/after the flag-day.
            let pollTickVisible = await this.actions.protocolChanges.isEnabled('VOTE_POLL_TICK_VISIBLE', data['BLOCK_INDEX']);
            let pollData       = await this.indexerDb.getPollResultsForVM(data['BLOCK_INDEX'], pollTickVisible);

            // : attestation-response snapshot backing xchain.attestation.getResponse().
            // Gated on the VM_ATTESTATION_GETRESPONSE flag-day: below activation the gateway
            // sees attestationData:null (getResponse returns null, the pre-reader behaviour),
            // so a heterogeneous fleet never forks on the first getResponse-reading contract.
            // Scoped to THIS contract's fulfilled requests (see getAttestationDataForVM).
            let attestationData = null;
            if(await this.actions.protocolChanges.isEnabled('VM_ATTESTATION_GETRESPONSE', data['BLOCK_INDEX']))
                attestationData = await this.indexerDb.getAttestationDataForVM(data['CONTRACT_ACTION_INDEX'], data['BLOCK_INDEX']);

            // Pre-load contract-stake snapshot scoped to THIS contract. Backs the
            // xchain.contract.{getStake,getTotalStaked,getStakers,slash} APIs synchronously.
            // Implicit slash authorization: the accessor only knows this contract's stakes.
            let contractStakeData = await this.indexerDb.getContractStakeDataForVM(
                data['CONTRACT_ACTION_INDEX'], data['BLOCK_INDEX']
            );

            // Balance + token-info snapshot backing xchain.getBalance / getTokenInfo.
            // Scoped to SOURCE + this contract's derived address (pre-action state);
            // a contract verifies its own holdings (e.g. a just-DEPOSITed amount in a
            // BATCH) by reading getBalance(getContractAddress(), tick).
            // Gated on the VM_BALANCE_TOKENINFO flag-day: below activation the gateway
            // sees balances:null / tokenInfo:null (original <=2.7.10 behaviour), so a
            // heterogeneous fleet never forks on the first balance-reading contract.
            let contractAddr = 'C:' + this.config['CHAIN'] + ':' + data['CONTRACT_ACTION_INDEX'];
            let vmLedger = { balances: null, tokenInfo: null };
            if(await this.actions.protocolChanges.isEnabled('VM_BALANCE_TOKENINFO', data['BLOCK_INDEX'])){
                vmLedger = await this.indexerDb.buildVmBalancesAndTokenInfo(
                    [data['SOURCE'], contractAddr], data['BLOCK_INDEX'], data['ACTION_INDEX']
                );
            }

            // Derive deterministic block hash from block_index + block_time
            let blockHash = crypto.createHash('sha256')
                .update(String(data['BLOCK_INDEX']) + ':' + String(data['BLOCK_TIME']))
                .digest('hex');

            // Execute contract in VM
            let vmResult = await this.actions.vm.execute({
                code:             contractInfo.code,
                state:            contractState,
                method:           data['METHOD'],
                params:           data['METHOD_PARAMS'] ? data['METHOD_PARAMS'].split('|') : [],
                caller:           data['SOURCE'],
                contractAddress:  'C:' + this.config['CHAIN'] + ':' + data['CONTRACT_ACTION_INDEX'],
                contractIndex:    data['CONTRACT_ACTION_INDEX'],
                txHash:           data['TX_HASH'],   // needed for deterministic attestation request_id
                blockContext: {
                    height:    data['BLOCK_INDEX'],
                    timestamp: data['BLOCK_TIME'],
                    hash:      blockHash
                },
                // Cross-contract call threading: the callee's ceiling is its
                // caller-funded reservation; depth gates emit.execute recursion;
                // callPath anchors the attestation request_id + cross-chain call_id
                // preimages so two nested runs of the same contract in one tx cannot
                // collide, and unlike action_index it is content-derived so it
                // stays byte-stable across nodes/reorgs. Root on-chain EXECUTE = ''.
                gasCeiling:        execCeiling,
                callDepth:         Number(data['CALL_DEPTH']) || 0,
                actionIndex:       data['ACTION_INDEX'],
                callPath:          data['CALL_PATH'] || '',
                // Per-root discriminator for the request_id/call_id preimages. The value is
                // TX_VOUT: the on-chain output index of the ROOT that seeded this subtree.
                // NOTE: the VM opt key is named `rootActionIndex` and the data key is
                // ROOT_ACTION_INDEX for historical reasons, but the value is always the
                // output index (TX_VOUT), NOT the action_index. Do not "correct" one side
                // to the true action_index without updating the full preimage on both sides;
                // that would silently fork the hash. A top-level on-chain EXECUTE has no
                // inherited ROOT_ACTION_INDEX so it IS the root and uses its own TX_VOUT; a
                // nested EXECUTE emission inherits the root's value via processEmission.
                // TX_VOUT is distinct per action within a tx and stable across reorgs, so
                // two forest roots under one tx_hash cannot collide.
                rootActionIndex:   data['ROOT_ACTION_INDEX'] != null ? data['ROOT_ACTION_INDEX'] : (data['TX_VOUT'] != null ? data['TX_VOUT'] : 0),
                // Cross-chain call context: hop budget for emit.crossExecute (threaded
                // from XEXEC injections / result callbacks), the network bound into the
                // call_id preimage, and the cross-call flag the harness uses to enforce
                // the target's crossCallable allowlist.
                crossHops:         Number(data['CROSS_HOPS']) || 0,
                isCrossCall:       Boolean(data['IS_CROSS_CALL']),
                network:           this.config['NETWORK'],
                balances:          vmLedger.balances,
                tokenInfo:         vmLedger.tokenInfo,
                oracleData:        oracleData,
                crossChainData:    crossChainData,
                pollData:          pollData,
                attestationData:   attestationData, // : null pre-flag; populated at/after VM_ATTESTATION_GETRESPONSE
                contractStakeData: contractStakeData,
                providerDeadlines: PROVIDER_DEADLINE_WINDOWS
            });

            gasUsed = vmResult.gasUsed;
            emittedCount = vmResult.emittedActions.length;
            vmReturnValue = vmResult.success ? vmResult.returnValue : null;

            if(!vmResult.success)
                vmError = vmResult.error;

            // Process state changes + emissions atomically via DB savepoint.
            // Name is unique per execution: savepoints NEST when an emitted EXECUTE
            // runs a callee inside this one, and MariaDB re-uses a duplicate
            // savepoint name by DESTROYING the earlier one. A fixed 'vm_execute'
            // name would silently invalidate the outer rollback scope.
            if(vmResult.success){
                let savepoint = await this.indexerDb.createSavepoint('vm_execute_' + parseInt(data['ACTION_INDEX']));
                try {
                    // Write state changes
                    for(let change of vmResult.stateChanges){
                        await this.indexerDb.createContractState({
                            CONTRACT_INDEX: data['CONTRACT_ACTION_INDEX'],
                            STATE_KEY:      change.key,
                            STATE_VALUE:    JSON.stringify(change.value),
                            BLOCK_INDEX:    data['BLOCK_INDEX'],
                            ACTION_INDEX:   data['ACTION_INDEX']
                        });
                    }
                    // Write state deletes (null value = deleted)
                    for(let key of vmResult.stateDeletes){
                        await this.indexerDb.createContractState({
                            CONTRACT_INDEX: data['CONTRACT_ACTION_INDEX'],
                            STATE_KEY:      key,
                            STATE_VALUE:    null,
                            BLOCK_INDEX:    data['BLOCK_INDEX'],
                            ACTION_INDEX:   data['ACTION_INDEX']
                        });
                    }
                    // Process emitted actions through existing handlers
                    for(let i = 0; i < vmResult.emittedActions.length; i++){
                        let emission = vmResult.emittedActions[i];

                        // SLASH emissions are internal: never on-wire, never run through
                        // the generic emission router (no decoder/parser exists for them).
                        // Handled inline: deduct stake, credit destination, write event log.
                        if(emission.action === 'SLASH'){
                            await this._processSlashEmission(emission, data, i);
                        } else {
                            await this.processEmission(emission, data, i);
                            // Cross-contract callee finished: bank its unused
                            // reservation (gasLimit - billed, including its own
                            // subtree's refunds) for this run's fee settlement.
                            if(emission.action === 'EXECUTE')
                                nestedGasUnused += Number(emission.gasUnusedSubtree) || 0;
                        }

                        // Record emission link (SLASH rows carry no resultActionIndex)
                        await this.indexerDb.createContractEmission({
                            EXECUTION_INDEX: data['ACTION_INDEX'],
                            EMITTED_ACTION:  emission.action,
                            ACTION_INDEX:    emission.resultActionIndex || null,
                            POSITION:        i
                        });
                    }

                    await this.indexerDb.releaseSavepoint(savepoint);
                } catch(emissionError){
                    // Roll back ALL state changes and emissions from this execution
                    await this.indexerDb.rollbackToSavepoint(savepoint);
                    // An infrastructure fault (VM host fault, transient DB error) is not a
                    // contract outcome: halt so the block rolls back and retries rather than
                    // committing a validator-local 'failed' status that would fork the chain.
                    rethrowIfInfraFault(emissionError);
                    vmError = 'emission failed: ' + emissionError.message;
                    emittedCount = 0;
                    // No refunds on a failed tree: the caller pays its full metered
                    // gas (reservations included), mirroring the existing
                    // caller-pays-for-failed-attempt rule.
                    nestedGasUnused = 0;
                }
            }
        }

        // A VM-execution failure (revert / timeout / runtime error) is NOT a
        // pre-VM rejection: the contract DID run and consumed gas, so the caller pays for the
        // failed attempt (see the gas-debit note below). Atomicity is preserved: state changes
        // and emissions are applied only on vmResult.success. We record a dedicated execution
        // status ('reverted' / 'out_of_resource' / 'failed', via
        // util.vmFailureStatus) and deliberately leave
        // `error` null so the gas debit fires, mirroring the in-memory debit taken before the
        // VM ran. (Leaving it as a generic 'invalid:' error would skip the debit, letting any
        // caller burn up to the gas ceiling / CPU limit for free, which is a node-DoS vector.)
        let vmFailed = Boolean(vmError) && !error;
        let vmStatus = vmFailed ? this.util.vmFailureStatus(vmError) : null;

        // Defense-in-depth (consensus): resource terminations report a gasUsed
        // captured at a machine-/GC-/stack-/timing-dependent point. The VM already
        // clamps these to the ceiling, but clamp here too so a VM regression (or an
        // older bundled VM) can never make fee = gasUsed * GAS_PRICE diverge across
        // validators and fork. The family regex MUST stay identical to util.vmFailureStatus
        // (out_of_gas is included so the two regexes never drift; it is a no-op for the
        // fee since out_of_gas already reports gasUsed == ceiling). The clamp target is
        // this run's OWN ceiling: for a cross-contract callee that is its caller-funded
        // reservation, not the protocol ceiling (a 1M clamp against a 50k reservation
        // would diverge the parent's refund settlement).
        if(vmFailed && /^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(String(vmError))){
            gasUsed = execCeiling;
        }

        // Gas settlement. gasBilled = this run's metered usage minus the unused
        // reservations refunded by its completed callees. By induction each
        // callee's gasUnusedSubtree already nets ITS children, so subtracting the
        // direct children here settles the whole subtree. Bounds (guarded anyway):
        // 0 <= gasBilled <= gasUsed <= execCeiling.
        let gasBilled = Math.max(0, gasUsed - nestedGasUnused);

        // Recalculate fee based on billed gas
        fee = this.util.bcmul(gasBilled, this.config['GAS_PRICE'], 8);

        // Surface this run's unused reservation to the parent processEmission
        // (only meaningful when this parse IS a cross-contract callee).
        if(data['IS_EMISSION'] && Number.isInteger(data['VM_GAS_LIMIT']))
            data['VM_GAS_UNUSED_SUBTREE'] = Math.max(0, execCeiling - gasBilled);

        // Determine final status
        let status = error ? error : (vmStatus || 'valid');
        data['STATUS'] = status;

        // Surface the run outcome for system injectors (the XEXEC handler relays
        // these to the source chain as the cross-chain call result). Consensus-safe:
        // all three are deterministic products of the run.
        data['VM_RETURN_VALUE']  = (status === 'valid') ? vmReturnValue : null;
        data['VM_ERROR_MESSAGE'] = error || vmError || null;
        data['VM_GAS_BILLED']    = gasBilled;

        // Print status message
        console.log("\t EXECUTE : contract=" + data['CONTRACT_ACTION_INDEX'] + ' : method=' + data['METHOD'] + ' : gas=' + gasBilled + ((Number(data['CALL_DEPTH']) || 0) > 0 ? ' : depth=' + data['CALL_DEPTH'] : '') + ' : ' + data['STATUS']);

        // Create execution record. GAS_USED is the BILLED gas (metered usage net
        // of callee refunds); GAS_LIMIT is this run's ceiling (the caller-funded
        // reservation for a cross-contract callee, the protocol ceiling otherwise).
        await this.indexerDb.createContractExecution({
            ACTION_INDEX    : data['ACTION_INDEX'],
            CONTRACT_INDEX  : data['CONTRACT_ACTION_INDEX'],
            CALLER          : data['SOURCE'],
            METHOD_NAME     : data['METHOD'],
            INPUT_PARAMS    : data['METHOD_PARAMS'],
            GAS_USED        : gasBilled,
            GAS_LIMIT       : execCeiling,
            STATUS          : status,
            ERROR_MESSAGE   : error || vmError || null,
            EMITTED_COUNT   : emittedCount,
            BLOCK_INDEX     : data['BLOCK_INDEX']
        });

        // Store the SOURCE and GAS tick in addresses list
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Debit gas fee from SOURCE. Mirror the in-memory balance debit's condition
        // EXACTLY (!error && !skipFee && feePaymentMode === 2). A failed VM run (revert /
        // out_of_gas / timeout) leaves `error` null (it sets vmError + a dedicated vmStatus),
        // so the "caller pays for a failed attempt" case still debits. The source is known to
        // hold GAS credits here (it passed the pre-VM balance check), so the debit stays
        // ledger/balance-consistent even if it drives the balance negative. But an EXECUTE
        // rejected before the VM ran
        // (insufficient GAS funds / inactive contract / sleeping source) sets `error`
        // and must NOT record a ledger debit: burning gas the source never had drops
        // ledger supply while getAddressBalances (which only iterates credit ticks)
        // leaves the balances projection unchanged (balance = ledger + 1, SanityError).
        if(!error && !skipFee && tokenInfo && feePaymentMode === 2)
            debits.push([gas, fee, data['SOURCE']]);

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }

    /*****************************************************************
     * Controller-bound token guard
     *
     * Runs the `guard` method on a token's bound CONTROLLER contract before a
     * guarded native action (SEND/ORDER/SWAP/DISPENSER) on that token settles.
     * The guard is a fully programmable VM execution: it may read/write its own
     * contract state and emit token actions (e.g. split a royalty out of sale
     * proceeds), and it may `revert` to DENY the action. The asynchronous
     * frameworks (ATTEST/XCALL) are disabled (VM isGuard mode) so the decision
     * is synchronous. Reuses the EXECUTE state-write + processEmission + savepoint
     * machinery so a guard's side effects are validated and atomic exactly like
     * a contract method's.
     *
     * opts:
     *   actionType      string  SEND | ORDER_CREATE | ORDER_MATCH | SWAP_CREATE |
     *                           SWAP_MATCH | DISPENSER_CREATE | DISPENSE
     *   controllerIndex number  the token's CONTROLLER (contract action_index)
     *   tick            string  the controlled token
     *   from, to        string  counterparties (action-type dependent; '' if n/a)
     *   amount          string  token amount moving (or order/dispenser quantity)
     *   price           string  proceeds amount for a sale ('' for a plain SEND)
     *   proceedsTick    string  proceeds tick for a sale ('' for a plain SEND)
     *   hostData        object  the native action's BLOCK / TX / ACTION_INDEX / SOURCE fields
     *   callDepth       number  guard call depth (native action depth + 1)
     *
     * Returns { allow, reason, gasBilled }. On allow the caller bills gasBilled
     * GAS to the action SOURCE (which it must already have reserved
     * GAS_SCHEDULE.VM_GUARD_GAS_CEILING fee for). On deny the caller marks the
     * native action invalid; the guard's own state + emissions are rolled back
     * here. Fail-closed: missing/throwing `guard`, out-of-gas, or a failed guard
     * emission all DENY. Depth-capped by VM_MAX_CALL_DEPTH.
     ****************************************************************/
    async runControllerGuard(opts){
        let chain         = this.config['CHAIN'];
        let contractIndex = parseInt(opts.controllerIndex);
        let hostData      = opts.hostData;
        let callDepth     = Number(opts.callDepth) || 0;
        let derived       = 'C:' + chain + ':' + contractIndex;

        // Depth cap (defense in depth; the emit path checks too). A guard whose
        // emit.send moves another controlled token recurses through this method.
        if(callDepth > MAX_CALL_DEPTH)
            return { allow:false, reason:'controller (max call depth)', gasBilled:0 };

        // Load + verify the controller contract is active. Fail-closed.
        let contractInfo = await this.indexerDb.getContract(contractIndex);
        if(!contractInfo)
            return { allow:false, reason:'controller (unknown)', gasBilled:0 };
        let contractStatus = await this.indexerDb.getStatusString(contractInfo.status_id);
        if(contractStatus !== 'valid')
            return { allow:false, reason:'controller (not active)', gasBilled:0 };
        // A missing VM is a HOST condition, not a contract outcome, so it must HALT
        // rather than deny. The denies above derive from consensus state every node
        // reads identically; this one derives from whether THIS node's optional
        // require('xchain-vm') happened to load (actions.js sets this.vm=null and only
        // warns). Denying on it commits a validator-local verdict into the ledger and
        // the block hash while a healthy peer runs the guard and allows the action: a
        // host-condition-induced fork. Throw the same EXECUTOR_UNAVAILABLE host fault
        // DEPLOY throws and the vm.execute catch below rethrows, so faultGuard and the
        // block loop roll the block back and retry, writing no verdict at all. No
        // consensus rule changes, so no flag-day is needed.
        if(!this.actions.vm){
            let e = new Error('controller guard VM executor unavailable');
            e.code = 'EXECUTOR_UNAVAILABLE';
            throw e;
        }

        // Guard gas ceiling (consensus param, per-chain GAS_SCHEDULE). Validated canonical
        // key resolved once via the shared resolver (throws on missing/mistyped; no silent
        // hard-coded fallback that could fork a misconfigured node).
        let guardCeiling = this.util.resolveGuardGasCeiling(this.config);

        // Load contract state + read-only data (mirrors parse(), including the
        // state_key collation flag-day keyed on the host block).
        let contractState = await this.indexerDb.getContractState(contractIndex, hostData['BLOCK_INDEX']);
        let oracleData = await ((this.actions && this.actions.hubDb) || this.indexerDb).getOracleDataForVM(hostData['BLOCK_INDEX'], hostData['BLOCK_TIME'], parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800);
        let crossChainData = await this.indexerDb.getCrossChainDataForVM(hostData['BLOCK_INDEX']);
        // : expose each poll's electorate TICK in the VM snapshot at/after the flag-day.
        let pollTickVisible = await this.actions.protocolChanges.isEnabled('VOTE_POLL_TICK_VISIBLE', hostData['BLOCK_INDEX']);
        let pollData       = await this.indexerDb.getPollResultsForVM(hostData['BLOCK_INDEX'], pollTickVisible);
        let contractStakeData = await this.indexerDb.getContractStakeDataForVM(contractIndex, hostData['BLOCK_INDEX']);
        // Gated on the VM_BALANCE_TOKENINFO flag-day (see primary EXECUTE path).
        let guardLedger = { balances: null, tokenInfo: null };
        if(await this.actions.protocolChanges.isEnabled('VM_BALANCE_TOKENINFO', hostData['BLOCK_INDEX'])){
            guardLedger = await this.indexerDb.buildVmBalancesAndTokenInfo(
                [hostData['SOURCE'], derived], hostData['BLOCK_INDEX'], hostData['ACTION_INDEX']
            );
        }
        let blockHash = crypto.createHash('sha256')
            .update(String(hostData['BLOCK_INDEX']) + ':' + String(hostData['BLOCK_TIME']))
            .digest('hex');

        // Positional, all-string guard inputs. Order is consensus; see spec.
        let guardParams = [
            String(opts.actionType),
            String(this.util.isNull(opts.from)         ? '' : opts.from),
            String(this.util.isNull(opts.to)           ? '' : opts.to),
            String(this.util.isNull(opts.tick)         ? '' : opts.tick),
            String(this.util.isNull(opts.amount)       ? '' : opts.amount),
            String(this.util.isNull(opts.price)        ? '' : opts.price),
            String(this.util.isNull(opts.proceedsTick) ? '' : opts.proceedsTick)
        ];

        let vmResult;
        try {
            vmResult = await this.actions.vm.execute({
                code:            contractInfo.code,
                state:           contractState,
                method:          GUARD_METHOD,
                params:          guardParams,
                caller:          hostData['SOURCE'],   // who triggered the guarded action
                contractAddress: derived,
                contractIndex:   contractIndex,
                txHash:          hostData['TX_HASH'],
                blockContext: {
                    height:    hostData['BLOCK_INDEX'],
                    timestamp: hostData['BLOCK_TIME'],
                    hash:      blockHash
                },
                gasCeiling:        guardCeiling,
                callDepth:         callDepth,
                actionIndex:       hostData['ACTION_INDEX'],
                callPath:          '',     // a guard is a root execution for its own subtree
                // Root discriminator = the guarded native action's on-chain output index (TX_VOUT),
                // carried under the VM opt name `rootActionIndex` the gateway preimage reads.
                // Distinguishes this guard subtree from a co-tx top-level EXECUTE that also seeds ''.
                rootActionIndex:   hostData['TX_VOUT'] != null ? hostData['TX_VOUT'] : 0,
                isGuard:           true,   // disables ATTEST/XCALL in the gateway
                network:           this.config['NETWORK'],
                balances:          guardLedger.balances,
                tokenInfo:         guardLedger.tokenInfo,
                oracleData:        oracleData,
                crossChainData:    crossChainData,
                pollData:          pollData,
                // A controller guard is a lightweight allow/deny + royalty decision on a
                // native action; it has no attestation-request surface (the gateway also
                // disables attestation.request under isGuard), so it never reads responses.
                // Keep attestationData:null here to avoid widening the guard's consensus
                // read surface .
                attestationData:   null,
                contractStakeData: contractStakeData,
                providerDeadlines: PROVIDER_DEADLINE_WINDOWS
            });
        } catch(e){
            // A host fault (e.g. permanently broken subprocess executor) must HALT,
            // not silently deny. Rethrow so the block processor stops rather than
            // committing a fabricated decision that could fork the chain.
            throw e;
        }

        // The VM already clamps a resource-termination gasUsed to the ceiling;
        // clamp again defensively so the fee can never exceed the reservation.
        let gasBilled = Math.min(Number(vmResult.gasUsed) || 0, guardCeiling);

        // Guard reverted / out-of-gas / runtime error -> DENY (fail-closed). The
        // SOURCE is still billed gasBilled (caller-pays-for-attempt) only when the
        // action proceeds; a denied action records no ledger change (see caller).
        if(!vmResult.success)
            return { allow:false, reason:'controller (' + this.util.vmFailureStatus(vmResult.error) + ')', gasBilled };

        // Parse the guard's return value for an optional royalty/fee split. A controlled-token SALE
        // guard (ORDER/SWAP create) may return { payoutLegs: [{to, bps}] } with basis-point cuts of
        // the seller's proceeds applied at match (Utility.applyProceedsSplit). Validate fail-closed
        // BEFORE committing emissions: a malformed leg or a total over CONTROLLER_MAX_TAKE_BPS DENIES
        // the action (no savepoint exists yet, so nothing to roll back).
        let payoutLegs = null;
        // vm.execute() returns returnValue as a JSON-serialized STRING (the contract wrapper
        // JSON-stringifies the contract's return inside the isolate), so parse before the object
        // check below. A raw `typeof ret === 'object'` never matches and silently drops the legs.
        let ret = vmResult.returnValue;
        if(ret && typeof ret === 'string'){ try { ret = JSON.parse(ret); } catch(e){ ret = null; } }
        if(ret && typeof ret === 'object' && Array.isArray(ret.payoutLegs) && ret.payoutLegs.length > 0){
            let parsed = [];
            let totalBps = 0;
            for(let leg of ret.payoutLegs){
                let bps = (leg && this.util.isNumeric(leg.bps)) ? parseInt(leg.bps) : NaN;
                if(!Number.isInteger(bps) || bps < 0 || this.util.isNull(leg.to) || !this.util.isCryptoAddress(String(leg.to)))
                    return { allow:false, reason:'controller (bad payout leg)', gasBilled };
                totalBps += bps;
                parsed.push({ to: String(leg.to), bps: bps });
            }
            let cap = parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']);
            if(!Number.isInteger(cap) || cap > 10000) cap = 10000;
            // Phase E: a contract may declare a TIGHTER per-contract royalty cap (maxTakeBps)
            // in its deploy manifest. The effective cap is min(global, per-contract). Loaded
            // lazily here: only guards that actually return payout legs pay the lookup.
            let controllerManifest = await this.indexerDb.getContractPermissions(contractIndex);
            if(controllerManifest && Number.isInteger(controllerManifest.maxTakeBps) &&
               controllerManifest.maxTakeBps >= 0 && controllerManifest.maxTakeBps < cap)
                cap = controllerManifest.maxTakeBps;
            if(totalBps > cap)
                return { allow:false, reason:'controller (payout exceeds cap)', gasBilled };
            payoutLegs = parsed;
        }

        // Guard allowed. Commit its state changes + emissions atomically; any
        // failure rolls them back and DENIES. The savepoint name carries the
        // (native action, controller, seq) for readability but is made unique by
        // a trailing per-invocation ordinal: MariaDB silently destroys a
        // duplicate-named savepoint, so two guards that share a contractIndex on
        // one leg (or any future re-entrant guard path) must never derive the
        // same name or an inner release would orphan the outer's rollback target.
        let guardCtxData = {
            ACTION_INDEX:          hostData['ACTION_INDEX'],
            // Root discriminator for this guard's emission subtree = the guarded native action's
            // on-chain output index TX_VOUT, under the ROOT_ACTION_INDEX key attest.js/xcall.js
            // read (propagated unchanged by processEmission).
            ROOT_ACTION_INDEX:     hostData['TX_VOUT'] != null ? hostData['TX_VOUT'] : 0,
            CONTRACT_ACTION_INDEX: contractIndex,
            SOURCE:                derived,
            BLOCK_INDEX:           hostData['BLOCK_INDEX'],
            BLOCK_TIME:            hostData['BLOCK_TIME'],
            TX_INDEX:              hostData['TX_INDEX'],
            TX_HASH:               hostData['TX_HASH'],
            TX_VOUT:               hostData['TX_VOUT'],
            CALL_DEPTH:            callDepth,
            CROSS_HOPS:            0,
            // Mark emissions from this guard run so they are not themselves re-guarded by their
            // OWN controller (no guard-of-guard): see Utility.maybeRunControllerGuard. They still
            // carry IS_EMISSION (fee already skipped) and depth-cap on cross-controlled-token moves.
            IS_GUARD_EMISSION:     true
        };

        let savepoint = await this.indexerDb.createSavepoint('controller_guard_' + parseInt(hostData['ACTION_INDEX']) + '_' + contractIndex + '_' + (parseInt(opts.seq) || 0) + '_' + (this.guardSavepointCounter++));
        try {
            for(let change of vmResult.stateChanges){
                await this.indexerDb.createContractState({
                    CONTRACT_INDEX: contractIndex,
                    STATE_KEY:      change.key,
                    STATE_VALUE:    JSON.stringify(change.value),
                    BLOCK_INDEX:    hostData['BLOCK_INDEX'],
                    ACTION_INDEX:   hostData['ACTION_INDEX']
                });
            }
            for(let key of vmResult.stateDeletes){
                await this.indexerDb.createContractState({
                    CONTRACT_INDEX: contractIndex,
                    STATE_KEY:      key,
                    STATE_VALUE:    null,
                    BLOCK_INDEX:    hostData['BLOCK_INDEX'],
                    ACTION_INDEX:   hostData['ACTION_INDEX']
                });
            }

            // A guard's emissions key their execution_index to the NATIVE action's
            // action_index (a guard has no action_index of its own; it rides the
            // guarded SEND/ORDER/SWAP/DISPENSER). The block contract_hash preimage
            // pulls emissions via INNER JOIN contract_executions ce ON
            // (ce.action_index = em.execution_index). Without a parent execution
            // row here, EVERY guard emission is silently dropped from contract_hash
            // and two nodes that diverge on guard emissions still hash identically
            // (a silent consensus fork). Write the parent row so the join resolves.
            //
            // A single native action can run MULTIPLE guards on the same action_index
            // (a multi-leg SEND/DESTROY; or one SEND firing both the token-controller
            // and the destination address-controller). They share this one execution
            // row (action_index is UNIQUE: last write wins, deterministic) and their
            // emissions all share execution_index. position is therefore offset by the
            // count of emissions ALREADY recorded for this action so (execution_index,
            // position) stays globally unique, keeping the preimage's
            // ORDER BY (execution_index, position) a TOTAL order across guards (no
            // engine-dependent tie-break = no fork). Offsetting the stored column means
            // the existing read-side ORDER BY (here and in the sync hasher) needs no
            // change. Rolled-back prior-guard emissions aren't counted, so positions
            // stay gap-free and deterministic across nodes.
            let priorEmissions = await this.indexerDb.doQuery(
                'SELECT COUNT(*) AS cnt FROM contract_emissions WHERE execution_index=?',
                [hostData['ACTION_INDEX']]
            );
            let basePosition = (priorEmissions.length > 0) ? Number(priorEmissions[0].cnt) : 0;

            // Parent execution row for this guard run (mirrors runContractExecution's
            // column set). Written inside the savepoint so a failed guard emission
            // rolls it back alongside its emissions: a denied guard leaves no record.
            // GAS_USED/GAS_LIMIT are the guard's billed gas + its ceiling; CALLER is
            // who triggered the guarded action; emitted_count accumulates across guards
            // sharing this action so the surviving row reflects the action's true total.
            await this.indexerDb.createContractExecution({
                ACTION_INDEX  : hostData['ACTION_INDEX'],
                CONTRACT_INDEX: contractIndex,
                CALLER        : hostData['SOURCE'],
                METHOD_NAME   : GUARD_METHOD,
                INPUT_PARAMS  : guardParams.join('|'),
                GAS_USED      : gasBilled,
                GAS_LIMIT     : guardCeiling,
                STATUS        : 'valid',
                ERROR_MESSAGE : null,
                EMITTED_COUNT : basePosition + vmResult.emittedActions.length,
                BLOCK_INDEX   : hostData['BLOCK_INDEX']
            });

            for(let i = 0; i < vmResult.emittedActions.length; i++){
                let emission = vmResult.emittedActions[i];
                // A guard may not emit asynchronous (ATTEST/XCALL, already blocked
                // at VM emit time) or stake-slashing (SLASH) actions. Re-check
                // host-side as defense in depth against an older bundled VM.
                if(emission.action === 'ATTEST' || emission.action === 'XCALL' || emission.action === 'SLASH')
                    throw new Error('guard emission not allowed: ' + emission.action);
                // Use the host-action-global position (basePosition + i), not the
                // guard-local index: multiple guards share this action's emission space,
                // so offsetting keeps each guard's call-path subtree disjoint. A guard
                // can emit a nested EXECUTE whose callee emits ATTEST/XCALL. Without the
                // offset, two guards' first EXECUTE emissions would share call-path '0'
                // and their callees' ids could collide. Matches the stored POSITION.
                let pos = basePosition + i;
                await this.processEmission(emission, guardCtxData, pos);
                await this.indexerDb.createContractEmission({
                    EXECUTION_INDEX: hostData['ACTION_INDEX'],
                    EMITTED_ACTION:  emission.action,
                    ACTION_INDEX:    emission.resultActionIndex || null,
                    POSITION:        pos
                });
            }
            await this.indexerDb.releaseSavepoint(savepoint);
        } catch(emissionError){
            await this.indexerDb.rollbackToSavepoint(savepoint);
            // An infrastructure fault (VM host fault, transient DB error) is not a
            // guard decision: halt so the block rolls back and retries rather than
            // committing a validator-local DENY of a money-bearing action.
            rethrowIfInfraFault(emissionError);
            return { allow:false, reason:'controller (' + emissionError.message + ')', gasBilled };
        }

        return { allow:true, reason:null, gasBilled, payoutLegs };
    }

    /*****************************************************************
     * Emission Processing - Routes emitted actions to existing handlers
     ****************************************************************/

    async processEmission(emission, executionData, position){
        let action = emission.action;
        let params = emission.params;

        // Permissions manifest (Phase E): the SINGLE choke point for every emission path.
        // Constructor (deploy.js), EXECUTE, and a controller guard all funnel through here. If
        // the EMITTING contract declared a `permissions` allowlist at deploy time, every action
        // it emits must be a member; a non-member throws, which rolls back the emitter's
        // savepoint and fails the host action (deploy reject / EXECUTE revert / guard DENY).
        // Fail-closed by construction. A contract with no manifest row (null) or a row that
        // declared only maxTakeBps (permissions null) is unrestricted (the backward-compatible
        // default). An explicit empty allowlist (`[]`) permits no emissions. The manifest is
        // immutable (contract code is immutable), read by indexed lookup on contract_index.
        let emitterIndex = executionData['CONTRACT_ACTION_INDEX'];
        if(emitterIndex !== undefined && emitterIndex !== null){
            let manifest = await this.indexerDb.getContractPermissions(emitterIndex);
            if(manifest && Array.isArray(manifest.permissions) && manifest.permissions.indexOf(action) === -1)
                throw new Error('manifest: action ' + action + ' not permitted');
        }

        // ATTEST v0 (request) anchors its on-chain request_id to the emitter position, so the
        // handler can re-derive and verify it (defends against a compromised VM forging a
        // request_id). EMITTER_POSITION is therefore mandatory for ATTEST emissions: fail
        // loudly at the source if a caller ever omits it rather than letting the handler fall
        // back to accepting an unverified request_id.
        if(action === 'ATTEST' && (position === undefined || position === null))
            throw new Error('ATTEST emission missing EMITTER_POSITION (position argument)');

        // XCALL anchors its call_id to the emitter position the same way; mandatory.
        if(action === 'XCALL' && (position === undefined || position === null))
            throw new Error('XCALL emission missing EMITTER_POSITION (position argument)');

        // Cross-contract call emissions: re-validate depth + gasLimit HOST-side
        // (defense in depth; the VM enforces both at emit time, but an older or
        // compromised bundled VM must not be able to bypass them), then thread
        // the callee's depth + caller-funded ceiling through the emission data.
        let callDepth = (Number(executionData['CALL_DEPTH']) || 0) + 1;
        let crossHops = Number(executionData['CROSS_HOPS']) || 0;
        let nestedGasLimit = null;
        if(action === 'EXECUTE'){
            if(callDepth > MAX_CALL_DEPTH)
                throw new Error('EXECUTE emission exceeds max call depth (' + MAX_CALL_DEPTH + ')');
            nestedGasLimit = Number(params.gasLimit);
            if(!Number.isInteger(nestedGasLimit) || nestedGasLimit < MIN_CALL_GAS || nestedGasLimit > GAS_CEILING)
                throw new Error('EXECUTE emission gasLimit out of range [' + MIN_CALL_GAS + ', ' + GAS_CEILING + ']');
        }

        // Cross-chain call emissions: the hop count is HOST-derived (context + 1),
        // never trusted from the VM, and capped so two contracts cannot ping-pong
        // X->Y->X forever (the injected execution on the far chain is fee-less there,
        // so economics alone cannot bound the loop). gasLimit is re-validated against
        // the XCALL caps (tighter than same-chain).
        if(action === 'XCALL'){
            // Disallowed from DEPLOY constructors in v1: a constructor has no
            // settled execution context for the deadline/callback lifecycle.
            if(executionData['IS_CONSTRUCTOR'])
                throw new Error('XCALL emission is not allowed from a constructor');
            let hostHops = crossHops + 1;
            if(hostHops > XCALL_MAX_HOPS)
                throw new Error('XCALL emission exceeds max cross-chain hops (' + XCALL_MAX_HOPS + ')');
            params.crossHops = hostHops;
            let xcallGas = Number(params.gasLimit);
            if(!Number.isInteger(xcallGas) || xcallGas < XCALL_MIN_GAS || xcallGas > XCALL_MAX_GAS)
                throw new Error('XCALL emission gasLimit out of range [' + XCALL_MIN_GAS + ', ' + XCALL_MAX_GAS + ']');
        }

        // Deterministic call-path for the request_id / call_id preimages.
        //   emitterPath = the path of the EMITTING execution (root on-chain action = '').
        //   childPath   = emitterPath extended by this emission's position (the path of
        //                 the execution a nested EXECUTE emission will itself run as).
        // Encoding: '>'-joined non-negative integer positions; '>' appears in no adjacent
        // preimage field, so the path is one injection-free token. MUST byte-match the VM
        // (xchain-vm gateway.js attestation.request + gateway-emit.js crossExecute, which
        // hash the running execution's callPath). EMITTER_PATH replaces the old
        // EMITTER_ACTION_INDEX (which tracked injection timing -> forked the PBFT on reorg).
        let emitterPath = executionData['CALL_PATH'] || '';
        let childPath   = (emitterPath === '') ? String(position) : emitterPath + '>' + String(position);

        // Per-root discriminator (request_id/call_id preimage). UNLIKE childPath it is pinned at
        // the root and propagated UNCHANGED: a top-level EXECUTE's executionData carries no
        // ROOT_ACTION_INDEX, so its own TX_VOUT (a pure on-chain output index, stable across reorgs)
        // IS the root; a nested/guard executionData already carries the inherited root value. Stamped
        // onto emissionData so attest.js/xcall.js re-derive with it and nested EXECUTEs inherit it.
        let rootActionIndex = (executionData['ROOT_ACTION_INDEX'] != null) ? executionData['ROOT_ACTION_INDEX'] : (executionData['TX_VOUT'] != null ? executionData['TX_VOUT'] : 0);

        // Force source to the contract's derived address
        let contractAddress = 'C:' + this.config['CHAIN'] + ':' + executionData['CONTRACT_ACTION_INDEX'];

        // Normalize emitted amounts to their tick's decimals BEFORE building params and
        // dispatching (item 5346). Contracts compute with 64-digit bignum precision, so an
        // emitted amount can carry more fractional digits than the tick; left unnormalized it
        // would be rejected by isValidAmountFormat (reverting e.g. every AMM swap) or stored
        // unrounded while the ledger rounds it (supply desync). This applies the SAME
        // normalization the ledger uses, so the two agree.
        await this._truncateEmissionAmounts(action, params);

        // Build positional params array for the handler
        let actionParams = this.buildActionParams(action, params);

        // Most emittable actions are version-0 only, but VOTE is sub-typed by version
        // (0 = create poll, 1 = cast ballot) and its handler dispatches on FORMAT. Carry
        // the emitted version into FORMAT so a contract-cast ballot isn't mis-parsed as a
        // poll creation (which then fails the create-only "must hold TICK" gate).
        // Only v0/v1 are emittable: v2 (finalize) is system-injected-only and v3
        // (delegate) has no emission param mapping, so buildActionParams would hand
        // _parseDelegate a mis-mapped v0 layout. The VM gateway already rejects both
        // at emit time; re-check host-side as defense in depth against an older
        // bundled VM, matching the guard-emission checks above ( / VM-EMIT-1).
        if(action === 'VOTE' && Number(params.version) > 1)
            throw new Error('emitted VOTE version ' + params.version + ' is not emittable (only v0 create / v1 ballot)');
        let emissionFormat = (action === 'VOTE') ? (Number(params.version) || 0) : 0;

        // Create a real action_index for this emission
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      action,
            BLOCK_INDEX: executionData['BLOCK_INDEX'],
            TX_INDEX:    executionData['TX_INDEX'],
            TX_VOUT:     executionData['TX_VOUT'],
            FORMAT:      emissionFormat,
            // The emission's TRUE source is the contract, not the EXECUTE caller. Persisting it
            // here is what lets refunds/ownership/auth resolve back to the contract later.
            SOURCE:      contractAddress
        }, true);  // force=true to always create new

        // Build the data object that action handlers expect
        let emissionData = {
            ACTION_INDEX:       emissionActionIndex,
            SOURCE:             contractAddress,
            FEE_PAYER:          executionData['SOURCE'],
            BLOCK_INDEX:        executionData['BLOCK_INDEX'],
            BLOCK_TIME:         executionData['BLOCK_TIME'],
            TX_INDEX:           executionData['TX_INDEX'],
            TX_HASH:            executionData['TX_HASH'],
            TX_VOUT:            executionData['TX_VOUT'],
            FORMAT:             emissionFormat,
            IS_EMISSION:        true,
            // Propagated from a guard run's emission context (false for normal EXECUTE emissions,
            // which ARE still subject to their token's controller). Lets maybeRunControllerGuard
            // skip re-guarding a controller's emission of its own controlled token.
            IS_GUARD_EMISSION:  executionData['IS_GUARD_EMISSION'] ? true : false,
            EMITTER:            executionData['CONTRACT_ACTION_INDEX'],
            EMITTER_POSITION:   position,   // index within this EXECUTE's emission list; used by ATTEST v0 (request) to verify deterministic request_id
            // The EMITTING execution's call-path. Disambiguates nested runs of the same
            // contract within one tx in the ATTEST request_id / XCALL call_id derivation,
            // content-derived so it is byte-stable across nodes/reorgs ('' for the root).
            EMITTER_PATH:       emitterPath,
            // Per-root discriminator: the on-chain output index TX_VOUT of the root that seeded
            // this subtree, under the ROOT_ACTION_INDEX key attest.js/xcall.js read. Bound (with
            // EMITTER_PATH) into the ATTEST request_id / XCALL call_id re-derivation, and inherited
            // unchanged by a nested EXECUTE emission.
            ROOT_ACTION_INDEX:  rootActionIndex,
            // This emission's OWN call-path: if it is itself a nested EXECUTE, its
            // execution runs at this path (threaded into vm.execute as callPath).
            CALL_PATH:          childPath,
            CALL_DEPTH:         callDepth,
            VM_GAS_LIMIT:       nestedGasLimit, // null for every non-EXECUTE emission
            // Hop budget threads through same-chain emissions too: a contract calling a
            // local library which then crossExecutes still counts against the same cap.
            CROSS_HOPS:         crossHops
        };

        // Route to the correct handler
        let handler = this.getActionHandler(action);
        if(!handler)
            throw new Error('unknown emission action: ' + action);

        // Parse through the existing handler; same validation as user-submitted actions.
        let emissionError = null;
        await handler.parse(actionParams, emissionData, emissionError);

        // Check handler result
        if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid')
            throw new Error(action + ': ' + emissionData['STATUS']);

        // Store the resulting action_index for the emission record
        emission.resultActionIndex = emissionData['ACTION_INDEX'];

        // Cross-contract callee settled: hand its unused reservation
        // (gasLimit - billed, subtree-netted) back to the calling parse loop.
        if(action === 'EXECUTE')
            emission.gasUnusedSubtree = Number(emissionData['VM_GAS_UNUSED_SUBTREE']) || 0;
    }

    // Map action names to handler instances
    getActionHandler(action){
        let handlers = {
            'SEND':       this.actions.actionSend,
            'DESTROY':    this.actions.actionDestroy,
            'ISSUE':      this.actions.actionIssue,
            'MINT':       this.actions.actionMint,
            'ORDER':      this.actions.actionOrder,
            'DISPENSER':  this.actions.actionDispenser,
            'DIVIDEND':   this.actions.actionDividend,
            'AIRDROP':    this.actions.actionAirdrop,
            'CALLBACK':   this.actions.actionCallback,
            'FILE':       this.actions.actionFile,
            'LIST':       this.actions.actionList,
            'COINPAY':    this.actions.actionCoinpay,
            'SWEEP':      this.actions.actionSweep,
            'LINK':       this.actions.actionLink,
            'BROADCAST':  this.actions.actionBroadcast,
            'MESSAGE':    this.actions.actionMessage,
            'ATTEST':     this.actions.actionAttest,
            'VOTE':       this.actions.actionVote,
            // Cross-contract call: the callee EXECUTE routes through this same
            // handler class (re-entrant; parse() keeps no instance state).
            'EXECUTE':    this.actions.actionExecute,
            // Cross-CHAIN call request (the relay rides the hub mirror from here).
            'XCALL':      this.actions.actionXcall
        };
        return handlers[action] || null;
    }

    // Convert emission params object to positional array for each action type.
    // MUST match the format strings in each handler's this.formats[0].
    buildActionParams(action, params){
        switch(action){
            case 'VOTE':
                // Contracts may emit v0 (create poll) and v1 (cast ballot) only; the
                // emit API (gateway-emit.js) is the choke point that forbids v2/v3.
                if(Number(params.version) === 1)
                    // FORMAT: VERSION|POLL_REF|BALLOT|MEMO
                    return [1, params.pollRef, params.ballot, params.memo || ''];
                // FORMAT: VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|CALLBACK_CONTRACT|CALLBACK_METHOD|CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW
                return [0, params.tick, params.endBlock, params.options, params.maxSelections || '',
                        params.tallyMode || '', params.weightMode || '', params.quorum || '', params.minVoters || '',
                        params.minVoteBalance || '', params.decideThreshold || '', params.question || '', params.deposit || '',
                        params.callbackContract || '', params.callbackMethod || '', params.callbackParams || '',
                        params.callbackOn || '', params.gasEscrow || ''];
            case 'SEND':
                // FORMAT: VERSION|TICK|AMOUNT|DESTINATION|MEMO
                return [0, params.tick, params.quantity, params.destination, params.memo || ''];
            case 'DESTROY':
                // FORMAT: VERSION|TICK|AMOUNT|MEMO
                return [0, params.tick, params.quantity, params.memo || ''];
            case 'ISSUE':
                // FORMAT: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
                return [0, params.tick, params.maxSupply || '', params.maxMint || '', params.decimals || '',
                        params.description || '', params.mintSupply || '', params.transfer || '', params.transferSupply || '',
                        params.lockMaxSupply || '', params.lockMaxMint || '', params.lockDescription || '',
                        params.lockSleep || '', params.lockCallback || '', params.callbackBlock || '',
                        params.callbackTick || '', params.callbackAmount || '', params.allowList || '',
                        params.blockList || '', params.mintAddressMax || '', params.mintStartBlock || '',
                        params.mintStopBlock || '', params.lockMint || '', params.lockMintSupply || '', params.memo || ''];
            case 'MINT':
                // FORMAT: VERSION|TICK|AMOUNT|DESTINATION|MEMO
                return [0, params.tick, params.quantity, params.destination || '', params.memo || ''];
            case 'ORDER':
                // FORMAT: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
                // GIVE_OWNERSHIP/GET_OWNERSHIP (token-ownership trading) default to 0 when empty.
                return [0, params.giveCoin || '', params.giveTick || '', params.giveAmount, params.giveOwnership || '',
                        params.getCoin || '', params.getTick || '', params.getAmount, params.getOwnership || '',
                        params.getAddress || '', params.expiration || '',
                        params.allowList || '', params.blockList || '', params.memo || ''];
            case 'DISPENSER':
                // FORMAT: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
                // GIVE_OWNERSHIP defaults to 0; ORACLE_ADDRESS (PRICE v1 oracle) is optional.
                return [0, params.giveCoin || '', params.giveTick || '', params.giveAmount, params.giveOwnership || '', params.giveEscrow,
                        params.getCoin || '', params.getTick || '', params.getAmount,
                        params.getAddress || '', params.fiatCode || '', params.fiatAmount || '', params.oracleAddress || '',
                        params.expiration || '', params.allowList || '', params.blockList || '', params.memo || ''];
            case 'DIVIDEND':
                // FORMAT: VERSION|TICK|DIVIDEND_TICK|AMOUNT|MEMO
                return [0, params.tick, params.dividendTick, params.quantity, params.memo || ''];
            case 'AIRDROP':
                // FORMAT: VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO
                return [0, params.tick, params.quantity, params.listActionIndex, params.memo || ''];
            case 'CALLBACK':
                // FORMAT: VERSION|TICK|MEMO
                return [0, params.tick, params.memo || ''];
            case 'FILE':
                // FORMAT: VERSION|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION
                // Trailing gated-file fields default to empty (public file); a contract may set
                // them to emit a token-gated FILE. PC-29 added GATE_MIN_AMOUNT as the ninth:
                // emitted FILEs must carry it too, or a contract-emitted gated FILE would be
                // silently unconditional while the wire format says otherwise. The arity guard
                // in test/unit/emission-params-arity.test.js is what caught this.
                //
                //  Part B added COMPRESSION as the tenth, and it is PINNED EMPTY here,
                // not passed through from params. COMPRESSION describes rawData payload bytes,
                // and an emitted action has no rawData: the VM emission path carries an action
                // string only. Letting a contract assert COMPRESSION=1 over a payload that does
                // not exist would publish a permanently lying field (readers would degrade to
                // stored-form forever) for no reachable benefit. Empty also keeps the emitted
                // wire string byte-identical to what pre-Part-B contracts produce, since
                // trailing empties are stripped.
                return [0, params.name || '', params.type || '', params.title || '', params.memo || '',
                        params.gateTicker || '', params.encryptionMethod || '', params.keyHash || '',
                        params.gateMinAmount || '', ''];
            case 'LIST':
                // FORMAT: VERSION|TYPE|ITEM
                return [0, params.type || '', params.item || ''];
            case 'COINPAY':
                // FORMAT: VERSION|ORDER_MATCH_ACTION_INDEX
                return [0, params.orderMatchActionIndex];
            case 'SWEEP':
                // FORMAT: VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO
                return [0, params.destination, params.balances || '', params.ownerships || '', params.orders || '', params.swaps || '', params.dispensers || '', params.memo || ''];
            case 'LINK':
                // FORMAT: VERSION|COIN1|COIN1_ACTION_INDEX|COIN2|COIN2_ACTION_INDEX|MEMO
                return [0, params.coin1, params.coin1ActionIndex, params.coin2, params.coin2ActionIndex, params.memo || ''];
            case 'BROADCAST':
                // FORMAT: VERSION|MESSAGE|VALUE
                return [0, params.message || '', params.value || ''];
            case 'MESSAGE':
                // FORMAT: VERSION|COIN|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY
                // COIN (destination network) is optional; empty = unscoped. Without it the
                // DESTINATION would land in the COIN slot and the message would be malformed.
                return [0, params.coin || '', params.destination, params.encryptionMethod || '', params.encryptionKey || ''];
            case 'ATTEST':
                // FORMAT v0 (request, VM-emitted): VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS|FEE_TICK|FEE_AMOUNT
                // FEE_TICK/FEE_AMOUNT are optional trailing fields; empty when the
                // contract requested no fee (the attest handler treats '' as null).
                return [0, params.requestId, params.providerId, params.requestPayload, params.callbackMethod,
                        params.callbackParams || '[]', params.redundancy, params.deadlineBlocks,
                        params.feeTick || '', params.feeAmount || ''];
            case 'EXECUTE':
                // FORMAT: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
                // (gasLimit travels via emissionData.VM_GAS_LIMIT, not the positional
                // params; the v0 EXECUTE format has no GAS_LIMIT slot.)
                return [0, params.contractIndex, params.method,
                        ...(Array.isArray(params.params) ? params.params : [])];
            case 'XCALL':
                // FORMAT v0 (request, VM-emitted): VERSION|CALL_ID|TARGET_CHAIN|TARGET_CONTRACT_INDEX|METHOD|PARAMS_JSON|GAS_LIMIT|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|DEADLINE_BLOCKS|CROSS_HOPS
                // crossHops is the HOST-derived value set above (never the VM's claim).
                return [0, params.callId, params.targetChain, params.contractIndex, params.method,
                        JSON.stringify(Array.isArray(params.params) ? params.params.map(String) : []),
                        params.gasLimit, params.callbackMethod,
                        JSON.stringify(Array.isArray(params.callbackParams) ? params.callbackParams.map(String) : []),
                        params.deadlineBlocks, params.crossHops];
            default:
                throw new Error('unsupported emission action: ' + action);
        }
    }

    // Normalize every amount-bearing field of an emitted action to its tick's decimals
    // (item 5346), using the SAME normalization the ledger applies at write time
    // (createLedgerChangeRecord -> util.bcadd(amount, 0, decimals)). This makes a contract's
    // over-precise computed amount tick-precise before it reaches the action handler, so it
    // passes isValidAmountFormat and the stored action amount matches the ledger row. Mutates
    // and returns `params`. Fields that are null/empty are left as-is; a tick unknown locally
    // (e.g. an ORDER/SWAP get-leg on a foreign chain) is left untouched because that leg is
    // validated on the far chain. ISSUE uses its inline declared decimals (the tick is not in
    // the issues table yet). Driven by EMISSION_AMOUNT_FIELDS; keep that map in sync with
    // buildActionParams (enforced by the emission-map coverage test).
    async _truncateEmissionAmounts(action, params){
        let fields = EMISSION_AMOUNT_FIELDS[action];
        if(!fields || !params) return params;
        for(let f of fields){
            let value = params[f.amount];
            if(this.util.isNull(value) || String(value) === '') continue;
            let decimals;
            if(f.declared){
                decimals = parseInt(params.decimals);
                if(!Number.isFinite(decimals)) continue;
            } else {
                // `gas: true` fields are denominated in the chain's fixed GAS tick
                // rather than a tick named by another param (VOTE deposit/gasEscrow).
                let tick = f.gas ? this.config['GAS'] : params[f.tick];
                if(this.util.isNull(tick) || String(tick) === '') continue;
                let tickId = await this.indexerDb.getTickerId(tick);
                if(tickId === null) continue;
                decimals = await this.indexerDb.getTokenDecimalPrecision(tickId);
            }
            // bcstr, not String(): a truncated dust amount below 1e-7 would render
            // exponentially ("3e-8") and fail the handler's format validation.
            params[f.amount] = this.util.bcstr(this.util.bcadd(value, 0, decimals));
        }
        return params;
    }

    // Process a SLASH emission from inside the VM. The emission carries:
    //   { action: 'SLASH', params: { contractIndex, pubkey, token, amount } }
    // Authorization is implicit: the gateway's contractStakeData accessor is scoped
    // to the executing contract, so SLASH can only target stakes against that contract.
    // We still defense-in-depth verify contractIndex matches data['CONTRACT_ACTION_INDEX'].
    //
    // Side effects (all inside the surrounding vm_execute savepoint):
    //   1. Deduct `amount` from contract_stakes (LIFO) then contract_unstakes.
    //   2. Credit the slashed amount to contracts.slash_destination_id (BURN or configured).
    //   3. Write a slash_events row keyed by execution_index for audit + wallet UX.
    async _processSlashEmission(emission, data, slashPosition){
        let p = emission.params || {};
        let contractIndex = Number(p.contractIndex);
        let pubkey        = String(p.pubkey || '').toLowerCase();
        let token         = String(p.token || '');
        let amount        = String(p.amount || '0');

        // Defense in depth: caller mismatch should never happen if the gateway
        // closure is sourced correctly, but throw if it does (rolls back the savepoint).
        if(contractIndex !== Number(data['CONTRACT_ACTION_INDEX']))
            throw new Error('SLASH emission contractIndex mismatch: ' + contractIndex + ' vs ' + data['CONTRACT_ACTION_INDEX']);

        // Load contract row to fetch slash_destination_id (locked at DEPLOY time)
        let contractInfo = await this.indexerDb.getContract(contractIndex);
        if(!contractInfo)
            throw new Error('SLASH: contract not found: ' + contractIndex);
        if(contractInfo.slash_destination_id === null || contractInfo.slash_destination_id === undefined)
            throw new Error('SLASH: contract has no slash destination configured');

        // Resolve FKs
        let pubkeyId = await this.indexerDb.getPubkeyId(pubkey);
        if(pubkeyId === null){
            // pubkey is not known to index_pubkeys at all: not staked anywhere on this
            // chain. Nothing to deduct; log for auditability so the no-op is visible.
            console.log('\t SLASH (no-op): pubkey not found in index_pubkeys: ' + pubkey +
                ' contract=' + contractIndex + ' token=' + token);
            return;
        }
        let tickId = await this.indexerDb.getTickerId(token);
        if(tickId === null){
            // token is unknown. Nothing to deduct; log for auditability.
            console.log('\t SLASH (no-op): token not found: ' + token +
                ' pubkey=' + pubkey + ' contract=' + contractIndex);
            return;
        }

        // Deduct (returns actual slashed total; may be less than requested if balance lower).
        // Pass BLOCK_INDEX so Pass 1 slashes only still-active stake; unstaked-but-cooling tokens are
        // slashed from contract_unstakes (Pass 2), preventing the double-count / supply inflation.
        let slashed = await this.indexerDb.slashContractStake(contractIndex, pubkeyId, tickId, amount, parseInt(data['BLOCK_INDEX']), data['ACTION_INDEX'], slashPosition);
        if(!this.util.bcgt(slashed, '0')){
            // pubkey + token exist but no active stake on this contract to deduct.
            // Log the attempted vs actual amounts so the no-op is visible in the audit trail.
            console.log('\t SLASH (no-op): zero slashed (no active stake): pubkey=' + pubkey +
                ' token=' + token + ' requested=' + amount + ' contract=' + contractIndex);
            return;
        }

        // Credit destination address (BURN or user-specified)
        let destQ = await this.indexerDb.doQuery(
            'SELECT address FROM index_addresses WHERE id=? LIMIT 1',
            [contractInfo.slash_destination_id]
        );
        if(destQ.length === 0)
            throw new Error('SLASH: destination address row missing');
        let destAddress = destQ[0].address;

        // Write credit row (action_index = the EXECUTE's action_index, for audit trail)
        await this.indexerDb.createCredit(data['ACTION_INDEX'], token, slashed, destAddress);

        // Track destination + token for balance reconciliation in the surrounding execute()
        this.util.addAddressTicker(destAddress, token);

        // Write the slash event row
        await this.indexerDb.createSlashEvent({
            EXECUTION_INDEX:       data['ACTION_INDEX'],
            TARGET_CONTRACT_INDEX: contractIndex,
            SIGNING_PUBKEY_ID:     pubkeyId,
            TICK_ID:               tickId,
            AMOUNT:                slashed,
            DESTINATION_ID:        contractInfo.slash_destination_id,
            BLOCK_INDEX:           data['BLOCK_INDEX']
        });
    }
}

// Exposed for the emission-map coverage test (keeps EMISSION_AMOUNT_FIELDS in sync with
// buildActionParams without copying the map into the test).
Execute.EMISSION_AMOUNT_FIELDS = EMISSION_AMOUNT_FIELDS;

module.exports = Execute;
