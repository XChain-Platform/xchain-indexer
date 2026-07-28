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
 ********************************************************************/

const crypto = require('crypto');
const DeployChunk = require('./deploy_chunk.js');
const ProviderRegistry = require('../attestation/providerRegistry.js');
const { rethrowIfInfraFault } = require('./faultGuard.js');
const vmDeployLintPkg3 = require('../vm_deploy_lint_pkg3_activation.js');

// Per-provider deadline windows, injected into the VM gateway so a constructor's
// attestation.request() rejects an over-limit deadlineBlocks at call time rather
// than landing on-chain and being silently rejected by the indexer DEADLINE check.
// Sourced from the single provider registry so the two caps cannot drift.
const PROVIDER_DEADLINE_WINDOWS = new ProviderRegistry().getDeadlineWindows();

// Maximum smart-contract code size (64 KiB). Vendored single source of truth:
// ../protocol/constants.js (byte-identical to xchain-documentation/protocol/
// constants.js, MAX_CODE_SIZE); kept equal to the SDK and VM by the
// cross-service regression suite, which reads the value exported at the bottom
// of this module.
const PROTO = require('../protocol/constants.js');
const MAX_CODE_SIZE = PROTO.MAX_CODE_SIZE;

// Maximum chunks a chunked DEPLOY (v2/v3) may assemble. Vendored from
// ../protocol/constants.js (MAX_DEPLOY_CHUNKS); kept in lockstep with the SDK +
// the v4 carrier handler by the cross-service regression suite.
const MAX_DEPLOY_CHUNKS = PROTO.MAX_DEPLOY_CHUNKS;

// Gas ceiling for the constructor clamp below. Must stay in lockstep with
// GAS_CEILING in actions/execute.js: if the ceiling ever changes, both files
// must move together or validators fork on the first resource-terminated
// constructor (the clamped value flows into contract_executions.gas_used, which
// is consensus-hashed via contract_hash).
const GAS_CEILING = 1000000;

class Deploy {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

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

        // Chunk-carrier (v4) collaborator: validates + stores a single code slice.
        // Not routed by action name; DEPLOY.parse() delegates to it for v4.
        this.chunkStore = new DeployChunk(action);
    }

    // Handle parsing the DEPLOY transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // v4 is the chunk carrier: validate + store one code slice and return. It never
        // runs VM code, so it bypasses the entire inline/chunked-assemble path below.
        if(format === 4)
            return await this.chunkStore.parse(params, data, error);

        // Format families. Chunked (v2/v3) carries CODE_HASH in params[1] and assembles the
        // code from prior v4 carrier actions; inline (v0/v1) carries the base64 source there.
        // v0/v2 take CONSTRUCTOR_PARAMS as a rest field (a multi-arg constructor sends each arg
        // as its own pipe segment, like EXECUTE's METHOD_PARAMS); v1/v3 keep the single-field
        // form because COOLDOWN_BLOCKS + SLASH_DESTINATION trail the constructor args, so a
        // multi-arg v1/v3 constructor must sub-delimit within params[3]. v1/v3 carry the
        // optional staking config; v0/v2 do not.
        let isChunked  = (format === 2 || format === 3);
        let isRestCtor = (format === 0 || format === 2);
        let hasStaking = (format === 1 || format === 3);

        // Extract params
        if(isChunked)
            data['CODE_HASH_PARAM'] = params[1];
        else
            data['CODE_ENCODING']   = params[1];
        data['GAS_LIMIT']          = params[2];
        data['CONSTRUCTOR_PARAMS'] = isRestCtor ? params.slice(3).join('|') : params[3];
        // v1/v3 optional staking config
        data['COOLDOWN_BLOCKS']    = hasStaking ? params[4] : null;
        data['SLASH_DESTINATION']  = hasStaking ? params[5] : null;

        // Resolve a compacted ^<id> SLASH_DESTINATION back to its canonical address
        // (the SDK compacts this field by default). The 'BURN' sentinel and null are
        // left untouched; a non-resolvable/malformed reference is left as-is. This
        // also keeps a malformed id off the slash-credit FK path. See resolveAddressRefChecked.
        // `slashDestExplicit` marks a user-supplied, non-BURN destination: only those
        // get the isCryptoAddress format reject below (the BURN sentinel and the
        // default-to-BURN path resolve to the trusted configured burn address).
        // At/after the  flag-day an unresolvable reference is a hard reject, which
        // no longer depends on the separate DEPLOY_SLASH_DEST_ADDRESS_VALID gate being
        // live: below that gate a bogus caret is interned into the IMMUTABLE
        // contracts.slash_destination and every later slash routes stake nowhere. The
        // verdict is captured here but APPLIED with the sibling address check further
        // down, so the existing pairing/cooldown verdicts still win (same ordering the
        // DEPLOY_SLASH_DEST_ADDRESS_VALID check was written to preserve).
        let slashDestExplicit = hasStaking && !this.util.isNull(data['SLASH_DESTINATION']) && data['SLASH_DESTINATION'] !== 'BURN';
        let slashDestUnresolvable = false;
        if(!error && slashDestExplicit){
            let slashRef = await this.indexerDb.resolveAddressRefChecked(data['SLASH_DESTINATION'], data['BLOCK_INDEX']);
            data['SLASH_DESTINATION'] = slashRef.value;
            slashDestUnresolvable = slashRef.rejected;
        }

        // Validate v1/v3 staking config (both optional, but pairing rules apply)
        if(!error && hasStaking){
            let hasCooldown = !this.util.isNull(data['COOLDOWN_BLOCKS']) && data['COOLDOWN_BLOCKS'] !== '';
            let hasDest     = !this.util.isNull(data['SLASH_DESTINATION']) && data['SLASH_DESTINATION'] !== '';
            // SLASH_DESTINATION without COOLDOWN_BLOCKS is meaningless
            if(hasDest && !hasCooldown){
                error = 'invalid: SLASH_DESTINATION (requires COOLDOWN_BLOCKS)';
            }
            if(!error && hasCooldown){
                // Gate: COOLDOWN_BLOCKS_INTEGER adds the isInteger check the doc contract
                // (unsigned int, Contract_Staking.md) always specified; isNumeric alone
                // accepted fractional strings ('50.5'), storing a fractional
                // contracts.cooldown_blocks that flowed a non-integer COOLDOWN_END_BLOCK
                // into UNSTAKE. Gated on the contract-era flag-day so a from-genesis
                // replay reproduces any historic fractional accept verdict below it.
                let cooldownIntegerStrict = await this.actions.protocolChanges.isEnabled('COOLDOWN_BLOCKS_INTEGER', data['BLOCK_INDEX']);
                if(!this.util.isNumeric(data['COOLDOWN_BLOCKS'])){
                    error = 'invalid: COOLDOWN_BLOCKS (not numeric)';
                } else if(cooldownIntegerStrict && !this.util.isInteger(data['COOLDOWN_BLOCKS'])){
                    error = 'invalid: COOLDOWN_BLOCKS (not an integer)';
                } else {
                    let cb = Number(data['COOLDOWN_BLOCKS']);
                    if(cb < this.MIN_COOLDOWN_BLOCKS || cb > this.MAX_COOLDOWN_BLOCKS){
                        error = 'invalid: COOLDOWN_BLOCKS (out of range)';
                    }
                }
            }
            // If contract opted into staking but didn't name a destination, default to BURN.
            // Validate identically to the explicit 'BURN' sentinel below: a missing BURN
            // address must reject here too, or the contract is stakeable but permanently
            // un-slashable (slash throws at runtime because slash_destination is NULL).
            if(!error && hasCooldown && !hasDest){
                data['SLASH_DESTINATION'] = (this.config['ADDRESS'] && this.config['ADDRESS']['BURN']) || null;
                if(this.util.isNull(data['SLASH_DESTINATION']))
                    error = 'invalid: SLASH_DESTINATION (BURN address not configured)';
            }
            // Resolve BURN sentinel to the configured BURN address
            if(!error && data['SLASH_DESTINATION'] === 'BURN'){
                data['SLASH_DESTINATION'] = (this.config['ADDRESS'] && this.config['ADDRESS']['BURN']) || null;
                if(this.util.isNull(data['SLASH_DESTINATION']))
                    error = 'invalid: SLASH_DESTINATION (BURN address not configured)';
            }
            // Clear staking config on non-stakeable deployments so createContract stores NULLs
            if(!hasCooldown){
                data['COOLDOWN_BLOCKS']   = null;
                data['SLASH_DESTINATION'] = null;
            }
        }

        // Pkg6 / dede7788 (gated DEPLOY_SLASH_DEST_ADDRESS_VALID): an EXPLICIT SLASH_DESTINATION
        // must resolve to a well-formed chain address. resolveAddressRef leaves an unresolvable
        // caret id or a malformed literal UNCHANGED, and isCryptoAddress is false for both, so
        // without this guard a bogus destination is interned into the IMMUTABLE
        // contracts.slash_destination and every later slash routes stake to an unspendable
        // address (permanent money loss). Runs after the pairing/cooldown checks so the existing
        // 'requires COOLDOWN_BLOCKS' verdict still wins for a dest-without-cooldown DEPLOY, and
        // only for a still-present explicit destination (BURN paths already resolved to the
        // trusted configured address). Gated because a reject here changes a historic 'valid'
        // acceptance verdict and the contract_hash; see the flag-day note in protocol_changes.js.
        if(!error && slashDestExplicit && !this.util.isNull(data['SLASH_DESTINATION'])
            && await this.actions.protocolChanges.isEnabled('DEPLOY_SLASH_DEST_ADDRESS_VALID', data['BLOCK_INDEX'])
            && !this.util.isCryptoAddress(data['SLASH_DESTINATION']))
            error = 'invalid: SLASH_DESTINATION (invalid address)';

        // : the same reject for an unresolvable ^<id>, on its own flag-day and
        // independent of the gate above (an unresolvable caret is a wire-reference
        // fault, not merely a badly-formatted address). Same position, so the
        // pairing/cooldown verdicts and the address-format verdict both still win, and
        // only while the destination survived the clear-on-no-cooldown path above.
        if(!error && slashDestUnresolvable && !this.util.isNull(data['SLASH_DESTINATION']))
            error = 'invalid: SLASH_DESTINATION (unresolvable ^id)';

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Code Validations
         ****************************************************************/

        // Obtain the contract source `code`. Chunked (v2/v3) assembles base64(code) from the
        // deployer's prior v4 carrier rows then decodes + sha256-verifies it; inline (v0/v1)
        // decodes CODE_ENCODING directly. Post-activation the encoding is base64; pre-activation
        // it is hex (the original format), gated on block_time so a replay/heterogeneous fleet
        // decodes historical DEPLOYs identically. Either way `code` is the UTF-8 source that
        // flows into the SHARED size / syntax / manifest / gas / constructor path below.
        // (base64 is 1.33x vs hex's 2x and has no '|', so it is delimiter-safe;
        // Buffer.from is lenient, so we round-trip to reject non-canonical base64 deterministically.)
        let code = '';
        if(!error && isChunked){
            let declaredHash = String(data['CODE_HASH_PARAM']);
            if(!/^[0-9a-f]{64}$/.test(declaredHash)){
                error = 'invalid: CODE_HASH (format)';
            } else {
                // Gather only VALID chunks from THIS deployer for THIS group, recorded at a
                // LOWER action_index than this DEPLOY (assembly never consumes a chunk that
                // does not precede it, so any reorg dropping a chunk also drops the dependent
                // DEPLOY, so rollback needs no bespoke logic). Dedup by position; the query is
                // ordered so the first (lowest action_index) submission deterministically wins.
                let rows  = await this.indexerDb.getDeployChunksForAssembly(data['SOURCE'], declaredHash, data['ACTION_INDEX']);
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
                } else if(total < 1 || total > MAX_DEPLOY_CHUNKS){
                    error = 'invalid: CODE_HASH (chunk count out of range)';
                } else {
                    let b64 = '';
                    for(let i = 0; i < total; i++){
                        if(parts[i] === undefined){ error = 'invalid: CODE_HASH (missing chunk ' + i + ')'; break; }
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
        } else if(!error){
            if(this.util.isNull(data['CODE_ENCODING'])){
                error = 'invalid: CODE_ENCODING (required)';
            } else if(await this.actions.protocolChanges.isEnabled('DEPLOY_BASE64_CODE', data['BLOCK_INDEX'])){
                // Post-activation: base64. 1.33x vs hex's 2x and no '|', so delimiter-safe.
                // Buffer.from(...,'base64') is lenient, so round-trip to reject non-canonical
                // base64 deterministically across nodes.
                try {
                    let b64 = String(data['CODE_ENCODING']);
                    code = Buffer.from(b64, 'base64').toString('utf8');
                    if(Buffer.from(code, 'utf8').toString('base64') !== b64)
                        error = 'invalid: CODE_ENCODING (base64 decode failed)';
                } catch(e){
                    error = 'invalid: CODE_ENCODING (base64 decode failed)';
                }
            } else {
                // Pre-activation: hex. Byte-for-byte the original pre-base64 decode so a
                // from-genesis replay reproduces every historical inline DEPLOY's code_hash
                // exactly. Deliberately NO round-trip check; the historical nodes did not
                // round-trip hex, and matching their (lenient) behaviour is the whole point
                // of the gate.
                try {
                    code = Buffer.from(data['CODE_ENCODING'], 'hex').toString('utf8');
                } catch(e){
                    error = 'invalid: CODE_ENCODING (hex decode failed)';
                }
            }
        }

        // Verify code size
        if(!error && Buffer.byteLength(code, 'utf8') > this.MAX_CODE_SIZE)
            error = 'invalid: CODE_ENCODING (exceeds max size)';

        // Verify GAS_LIMIT is provided and valid
        if(!error && (this.util.isNull(data['GAS_LIMIT']) || !this.util.isNumeric(data['GAS_LIMIT'])))
            error = 'invalid: GAS_LIMIT (required)';

        /*****************************************************************
         * VM Syntax Validation (before charging gas)
         ****************************************************************/

        // Fail CLOSED when the VM executor is unavailable, exactly as the
        // execute path does (execute.js: `controller (vm unavailable)`).
        // Without this, a node whose optional `require('xchain-vm')` failed
        // (actions.js sets this.vm=null and only warns) would SKIP the entire
        // syntax/lint/consensus gate below plus the manifest read and record
        // the deploy VALID, while the rest of the fleet rejects it: a
        // host-condition-induced ledger divergence (fail-open). Throwing an
        // EXECUTOR_UNAVAILABLE host fault instead writes NO verdict at all:
        // faultGuard.rethrowIfInfraFault treats this code as an infra halt, so
        // the block loop rolls back and retries without committing until the
        // native VM is rebuilt. No consensus rule changes, so no flag-day is
        // needed - a healthy node validates exactly as before.
        if(!error && !this.actions.vm){
            let e = new Error('deploy VM executor unavailable');
            e.code = 'EXECUTOR_UNAVAILABLE';
            throw e;
        }

        let floatWarnings = [];
        if(!error && this.actions.vm){
            // banned-async (async/await/Promise) is a consensus-gated deploy rule:
            // below the VM_BANNED_ASYNC flag-day such a contract was ACCEPTED, so a
            // from-genesis replay must reproduce that historical verdict. Resolve the
            // activation for THIS block and pass it through; all other consensus rules
            // are always enforced.
            let enforceBannedAsync = await this.actions.protocolChanges.isEnabled('VM_BANNED_ASYNC', data['BLOCK_INDEX']);
            // The VM_LINT_HARDENING rule set (flag-day Pkg 4) is gated the same
            // way: below its activation a deploy resolves exactly as it did
            // historically (both gates share the ratified  anchor).
            let enforceLintHardening = await this.actions.protocolChanges.isEnabled('VM_LINT_HARDENING', data['BLOCK_INDEX']);
            // banned-generator (29912bd8) + banned-wasm (75190596 deploy half) are the
            // Package 3 deploy-lint legs. They share ONE gate with the VM-side runtime
            // strips (xchain-vm PKG3_SANDBOX_ACTIVATION), keyed per-coin on block HEIGHT
            // (not block-time, so it cannot ride protocolChanges.isEnabled, which has no
            // coin dimension); resolved via the standalone activation module the same
            // shape as dispenser_freshness. Below each coin's height both flags are false,
            // so validateSyntax drops both rules and the historical accepted verdict
            // replays byte-identically. Both threaded exactly like the two flags above.
            let enforcePkg3DeployLint = vmDeployLintPkg3.isVmDeployLintPkg3Active(data['BLOCK_INDEX'], this.config['NETWORK'], this.config['COIN']);
            let enforceBannedGenerator = enforcePkg3DeployLint;
            let enforceBannedWasm = enforcePkg3DeployLint;
            let syntaxResult = this.actions.vm.validateSyntax(code, { enforceBannedAsync, enforceLintHardening, enforceBannedGenerator, enforceBannedWasm });
            if(!syntaxResult.valid)
                error = 'invalid: CODE_ENCODING (' + syntaxResult.error + ')';

            // Non-blocking float warnings (logged in execution record)
            if(!error)
                floatWarnings = this.actions.vm.checkFloatWarnings(code);
        }

        /*****************************************************************
         * Permissions Manifest (Phase E)
         *
         * Read the contract's declared policy deterministically off its (immutable)
         * exports. vm.readManifest instantiates the module top-level with no state,
         * so it works even for constructor-less contracts that vm.execute() never
         * runs. The VM surfaces typed values; ALL validation + fail-closed rejection
         * lives here so the rule is in one place and hashes into the deploy status:
         *   - permissions : array of action-type strings the contract may emit
         *                   (enforced in execute.js processEmission across every
         *                    emission path). Absent = unrestricted (legacy).
         *   - maxTakeBps  : tighter per-contract royalty cap, integer in [0, 10000]
         *                   (enforced in execute.js runControllerGuard). Absent =
         *                    global CONTROLLER_MAX_TAKE_BPS applies.
         * A malformed manifest (wrong type / out of range) REJECTS the deploy rather
         * than silently degrading to unrestricted. A module-level throw during the
         * read is treated as "no manifest" (the contract is broken and will fail at
         * first execute anyway).
         ****************************************************************/
        let declaredPermissions = null;   // string[] | null
        let declaredMaxTakeBps  = null;   // number   | null
        let hasInitialize       = false;  // contract exports a callable constructor (DEPLOY_INIT_STRICT)
        if(!error && this.actions.vm){
            let manifestRead = await this.actions.vm.readManifest(code);
            if(manifestRead && manifestRead.success && manifestRead.manifest){
                let m = manifestRead.manifest;
                hasInitialize = (m.hasInitialize === true);
                if(m.permissionsType !== 'undefined'){
                    if(m.permissionsType !== 'array' || !Array.isArray(m.permissions)){
                        error = 'invalid: CONTRACT_MANIFEST (permissions must be an array)';
                    } else if(!m.permissions.every(p => typeof p === 'string')){
                        error = 'invalid: CONTRACT_MANIFEST (permissions must be action-type strings)';
                    } else {
                        declaredPermissions = m.permissions;
                    }
                }
                if(!error && m.maxTakeBpsType !== 'undefined'){
                    let mtb = m.maxTakeBps;
                    if(m.maxTakeBpsType !== 'number' || !Number.isInteger(mtb) || mtb < 0 || mtb > 10000){
                        error = 'invalid: CONTRACT_MANIFEST (maxTakeBps must be an integer in [0, 10000])';
                    } else {
                        declaredMaxTakeBps = mtb;
                    }
                }
            }
        }

        /*****************************************************************
         * Gas Fee Calculation
         ****************************************************************/

        let schedule = this.config['GAS_SCHEDULE'];
        let codeBytes = Buffer.byteLength(code, 'utf8');
        // Chunked (v2/v3) deploys charge base + constructor only: each v4 carrier already
        // paid the per-byte component for the bytes it put on-chain, so the assembly does
        // not re-charge per byte (net ≈ a single-shot inline deploy of the same source).
        let gasCost = schedule.VM_DEPLOY_BASE + (isChunked ? 0 : (codeBytes * schedule.VM_DEPLOY_PER_BYTE));
        let fee = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);

        // Get source address balances
        let gas = this.config['GAS'];
        let tokenInfo = await this.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Validate gas fee payment (native coin or XCHAIN balance)
        let feePaymentMode = 2; // default: xchain balance
        if(!error && tokenInfo && this.util.bcgt(fee, 0)){
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

        // Adjust balances to reduce by gas fee (only for XCHAIN deduction mode)
        if(!error && tokenInfo && feePaymentMode === 2)
            balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], fee);

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Generate code hash
        let codeHash = crypto.createHash('sha256').update(code).digest('hex');

        /*****************************************************************
         * Contract Derived Address
         ****************************************************************/

        // Create the contract's derived address (C:<CHAIN>:<action_index>)
        let contractAddress = 'C:' + this.config['CHAIN'] + ':' + data['ACTION_INDEX'];
        if(!error)
            await this.indexerDb.createAddress(contractAddress);

        /*****************************************************************
         * Constructor Execution
         ****************************************************************/

        let totalGas = gasCost;
        let constructorError = null;
        let constructorResult = null;

        // When does the constructor run? Below DEPLOY_INIT_STRICT: only when
        // CONSTRUCTOR_PARAMS is non-empty (legacy truthy), so a contract exporting
        // `initialize` deployed with no params silently never initialised (the F-14
        // footgun) yet still committed 'valid'. At/after the flag-day (Option C): run
        // `initialize` whenever the contract exports it, regardless of params. This
        // makes the constructor impossible to silently skip - a zero-arg initialize
        // runs with no args, and an arg-expecting one deployed with none throws inside
        // execute() and REJECTS the deploy (constructorResult.success handling below)
        // instead of committing an uninitialised contract. Gate on the LOCAL block time
        // (mainnet 2026-10-01 cohort); below it the trigger is byte-identical to today.
        let initStrict = await this.actions.protocolChanges.isEnabled('DEPLOY_INIT_STRICT', data['BLOCK_INDEX']);
        let runConstructor = initStrict ? (hasInitialize || !!data['CONSTRUCTOR_PARAMS']) : !!data['CONSTRUCTOR_PARAMS'];

        if(!error && runConstructor && this.actions.vm){
            // Derive deterministic block hash
            let blockHash = crypto.createHash('sha256')
                .update(String(data['BLOCK_INDEX']) + ':' + String(data['BLOCK_TIME']))
                .digest('hex');

            // SOURCE balances back getBalance() in the constructor (e.g. a deploy-time
            // permission gate). The contract's own derived address is freshly created
            // here, so its balance is empty; getBalance(contractAddress, ...) is null.
            // Gated on the VM_BALANCE_TOKENINFO flag-day: below activation the gateway
            // sees balances:null / tokenInfo:null (original ≤2.7.10 behaviour).
            let vmLedger = { balances: null, tokenInfo: null };
            if(await this.actions.protocolChanges.isEnabled('VM_BALANCE_TOKENINFO', data['BLOCK_INDEX'])){
                vmLedger = await this.indexerDb.buildVmBalancesAndTokenInfo(
                    [data['SOURCE'], contractAddress], data['BLOCK_INDEX'], data['ACTION_INDEX']
                );
            }

            constructorResult = await this.actions.vm.execute({
                code:             code,
                state:            {},
                method:           'initialize',
                // Empty CONSTRUCTOR_PARAMS => zero args ([]), not ['']. ''.split('|')
                // would pass a single empty-string arg; under DEPLOY_INIT_STRICT a
                // params-less constructor must receive no args.
                params:           data['CONSTRUCTOR_PARAMS'] ? data['CONSTRUCTOR_PARAMS'].split('|') : [],
                caller:           data['SOURCE'],
                contractAddress:  contractAddress,
                contractIndex:    data['ACTION_INDEX'],
                // The tx hash + root action index + empty call-path anchor the
                // deterministic attestation request_id:
                //   sha256(txHash:rootActionIndex:callPath:contractIndex:emissionIndex)
                // A constructor is a root execution, so its call-path is ''
                // (same as a top-level user EXECUTE).
                txHash:           data['TX_HASH'],
                actionIndex:      data['ACTION_INDEX'],
                callPath:         '',
                rootActionIndex:  data['TX_VOUT'] != null ? data['TX_VOUT'] : 0,   // root discriminator = the DEPLOY's on-chain output index (VM opt name)
                // A constructor is a root execution: emitted cross-contract calls
                // run at depth 1, same as calls emitted by a user EXECUTE.
                callDepth:        0,
                // Explicit top-level ceiling (VM-EMIT-2): a constructor is a root
                // execution, so it runs under the same GAS_CEILING as a top-level
                // EXECUTE. Passing it explicitly (instead of relying on the VM's
                // constructor-time default) keeps the ceiling the clamp below
                // assumes (constructorGas = GAS_CEILING on resource termination)
                // bound to the ceiling the VM actually enforced.
                gasCeiling:       GAS_CEILING,
                blockContext: {
                    height:    data['BLOCK_INDEX'],
                    timestamp: data['BLOCK_TIME'],
                    hash:      blockHash
                },
                balances:         vmLedger.balances,
                tokenInfo:        vmLedger.tokenInfo,
                network:          this.config['NETWORK'],
                oracleData:       await ((this.actions && this.actions.hubDb) || this.indexerDb).getOracleDataForVM(data['BLOCK_INDEX'], data['BLOCK_TIME'], parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800),
                crossChainData:   await this.indexerDb.getCrossChainDataForVM(data['BLOCK_INDEX']),
                // : expose each poll's electorate TICK in the VM snapshot at/after the flag-day.
                pollData:         await this.indexerDb.getPollResultsForVM(data['BLOCK_INDEX'], await this.actions.protocolChanges.isEnabled('VOTE_POLL_TICK_VISIBLE', data['BLOCK_INDEX'])),
                providerDeadlines: PROVIDER_DEADLINE_WINDOWS
            });

            // Defense-in-depth (consensus): mirror the gasUsed clamp in actions/execute.js so a
            // resource termination in the constructor can never cause totalGas (hashed via
            // contract_executions.gas_used into contract_hash) to diverge across validators. The
            // VM already clamps these; this guards a VM regression. Keep the family regex
            // identical to util.vmFailureStatus and execute.js (out_of_gas included so the
            // regexes never drift; it is a no-op for the fee since out_of_gas == ceiling already).
            let constructorGas = constructorResult.gasUsed;
            if(!constructorResult.success && /^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(String(constructorResult.error)))
                constructorGas = GAS_CEILING;
            totalGas += constructorGas;

            if(!constructorResult.success){
                constructorError = 'constructor failed: ' + constructorResult.error;
                error = 'invalid: ' + constructorError;
            }
        }

        // Recalculate fee based on total gas (deploy + constructor)
        fee = this.util.bcmul(totalGas, this.config['GAS_PRICE'], 8);

        // Determine final status. This is consensus-hashed (contracts.status_id /
        // contract_executions.status_id into contract_hash), so it MUST be deterministic. A
        // failed constructor's raw VM error is timing-/memory-/arch-dependent (V8 abort vs
        // isolate wall-clock vs parent watchdog; see util.vmFailureStatus), so normalize it to
        // a stable token instead of storing the raw 'invalid: constructor failed: <vm error>'
        // string. Pre-VM rejections keep their deterministic 'invalid: ...' message; a clean
        // deploy is 'valid'. The raw detail is preserved (un-hashed) in
        // contract_executions.ERROR_MESSAGE below.
        let status;
        if(constructorResult && !constructorResult.success)
            status = this.util.vmFailureStatus(constructorResult.error);
        else if(error)
            status = error;
        else
            status = 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t DEPLOY : hash=" + codeHash + ' : gas=' + totalGas +
            (floatWarnings.length > 0 ? ' : FLOAT_WARNINGS=' + floatWarnings.length : '') +
            ' : ' + data['STATUS']);

        // Create record in contracts table
        await this.indexerDb.createContract({
            ACTION_INDEX      : data['ACTION_INDEX'],
            SOURCE            : data['SOURCE'],
            CODE              : code,
            CODE_HASH         : codeHash,
            API_VERSION       : 1,
            STATUS            : status,
            BLOCK_INDEX       : data['BLOCK_INDEX'],
            COOLDOWN_BLOCKS   : data['COOLDOWN_BLOCKS'],
            SLASH_DESTINATION : data['SLASH_DESTINATION']
        });

        // If constructor failed, delete the contract record
        if(constructorError)
            await this.indexerDb.deleteContract(data['ACTION_INDEX']);

        // Persist the declared permissions manifest (Phase E) BEFORE the constructor
        // emissions are processed below, so a constructor's own emissions are checked
        // against the contract's allowlist too (enforced in execute.js processEmission,
        // which reads this row). Gated on a clean status: a later constructor-state
        // failure calls deleteContract, which also clears this row, keeping the manifest
        // table consistent with `contracts`. Written only when something was declared.
        if(status === 'valid' && (declaredPermissions !== null || declaredMaxTakeBps !== null)){
            await this.indexerDb.createContractPermission({
                ACTION_INDEX   : data['ACTION_INDEX'],
                CONTRACT_INDEX : data['ACTION_INDEX'], // contract_index = its own action_index
                PERMISSIONS    : declaredPermissions,
                MAX_TAKE_BPS   : declaredMaxTakeBps,
                BLOCK_INDEX    : data['BLOCK_INDEX']
            });
        }

        // Process constructor state changes and emissions if successful.
        // Emissions route through the SAME pipeline as EXECUTE emissions
        // (Execute.processEmission): real action rows, contract-derived SOURCE,
        // cross-contract EXECUTE support with depth/gasLimit threading. The
        // savepoint name is unique per deployment because an emitted EXECUTE
        // nests its own vm_execute_<idx> savepoints inside this one (MariaDB
        // destroys a re-used savepoint name; see actions/execute.js).
        let nestedGasUnused = 0;
        if(constructorResult && constructorResult.success){
            let savepoint = await this.indexerDb.createSavepoint('vm_constructor_' + parseInt(data['ACTION_INDEX']));
            try {
                for(let change of constructorResult.stateChanges){
                    await this.indexerDb.createContractState({
                        CONTRACT_INDEX: data['ACTION_INDEX'],
                        STATE_KEY:      change.key,
                        STATE_VALUE:    JSON.stringify(change.value),
                        BLOCK_INDEX:    data['BLOCK_INDEX'],
                        ACTION_INDEX:   data['ACTION_INDEX']
                    });
                }
                for(let key of constructorResult.stateDeletes){
                    await this.indexerDb.createContractState({
                        CONTRACT_INDEX: data['ACTION_INDEX'],
                        STATE_KEY:      key,
                        STATE_VALUE:    null,
                        BLOCK_INDEX:    data['BLOCK_INDEX'],
                        ACTION_INDEX:   data['ACTION_INDEX']
                    });
                }

                // Constructor emissions. executionData mirrors what an EXECUTE
                // would carry: the new contract is the emitter, the DEPLOY's own
                // action_index is the executing action (parent for CALL_DEPTH), and the
                // deployer pays fees. A constructor is a root execution, so its call-path
                // is '' (emitted ATTEST request_ids derive over
                // (txHash:rootActionIndex:callPath:contractIndex:emissionIndex) with
                // callPath '', matching the VM's constructor run at callPath '').
                let emissionContext = {
                    CONTRACT_ACTION_INDEX: data['ACTION_INDEX'],
                    ACTION_INDEX:          data['ACTION_INDEX'],
                    ROOT_ACTION_INDEX:     data['TX_VOUT'] != null ? data['TX_VOUT'] : 0,   // root discriminator for constructor emissions (key attest.js/xcall.js read)
                    SOURCE:                data['SOURCE'],
                    BLOCK_INDEX:           data['BLOCK_INDEX'],
                    BLOCK_TIME:            data['BLOCK_TIME'],
                    TX_INDEX:              data['TX_INDEX'],
                    TX_HASH:               data['TX_HASH'],
                    TX_VOUT:               data['TX_VOUT'],
                    CALL_PATH:             '',
                    CALL_DEPTH:            0,
                    IS_CONSTRUCTOR:        true   // cross-chain calls are disallowed from constructors (v1)
                };
                for(let i = 0; i < constructorResult.emittedActions.length; i++){
                    let emission = constructorResult.emittedActions[i];

                    if(emission.action === 'SLASH'){
                        // Inline like execute.js (never on-wire). A just-deployed
                        // contract has no stakes, so this is a structural no-op,
                        // kept for pipeline parity.
                        await this.actions.actionExecute._processSlashEmission(emission, emissionContext);
                    } else {
                        await this.actions.actionExecute.processEmission(emission, emissionContext, i);
                        // Bank a cross-contract callee's unused reservation for
                        // the fee settlement below.
                        if(emission.action === 'EXECUTE')
                            nestedGasUnused += Number(emission.gasUnusedSubtree) || 0;
                    }

                    await this.indexerDb.createContractEmission({
                        EXECUTION_INDEX: data['ACTION_INDEX'],
                        EMITTED_ACTION:  emission.action,
                        ACTION_INDEX:    emission.resultActionIndex || null,
                        POSITION:        i
                    });
                }

                await this.indexerDb.releaseSavepoint(savepoint);
            } catch(e){
                await this.indexerDb.rollbackToSavepoint(savepoint);
                // An infrastructure fault (VM host fault, transient DB error) is not a
                // constructor outcome: halt so the block rolls back and retries rather than
                // deleting the contract and committing a validator-local 'invalid' deploy.
                rethrowIfInfraFault(e);
                // Constructor state/emission processing failed. The whole deployment
                // fails (no refunds; the deployer pays full gas).
                nestedGasUnused = 0;
                error = 'invalid: constructor state write failed: ' + e.message;
                status = error;
                data['STATUS'] = status;
                await this.indexerDb.deleteContract(data['ACTION_INDEX']);
            }
        }

        // Refund unused cross-contract reservations from constructor emissions
        // (mirrors actions/execute.js gas settlement; no-op when no emit.execute).
        if(nestedGasUnused > 0){
            totalGas = Math.max(0, totalGas - nestedGasUnused);
            fee = this.util.bcmul(totalGas, this.config['GAS_PRICE'], 8);
        }

        // Create execution record
        await this.indexerDb.createContractExecution({
            ACTION_INDEX    : data['ACTION_INDEX'],
            CONTRACT_INDEX  : data['ACTION_INDEX'], // contract_index = its own action_index
            CALLER          : data['SOURCE'],
            METHOD_NAME     : 'constructor',
            INPUT_PARAMS    : data['CONSTRUCTOR_PARAMS'] || '',
            GAS_USED        : totalGas,
            GAS_LIMIT       : data['GAS_LIMIT'] || totalGas,
            STATUS          : status,
            ERROR_MESSAGE   : error || null,
            EMITTED_COUNT   : constructorResult ? constructorResult.emittedActions.length : 0,
            BLOCK_INDEX     : data['BLOCK_INDEX']
        });

        // Store the SOURCE and GAS tick in addresses list
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Debit gas fee from SOURCE. Mirror the in-memory balance debit above
        // EXACTLY (!error && feePaymentMode === 2). Recording a ledger debit for a
        // rejected deploy (e.g. one rejected for insufficient GAS funds) burns gas
        // the source never had: the ledger supply drops but getAddressBalances only
        // iterates credit ticks, so the debit-only tick is invisible to the balances
        // projection, leaving balance = ledger + 1 and tripping the supply SanityError.
        if(!error && tokenInfo && feePaymentMode === 2)
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
}

module.exports = Deploy;
// Expose the canonical caps so the cross-service regression suite can assert they
// have not drifted from the protocol constants.
module.exports.MAX_CODE_SIZE = MAX_CODE_SIZE;
module.exports.MAX_DEPLOY_CHUNKS = MAX_DEPLOY_CHUNKS;
