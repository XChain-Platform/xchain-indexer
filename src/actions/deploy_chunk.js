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
 * XChain Platform - DEPLOY v4 (chunk carrier)
 *
 * Internal collaborator of actions/deploy.js (not routed by action name).
 * DEPLOY.parse() delegates here when the format is v4. Carries one ordered base64
 * slice of a chunked contract's source. The slices are reassembled by a later
 * DEPLOY v2/v3 keyed on CODE_HASH (sha256 of the assembled UTF-8 source); see
 * actions/deploy.js. A v4 carrier never runs any VM code; it only validates +
 * stores its slice (and pays the per-byte gas for the bytes it puts on-chain, so
 * the assembling DEPLOY charges base+constructor only and the net cost ≈ a
 * single-shot deploy of the same code).
 *
 * PARAMS (DEPLOY v4):
 * - VERSION       - Format Version (4)
 * - CODE_HASH     - sha256 hex of the assembled source (chunk-group id)
 * - CHUNK_INDEX   - 0-based position within the group
 * - TOTAL_CHUNKS  - declared group size
 * - CODE_PART     - one base64 slice of base64(code)
 *
 ********************************************************************/

const crypto = require('crypto');

// Vendored single source of truth: ../protocol/constants.js
// (MAX_DEPLOY_CHUNKS / MAX_DEPLOYCHUNK_PART_BYTES); kept in lockstep with the SDK
// validator + splitter by the cross-service regression suite.
const PROTO = require('../protocol/constants.js');
const MAX_DEPLOY_CHUNKS         = PROTO.MAX_DEPLOY_CHUNKS;
const MAX_DEPLOYCHUNK_PART_BYTES = PROTO.MAX_DEPLOYCHUNK_PART_BYTES;

class DeployChunk {

    // `deploy` is the owning DEPLOY handler (deploy.js constructs this collaborator and hands
    // itself over). A carrier that completes a pending group runs THAT handler's deployment,
    // so a deferred deploy and an inline one are the same code, not two implementations.
    constructor(action, deploy){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
        this.deploy    = deploy || null;

        this.MAX_DEPLOY_CHUNKS          = MAX_DEPLOY_CHUNKS;
        this.MAX_DEPLOYCHUNK_PART_BYTES = MAX_DEPLOYCHUNK_PART_BYTES;
    }

    /**
     * Assemble a chunk group's source from the VALID carriers of ONE deployer below a given
     * action_index. Lifted out of deploy.js verbatim (same checks, same order, same verdict
     * strings) because two callers need it: the assembling DEPLOY v2/v3, which passes its own
     * action_index (so it assembles strictly from carriers that precede it), and a carrier
     * completing a pending group, which passes its own index + 1 so its own slice is part of
     * its own assembly (D12; without the +1 every out-of-order group would fail 'missing chunk').
     *
     * @returns {{code: string, error: ?string, incomplete: boolean}} `incomplete` marks the two
     *          verdicts a LATER carrier can still repair (no chunks / a missing position). Every
     *          other verdict is terminal for the group: dedup keeps the lowest action_index per
     *          position, so no later slice can change what a complete group assembles to.
     */
    async assembleCode(source, declaredHash, beforeActionIndex){
        let code       = '';
        let error      = null;
        let incomplete = false;
        declaredHash   = String(declaredHash);
        if(!/^[0-9a-f]{64}$/.test(declaredHash)){
            error = 'invalid: CODE_HASH (format)';
        } else {
            // Gather only VALID chunks from THIS deployer for THIS group, recorded BELOW the
            // given bound (assembly never consumes a chunk that does not precede the action
            // being assembled at, so any reorg dropping a chunk also drops the dependent
            // deployment, so rollback needs no bespoke logic). Dedup by position; the query is
            // ordered so the first (lowest action_index) submission deterministically wins.
            let rows  = await this.indexerDb.getDeployChunksForAssembly(source, declaredHash, beforeActionIndex);
            let parts = {};
            let total = null;
            for(let row of rows){
                let ci = Number(row.chunk_index);
                if(parts[ci] === undefined){
                    parts[ci] = String(row.code_part);
                    if(total === null) total = Number(row.total_chunks);
                }
            }
            if(total === null){
                error = 'invalid: CODE_HASH (no chunks)';
                incomplete = true;
            } else if(total < 1 || total > MAX_DEPLOY_CHUNKS){
                error = 'invalid: CODE_HASH (chunk count out of range)';
            } else {
                let b64 = '';
                for(let i = 0; i < total; i++){
                    if(parts[i] === undefined){
                        error = 'invalid: CODE_HASH (missing chunk ' + i + ')';
                        incomplete = true;
                        break;
                    }
                    b64 += parts[i];
                }
                if(!error){
                    try {
                        code = Buffer.from(b64, 'base64').toString('utf8');
                        if(Buffer.from(code, 'utf8').toString('base64') !== b64)
                            error = 'invalid: CODE_HASH (base64 decode failed)';
                    } catch(e){
                        error = 'invalid: CODE_HASH (base64 decode failed)';
                    }
                }
                // CODE_HASH binds the assembled bytes: a wrong / missing / extra / reordered
                // slice changes the digest. This is the integrity gate for the whole group.
                if(!error){
                    let assembledHash = crypto.createHash('sha256').update(code).digest('hex');
                    if(assembledHash !== declaredHash)
                        error = 'invalid: CODE_HASH (assembly mismatch)';
                }
            }
        }
        return { code, error, incomplete };
    }

    // Stores one chunk slice (DEPLOY v4). DEPLOY.parse() has already
    // validated the format is known, so there is no VERSION guard here.
    async parse(params, data, error){

        data['CODE_HASH']    = params[1];
        data['CHUNK_INDEX']  = params[2];
        data['TOTAL_CHUNKS'] = params[3];
        data['CODE_PART']    = params[4];

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // CODE_HASH must be a 64-char lowercase sha256 hex string (the group id)
        if(!error && !/^[0-9a-f]{64}$/.test(String(data['CODE_HASH'])))
            error = 'invalid: CODE_HASH (format)';

        // CHUNK_INDEX / TOTAL_CHUNKS must be non-negative integers
        if(!error && !/^\d+$/.test(String(data['CHUNK_INDEX'])))
            error = 'invalid: CHUNK_INDEX (format)';
        if(!error && !/^\d+$/.test(String(data['TOTAL_CHUNKS'])))
            error = 'invalid: TOTAL_CHUNKS (format)';

        let chunkIndex  = Number(data['CHUNK_INDEX']);
        let totalChunks = Number(data['TOTAL_CHUNKS']);

        // TOTAL_CHUNKS must be within [1, MAX_DEPLOY_CHUNKS]
        if(!error && (totalChunks < 1 || totalChunks > this.MAX_DEPLOY_CHUNKS))
            error = 'invalid: TOTAL_CHUNKS (out of range)';

        // CHUNK_INDEX must address a position inside the group
        if(!error && chunkIndex >= totalChunks)
            error = 'invalid: CHUNK_INDEX (out of range)';

        // CODE_PART must be present and a base64-alphabet string. It is a SLICE of
        // base64(code), not necessarily independently decodable, so we validate the
        // alphabet only; the assembling DEPLOY concatenates all parts then decodes +
        // sha256-verifies the whole.
        if(!error && this.util.isNull(data['CODE_PART']))
            error = 'invalid: CODE_PART (required)';
        if(!error && !/^[A-Za-z0-9+/]*={0,2}$/.test(String(data['CODE_PART'])))
            error = 'invalid: CODE_PART (base64)';

        // CODE_PART must stay within the per-chunk byte budget (belt-and-suspenders:
        // the decoder already drops any action whose compiled push exceeds the cap)
        if(!error && Buffer.byteLength(String(data['CODE_PART']), 'utf8') > this.MAX_DEPLOYCHUNK_PART_BYTES)
            error = 'invalid: CODE_PART (exceeds max size)';

        /*****************************************************************
         * Gas Fee Calculation
         *
         * A chunk pays the per-byte component for the bytes it puts on-chain
         * (its CODE_PART). The assembling DEPLOY v2/v3 then charges base +
         * constructor only, so net ≈ a single-shot deploy of the same source.
         ****************************************************************/

        let schedule  = this.config['GAS_SCHEDULE'];
        let partBytes = error ? 0 : Buffer.byteLength(String(data['CODE_PART']), 'utf8');
        // Priced through util.vmGasCost, the one arithmetic the static quote also uses.
        let gasCost   = this.util.vmGasCost(schedule, 'DEPLOY_CARRIER', partBytes);
        let fee       = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);

        let gas       = this.config['GAS'];
        let tokenInfo = await this.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let balances  = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Native coin or XCHAIN balance; mirrors deploy.js
        let feePaymentMode = 2; // default: xchain balance
        if(!error && tokenInfo && this.util.bcgt(fee, 0)){
            let pmMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(pmMode === 'native'){
                let tempFees   = { AMOUNT: fee };
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

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t DEPLOY v4 : hash=" + data['CODE_HASH'] + ' : ' + chunkIndex + '/' + totalChunks +
            ' : bytes=' + partBytes + ' : ' + data['STATUS']);

        // Persist the chunk (stored valid or invalid so the explorer can surface its status;
        // the DEPLOY assembler reads only VALID rows).
        await this.indexerDb.recordDeployChunk({
            ACTION_INDEX : data['ACTION_INDEX'],
            SOURCE       : data['SOURCE'],
            CODE_HASH    : data['CODE_HASH'],
            CHUNK_INDEX  : chunkIndex,
            TOTAL_CHUNKS : totalChunks,
            CODE_PART    : data['CODE_PART'],
            STATUS       : status,
            BLOCK_INDEX  : data['BLOCK_INDEX']
        });

        this.util.addAddressTicker(data['SOURCE'], gas);

        let credits = [],
            debits  = [];

        // Debit gas fee from SOURCE (XCHAIN deduction mode only); mirrors deploy.js exactly
        // (!error && feePaymentMode === 2) so a rejected chunk never burns gas the source
        // never had (which would trip the per-block supply SanityError).
        if(!error && tokenInfo && feePaymentMode === 2)
            debits.push([gas, fee, data['SOURCE']]);

        // R1 (DEPLOY_DEFERRED_ASSEMBLY): this carrier may be the slice that completes a group
        // whose assembler already landed pending, in which case the contract deploys HERE, at
        // this action, and this action's rows are the contract's (D1: the contract's index and
        // its permanent C:<CHAIN>:<index> address are this carrier's). Only a VALID carrier can
        // complete a group - an invalid one was never part of the assembly - and only the FIRST
        // action to complete it deploys: a later duplicate slice finds the assembler already
        // consumed (a contract_executions row names it) and is merely stored, as today.
        if(status === 'valid' && await this.actions.protocolChanges.isEnabled('DEPLOY_DEFERRED_ASSEMBLY', data['BLOCK_INDEX'])){
            // One indexed point read first; the range scan below runs only when a group of this
            // deployer's is actually waiting on its carriers.
            let assembler = await this.indexerDb.getPendingDeployAssembler(data['SOURCE'], data['CODE_HASH'], data['ACTION_INDEX']);
            if(assembler){
                // Bound = this action + 1, so this carrier's own slice is inside its own
                // assembly. An incomplete group is not this carrier's business: it is stored,
                // the assembler stays pending, and whichever carrier closes the last gap
                // deploys. Any other assembly verdict is terminal and IS deployed at C, which
                // writes the execution row naming the assembler and so consumes it (R4): a
                // group that assembles to the wrong bytes must not stay pending forever.
                let assembly = await this.assembleCode(data['SOURCE'], data['CODE_HASH'], Number(data['ACTION_INDEX']) + 1);
                if(!assembly.incomplete){
                    // Wire parameters come from the assembler's own rows (it is the action that
                    // parsed them, under ITS block's flag days); everything transaction-derived
                    // stays this carrier's `data`. slash_destination is stored as an address id,
                    // so it is resolved back to the address createContract re-interns.
                    let slashDestination = this.util.isNull(assembler.slash_destination_id)
                        ? null
                        : await this.indexerDb.getAddressById(assembler.slash_destination_id);
                    await this.deploy.runDeployment(data, {
                        code:              assembly.code,
                        isChunked:         true,
                        gasLimit:          this.util.isNull(assembler.gas_limit) ? null : Number(assembler.gas_limit),
                        constructorParams: this.util.isNull(assembler.input_params) ? '' : String(assembler.input_params),
                        cooldownBlocks:    this.util.isNull(assembler.cooldown_blocks) ? null : Number(assembler.cooldown_blocks),
                        slashDestination:  slashDestination
                    }, assembly.error, {
                        skipBaseFee:          true,   // the assembler paid it (D3/D15)
                        skipSleeping:         true,   // this carrier just ran the same check (D16)
                        assemblerActionIndex: assembler.action_index,
                        feePaymentMode:       assembler.fee_payment_mode,
                        // This carrier's own fee rides the deployment's single ledger write.
                        pendingDebits:        debits
                    });
                    // runDeployment wrote this action's ledger record, balances, tokens and
                    // mappings, and overwrote data['STATUS'] with the DEPLOYMENT's verdict. The
                    // carrier's verdict is its own and is already stored on its deploy_chunks
                    // row; restore it so the fee-quote dry run and the action counters read the
                    // carrier's status rather than the contract's.
                    data['STATUS'] = status;
                    return;
                }
            }
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = DeployChunk;
// Expose the canonical caps for the cross-service regression drift guard.
module.exports.MAX_DEPLOY_CHUNKS = MAX_DEPLOY_CHUNKS;
module.exports.MAX_DEPLOYCHUNK_PART_BYTES = MAX_DEPLOYCHUNK_PART_BYTES;
