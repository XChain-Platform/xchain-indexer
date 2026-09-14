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
 * XChain Platform Action - DEPLOY
 *
 * This action deploys a smart contract to the XChain VM.
 *
 * PARAMS:
 * - VERSION            - Format Version
 * - CODE_ENCODING      - Contract code (base64-encoded at/after the DEPLOY_BASE64_CODE
 *                        activation; hex-encoded before it (see the gated decode below)
 * - GAS_LIMIT          - Maximum gas units for deployment
 * - CONSTRUCTOR_PARAMS - Optional constructor parameters (JSON)
 *
 * FORMATS:
 * - 0 = Deploy a contract (inline code, non-stakeable)
 * - 1 = Deploy a contract (inline code, stakeable: COOLDOWN_BLOCKS + SLASH_DESTINATION)
 * - 2 = Deploy a contract (chunked: code assembled from prior v4 carriers, non-stakeable)
 * - 3 = Deploy a contract (chunked, stakeable)
 * - 4 = Chunk carrier: store one ordered base64 slice of a chunked contract's
 *       source (no VM run). Reassembled by a later v2/v3 keyed on CODE_HASH.
 *
 * PARTS (this directory): this file is the entry, parse() and the runDeployment()
 * sequence. wire_params.js reads the v0-v3 fields, validate.js holds the non-VM
 * checks, code_source.js decodes or assembles the source, lint.js and manifest.js
 * are the VM gates, fees.js the base gas fee, contract_rows.js the hash, address,
 * status and contract rows, constructor_run.js and constructor_effects.js the
 * constructor, settle.js the gas settlement, execution record and ledger, and
 * constants.js the literals they share. deploy_chunk.js is the v4 carrier.
 *
 ********************************************************************/

const DeployChunk = require('./deploy_chunk.js');
const ProviderRegistry = require('../../attestation/providerRegistry.js');

// Per-provider deadline windows are built per instance in the constructor
// (this.providerDeadlineWindows) from the CONFIGURED registry. A module-scoped
// snapshot cannot see config.ATTESTATION.PROVIDERS, so the VM enforced DEFAULTS
// while attest.js validated against the overlay, letting the VM accept a request
// the indexer then rejects.

// Maximum smart-contract code size (64 KiB). Vendored single source of truth:
// ../protocol/constants.js (byte-identical to xchain-documentation/protocol/
// constants.js, MAX_CODE_SIZE); kept equal to the SDK and VM by the
// cross-service regression suite, which reads the value exported as a static
// of the Deploy class below.
const PROTO = require('../../protocol/constants.js');
const MAX_CODE_SIZE = PROTO.MAX_CODE_SIZE;

// Maximum chunks a chunked DEPLOY (v2/v3) may assemble. Vendored from
// ../protocol/constants.js (MAX_DEPLOY_CHUNKS); kept in lockstep with the SDK +
// the v4 carrier handler by the cross-service regression suite.
const MAX_DEPLOY_CHUNKS = PROTO.MAX_DEPLOY_CHUNKS;

// The deployment's parts, in the order parse() and runDeployment() call them. Each
// takes this handler explicitly and runs only while no earlier verdict was reached.
const { PENDING_ASSEMBLY_STATUS } = require('./constants.js');
const { readWireParams } = require('./wire_params.js');
const { resolveSlashDestination, validateStakingConfig, validateSlashDestinationAddress,
        checkCodeAndGasLimit, checkSourceAwake, landHeldVerdict } = require('./validate.js');
const { obtainCode } = require('./code_source.js');
const { assertExecutorAvailable, lintContractCode } = require('./lint.js');
const { readContractManifest } = require('./manifest.js');
const { priceDeployment, validateFeePayment, debitBaseFee } = require('./fees.js');
const { deriveContractIdentity, determineStatus, writeContractRows } = require('./contract_rows.js');
const { planConstructor, executeConstructor } = require('./constructor_run.js');
const { applyConstructorEffects } = require('./constructor_effects.js');
const { settleGas, writeExecutionRecord, writeLedger } = require('./settle.js');

/**
 * The run state every deployment step reads and writes: the DEPLOY's wire parameters, the
 * deferred-assembly options (each is described on runDeployment), and the verdict so far.
 * Steps add the values later steps read (gasCost, fee, tokenInfo, status, ...) as they run.
 */
function startRun(data, wire, error, options){
    let { code, isChunked, gasLimit, constructorParams, cooldownBlocks, slashDestination } = wire;
    let { skipBaseFee = false, skipSleeping = false, assemblerActionIndex = null, feePaymentMode: paidFeePaymentMode = null,
          pendingDebits = [], pendingCodeHash = null, deferredError = null } = options;

    // The held chunk verdict (deferred assembly). While one is held no deployment happens - no VM work, no
    // derived address, no constructor - but the fee and sleeping checks below still run,
    // which is the whole point of holding it: post-activation an early assembler on a
    // native-fee chain with no fee output is 'invalid: insufficient fee (native coin output
    // required)' and a sleeping source's is 'invalid: SOURCE (sleeping)', not a pending row.
    let heldVerdict   = pendingCodeHash !== null ? PENDING_ASSEMBLY_STATUS : deferredError;
    let landedPending = false;

    return {
        data, code, isChunked, gasLimit, constructorParams, cooldownBlocks, slashDestination,
        skipBaseFee, skipSleeping, assemblerActionIndex, paidFeePaymentMode, pendingDebits,
        pendingCodeHash, deferredError, error, heldVerdict, landedPending
    };
}

class Deploy {

    // Expose the canonical caps so the cross-service regression suite can assert they
    // have not drifted from the protocol constants.
    static MAX_CODE_SIZE     = MAX_CODE_SIZE;
    static MAX_DEPLOY_CHUNKS = MAX_DEPLOY_CHUNKS;

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Per-provider deadline windows injected into the VM gateway so a constructor's
        // attestation.request() rejects an over-limit deadlineBlocks at call time rather
        // than landing on-chain and being silently rejected by the indexer DEADLINE check.
        // Built from the CONFIGURED registry, the same construction attest.js uses, so the
        // VM cap and the host cap cannot drift under a config.ATTESTATION.PROVIDERS overlay.
        this.providerDeadlineWindows = new ProviderRegistry(this.config).getDeadlineWindows();

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|CODE_ENCODING|GAS_LIMIT|CONSTRUCTOR_PARAMS';
        // v1 adds optional staking config: COOLDOWN_BLOCKS + SLASH_DESTINATION (address or 'BURN' sentinel).
        // Contracts deployed without these fields cannot be stake targets.
        this.formats[1] = 'VERSION|CODE_ENCODING|GAS_LIMIT|CONSTRUCTOR_PARAMS|COOLDOWN_BLOCKS|SLASH_DESTINATION';
        // Chunked (v2/v3): the code is assembled from the deployer's prior v4 carrier actions
        // keyed on CODE_HASH (sha256 of the assembled source) instead of carried inline. v2
        // mirrors v0 (rest CONSTRUCTOR_PARAMS, no staking); v3 mirrors v1 (fixed staking fields).
        this.formats[2] = 'VERSION|CODE_HASH|GAS_LIMIT|CONSTRUCTOR_PARAMS';
        this.formats[3] = 'VERSION|CODE_HASH|GAS_LIMIT|CONSTRUCTOR_PARAMS|COOLDOWN_BLOCKS|SLASH_DESTINATION';
        // v4 carries one ordered base64 slice of a chunked contract's source (the chunk
        // carrier, formerly the standalone DEPLOYCHUNK action). It never runs VM code;
        // the slices are reassembled by a later v2/v3 keyed on CODE_HASH.
        this.formats[4] = 'VERSION|CODE_HASH|CHUNK_INDEX|TOTAL_CHUNKS|CODE_PART';

        // Maximum code size (64KB); see the MAX_CODE_SIZE module constant above.
        this.MAX_CODE_SIZE = MAX_CODE_SIZE;

        // Cooldown bounds for contract-staking (DEPLOY v1+)
        this.MIN_COOLDOWN_BLOCKS = 1;
        this.MAX_COOLDOWN_BLOCKS = 100000;

        // Chunk-carrier (v4) collaborator: validates + stores a single code slice, owns the
        // slice-assembly routine both sides use, and (post-DEPLOY_DEFERRED_ASSEMBLY) runs the
        // deployment when the carrier it just stored completes a pending group. It is handed
        // THIS instance so that deployment is the identical code path an assembler takes.
        // Not routed by action name; DEPLOY.parse() delegates to it for v4.
        this.chunkStore = new DeployChunk(action, this);
    }

    // Handle parsing the DEPLOY transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        // Verify VERSION is a format this action recognizes
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // v4 is the chunk carrier: validate + store one code slice and return. It never
        // runs VM code, so it bypasses the entire inline/chunked-assemble path below.
        if(format === 4)
            return await this.chunkStore.parse(params, data, error);

        // The wire parameters, read by format family (wire_params.js)
        let { isChunked, hasStaking } = readWireParams(data, params, format);

        // The v1/v3 staking config and its SLASH_DESTINATION, first failure wins (validate.js)
        let slashDest = await resolveSlashDestination(this, data, hasStaking, error);
        error = await validateStakingConfig(this, data, hasStaking, error);
        error = await validateSlashDestinationAddress(this, data, slashDest, error);

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        // The contract source: chunk assembly or inline decode (code_source.js)
        let source = await obtainCode(this, data, isChunked, error);

        // Everything from here on is the deployment itself, shared with the deferred
        // assembly path: the wire parameters travel explicitly so a caller that did NOT
        // parse them off this transaction (a chunk carrier completing a group, which reads
        // them from the assembler's stored rows) can hand over the identical set while
        // `data` stays its OWN transaction context.
        return await this.runDeployment(data, {
            code:              source.code,
            isChunked:         isChunked,
            gasLimit:          data['GAS_LIMIT'],
            constructorParams: data['CONSTRUCTOR_PARAMS'],
            cooldownBlocks:    data['COOLDOWN_BLOCKS'],
            slashDestination:  data['SLASH_DESTINATION']
        }, source.error, {
            pendingCodeHash: source.pendingCodeHash,
            deferredError:   source.deferredError
        });
    }

    /**
     * The deployment: every step after the contract source exists, from the size check
     * through the syntax/lint gates, the permissions manifest, the gas fee, the derived
     * address, the constructor and its state/emissions, to the contracts /
     * contract_permissions / contract_executions rows, the ledger debit and the mappings.
     *
     * Split out of parse() because a DEPLOY is not always deployed by the action that
     * carried its parameters: a chunked group whose pieces confirm out of order is deployed
     * by the action that completes it, which owns a different transaction. Hence the two
     * distinct inputs.
     *
     * @param {object} data  The DEPLOYING action's own transaction context, and the only
     *                       source of everything transaction-derived: ACTION_INDEX (which is
     *                       the contract's index and its permanent C:<CHAIN>:<index> address),
     *                       SOURCE, BLOCK_INDEX, BLOCK_TIME, TX_HASH, TX_INDEX, TX_VOUT,
     *                       BATCH_POSITION, TX_OUTPUTS and ISSUANCE_LIMIT_LEDGER. Mutated:
     *                       STATUS is written here, and the native-fee fields when that
     *                       validation runs. Every row this method writes is keyed at
     *                       data['ACTION_INDEX'], which is what keeps rollback generic.
     * @param {object} wire  The DEPLOY's own parameters, which may come from another
     *                       action's stored rows: {code, isChunked, gasLimit,
     *                       constructorParams, cooldownBlocks, slashDestination}.
     *                       `slashDestination` must already be resolved to an address
     *                       (carets and the BURN sentinel resolve per block, at the action
     *                       that parsed them). `isChunked` selects the gas schedule row:
     *                       a chunked deploy is not charged per byte again, its carriers
     *                       already paid that.
     * @param {?string} error  A verdict already reached by the caller, or null. Non-null
     *                       short-circuits every check below exactly as an inline reject does.
     * @param {object} [options]  Deferred-assembly seams, all defaulting to the inline
     *                       behaviour:
     *                       - skipBaseFee: the base fee was already validated and charged at
     *                         another action, so neither validate nor re-derive the mode here.
     *                       - feePaymentMode: the mode that other action actually paid in
     *                         (1 native, 2 XCHAIN); it decides whether the constructor gas is
     *                         debited at all, so it cannot be re-detected from this
     *                         transaction's outputs.
     *                       - skipSleeping: the source's sleeping check already ran at this
     *                         same block for this same action's transaction.
     *                       - assemblerActionIndex: the assembler this deployment consumes,
     *                         recorded on the execution row (that row IS the consumption
     *                         marker, so it must be written whatever the constructor does).
     *                       - pendingDebits: [tick, amount, address] triples this SAME action
     *                         already owes (the completing carrier's own gas fee). They ride
     *                         the single ledger write below and are applied to the in-memory
     *                         balances first, because getAddressBalances bounds at
     *                         action_index < this action and so cannot see them.
     *                       - pendingCodeHash: this action is a chunked assembler whose group
     *                         is not complete yet, so it lands PENDING under that declared hash
     *                         instead of deploying. The fee and sleeping checks still
     *                         run and their rejects win; the base fee is still charged.
     *                       - deferredError: a verdict held until after those same two checks
     *                         (the duplicate-pending verdict), so a fee-mode or sleeping reject wins
     *                         over it exactly as it does for a pending landing.
     */
    async runDeployment(data, wire, error = null, options = {}){
        let run = startRun(data, wire, error, options);

        // Size and GAS_LIMIT, then the VM gates: the executor is present, the syntax/lint
        // rules pass, and the permissions manifest and contract meta conform (validate.js,
        // lint.js, manifest.js). Each check runs only while no verdict has been reached.
        checkCodeAndGasLimit(this, run);
        assertExecutorAvailable(this, run);
        await lintContractCode(this, run);
        await readContractManifest(this, run);

        // The gas fee: priced, its payment validated, then debited in memory (fees.js)
        await priceDeployment(this, run);
        await validateFeePayment(this, run);
        debitBaseFee(this, run);

        // The sleeping check, then the held chunk verdict it must not pre-empt (validate.js)
        await checkSourceAwake(this, run);
        landHeldVerdict(run);

        // The code hash and derived address, then the constructor (contract_rows.js,
        // constructor_run.js)
        await deriveContractIdentity(this, run);
        await planConstructor(this, run);
        await executeConstructor(this, run);

        // The verdict and contract rows, the constructor's state and emissions, then the gas
        // settlement, execution record and ledger (contract_rows.js, constructor_effects.js,
        // settle.js)
        determineStatus(this, run);
        await writeContractRows(this, run);
        await applyConstructorEffects(this, run);
        settleGas(this, run);
        await writeExecutionRecord(this, run);
        await writeLedger(this, run);
    }
}

module.exports = Deploy;
