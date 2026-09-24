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
 * XChain Platform Action - ISSUE
 * 
 * This action creates or updates a `TICK`
 * 
 * PARAMS:
 * - VERSION          - Format Version
 * - TICK             - Ticker name or Ticker ID
 * - MAX_SUPPLY       - Maximum token supply 
 * - MAX_MINT         - Maximum amount of supply a `MINT` transaction can issue
 * - DECIMALS         - Number of decimal places token should have (max: 18, default: 0)
 * - DESCRIPTION      - Description of token (max 249 chars)
 * - MINT_SUPPLY      - Amount of token supply to mint in immediately (default:0)
 * - TRANSFER         - Address to transfer ownership of the `token` to (owner can perform future actions on token)
 * - TRANSFER_SUPPLY  - Address to transfer `MINT_SUPPLY` to (mint initial supply and transfer to address)
 * - LOCK_MAX_SUPPLY  - Lock `MAX_SUPPLY` permanently (cannot increase `MAX_SUPPLY`)
 * - LOCK_MINT        - Lock `token` against `MINT` command
 * - LOCK_MAX_MINT    - Lock `MAX_MINT` permanently (cannot edit `MAX_MINT`)
 * - LOCK_DESCRIPTION - Lock `token` against `DESCRIPTION` changes
 * - LOCK_SLEEP       - Lock `token` against `SLEEP` command
 * - LOCK_CALLBACK    - Lock `token` `CALLBACK` info
 * - CALLBACK_BLOCK   - Enable `CALLBACK` command after `CALLBACK_BLOCK` 
 * - CALLBACK_TICK    - `TICK` `token` users get when `CALLBACK` command is used
 * - CALLBACK_AMOUNT  - `TICK` `token` amount that users get when `CALLBACK` command is used
 * - ALLOW_LIST       - `ACTION_INDEX` of a LIST of addresses allowed to interact with this token
 * - BLOCK_LIST       - `ACTION_INDEX` of a LIST of addresses NOT allowed to interact with this token
 * - MINT_ADDRESS_MAX - Maximum amount of supply any address can mint via `MINT` transactions
 * - MINT_START_BLOCK - `BLOCK_INDEX` when `MINT` transactions are allowed (begin mint)
 * - MINT_STOP_BLOCK` - `BLOCK_INDEX` when `MINT` transactions are NOT allowed (end mint)
 * - CONTROLLER       - (format 6 only) `ACTION_INDEX` of a deployed contract whose `guard`
 *                      method gates one ACTION_CLASS of this token (programmable policy layer)
 * - ACTION_CLASS     - (format 6 only) which class to gate, validated against config
 *                      CONTROLLER_BINDABLE_CLASSES:
 *                      transfer|trade|burn|mint|stake|ownership|all
 *                      ('all' is the catch-all: bindable, never routable, gates every class)
 * - COOLDOWN_BLOCKS  - (format 6 only) drop-cooldown committed at bind; the friction on a later unbind
 * - UNBIND           - (format 6 only) 1 = drop the live binding for ACTION_CLASS
 * - BRIDGE_CHAINS    - (format 7 only) comma list of destination coins this token may be
 *                      locked to (`XBRIDGE` v3), or the sentinel `-` for none. Empty means
 *                      unchanged, like every other ISSUE field.
 * - MIN_DEPTH        - (format 7 only) confirmation depth the federation must honour for
 *                      this token's locks; the effective depth is
 *                      max(platform default, MIN_DEPTH), so it is raise-only
 * - LOCK_BRIDGE      - (format 7 only) 1 = freeze BRIDGE_CHAINS and MIN_DEPTH forever
 *
 * FORMATS :
 * - 0 = Full
 * - 1 = Brief
 * - 2 = Edit MINT PARAMS
 * - 3 = Edit LOCK PARAMS
 * - 4 = Edit CALLBACK PARAMS
 * - 5 = Edit LIST PARAMS
 * - 6 = Bind/unbind a controller (programmable policy layer)
 * - 7 = Edit BRIDGE PARAMS (the issuer's token-bridge opt-in, TOKEN_BRIDGE_ACTIVATION)
 *
 ********************************************************************/

// WHERE THE PARTS LIVE. This file is the entry and the dispatch, and keeps the handler's
// own methods (the top-level test and the three ticker-intern wrappers). parse() walks
// the parts below in the order the rules have always run, handing each one context
// object and `this` (the handler), so every read and every verdict keeps its position:
// read order is consensus, because getTokenInfo interns and ticker ids feed the hash.
//   ./wire.js               flag days, FORMAT gate, PARAMS, ^<id> refs, storage clone
//   ./fees.js               balances, preferences, fee object; issuance fee and payment
//   ./tick_rules.js         TICK shape, parent, characters, length, reserved, GAS tick
//   ./issuance_limits.js    tick-namespace floor and reserved roots; top-level budget
//   ./token_state.js        token row merge, field formats, owner, escrow, lock-once
//   ./supply_rules.js       MAX_SUPPLY, DECIMALS, TRANSFER fields, MINT_SUPPLY caps
//   ./edit_rules.js         locked edits, CALLBACK fields, lists, mint window, MEMO
//   ./controller_binding.js format-6 CONTROLLER checks and the binding event
//   ./bridge_opt_in.js      format-7 opt-in and the policy exclusion
//   ./settle.js             issues row, and the valid path's token record and ledger
const wire              = require('./wire.js');
const fees              = require('./fees.js');
const tickRules         = require('./tick_rules.js');
const issuanceLimits    = require('./issuance_limits.js');
const tokenState        = require('./token_state.js');
const supplyRules       = require('./supply_rules.js');
const editRules         = require('./edit_rules.js');
const controllerBinding = require('./controller_binding.js');
const bridgeOptIn       = require('./bridge_opt_in.js');
const settle            = require('./settle.js');

class Issue {

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
        this.formats[0] = 'VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO';
        this.formats[1] = 'VERSION|TICK|DESCRIPTION|MEMO';
        this.formats[2] = 'VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|MEMO';
        this.formats[3] = 'VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO';
        this.formats[4] = 'VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|MEMO';
        this.formats[5] = 'VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO';
        // Programmable policy layer: bind/unbind a guard contract to one action-class of this token
        // (append-only token_controllers model). One binding change per action; UNBIND=1 drops the
        // live binding for ACTION_CLASS (CONTROLLER then ignored). COOLDOWN_BLOCKS is committed at
        // bind time and is the friction on a later drop. See
        // xchain-documentation/protocol/controller-bound-tokens.md.
        this.formats[6] = 'VERSION|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO';
        // Token bridge: the issuer's opt-in, owner-only and free (the issuance fee is
        // first-issuance only). Admitted ONLY at/above TOKEN_BRIDGE_ACTIVATION - below it
        // the version check below keeps the historical 'invalid: VERSION (unknown)', so no
        // ISSUE already on any chain changes status on replay.
        this.formats[7] = 'VERSION|TICK|BRIDGE_CHAINS|MIN_DEPTH|LOCK_BRIDGE|MEMO';

        // Top-level (undotted) issuances allowed per TRANSACTION under
        // EMISSION_ISSUANCE_LIMITS. Deliberately the SAME number as batch.js's
        // actionLimits['ISSUE'], and deliberately a separate constant rather than a reach
        // into that handler: this budget is counted over a different population (every
        // ISSUE that reaches this handler, wire or VM-emitted) at a different moment (parse
        // time, not the pre-dispatch scan), so the two rules only happen to agree on the
        // value. Moving one must be a decision about the other, not a side effect of it.
        this.topLevelIssuanceLimit = 1;

        // Define lists of various fields
        this.fieldList = {};

        // Define list of AMOUNT, LOCK fields (used in validations)
        this.fieldList['AMOUNT'] = ['MAX_SUPPLY', 'MAX_MINT', 'MINT_SUPPLY', 'CALLBACK_AMOUNT', 'MINT_ADDRESS_MAX', 'MINT_START_BLOCK', 'MINT_STOP_BLOCK'];
        // LOCK_BRIDGE joins the list so format 7 inherits the whole lock discipline for
        // free: the 0/1 value check, and isValidLock's cannot-unset rule once set. Only
        // format 7 can carry it, so the two loops below are a no-op for every other format
        // and no historical verdict moves.
        this.fieldList['LOCK']   = ['LOCK_MAX_SUPPLY', 'LOCK_MINT', 'LOCK_MINT_SUPPLY', 'LOCK_MAX_MINT', 'LOCK_DESCRIPTION', 'LOCK_SLEEP', 'LOCK_CALLBACK', 'LOCK_BRIDGE'];
    }

    // Does this TICK consume a TOP-LEVEL issuance slot (EMISSION_ISSUANCE_LIMITS)?
    //
    // The rule is batch.js's classifyLimitAction, restated over the parsed TICK instead of a
    // raw sub-command string, and it must keep answering the same way for the same tick or
    // the two limits disagree about what a namespace registration is:
    //   - a DOTTED tick (JDOG.1) is a CHILD of a name its issuer already owns and is exempt,
    //     which is what keeps bulk child issuance working;
    //   - a CARET tick (^12) is NEVER exempt even when it contains a dot: the caret form is an
    //     id reference whose dot is a decimal, not a namespace separator.
    // Anything else, including a malformed or missing tick, counts as top-level: exemption is
    // granted on positive evidence only.
    isTopLevelIssuance(tick){
        let str = String(tick === undefined || tick === null ? '' : tick);
        if(str.charAt(0) == '^')
            return true;
        return !str.includes('.');
    }

    // BATCH_ISSUANCE_LIMITS: the intern-gating wrapper for the TICK and
    // CALLBACK_TICK lookups (the parent lookup has its own wrapper below, for a reason
    // spelled out there).
    // getTokenInfo interns any unseen name into index_tickers via createTicker BEFORE this
    // action's validity is known. Once `error` is already set the ISSUE cannot land valid
    // no matter what tokenInfo comes back, so minting a fresh dense ticker id for it is
    // pure waste an attacker can spend for free - batch.js's dotted-child exemption lets one
    // BATCH repeat this up to ~250 times (one per child TICK string).
    //
    // indexerDb.suppressIndexIdCreation is the existing resolve-only lever (see the db.js
    // constructor and rollback.js's refresh phase): true makes createTicker resolve an
    // EXISTING tick normally but never INSERT an unseen one. Because a not-yet-interned
    // tick returns no token-info row either way (interned-with-no-token-row vs
    // not-interned both read back as "unknown"), the RESULT handed back to the caller is
    // unchanged - only the permanent index_tickers side effect is skipped. Restored via
    // `finally` (to the PRIOR value, not a hardcoded false, in case of nesting) so a throw
    // never leaks suppression into the next getTokenInfo call or the next action.
    //
    // Gated behind BATCH_ISSUANCE_LIMITS as a tightening: below the flag, or while
    // `error` is still unset, this is a transparent passthrough - byte-identical to the
    // unwrapped call, including every historical intern an already-invalid ISSUE caused.
    async gatedGetTokenInfo(tick, blockIndex, actionIndex, error, gateActive){
        if(!error || !gateActive)
            return await this.indexerDb.getTokenInfo(tick, blockIndex, actionIndex);
        return await this.resolveOnlyGetTokenInfo(tick, blockIndex, actionIndex);
    }

    // The PARENT lookup's own wrapper, and it suppresses on the gate ALONE rather than on
    // `error`: an ISSUE of "FOO.1" with no FOO in existence is correctly rejected
    // `invalid: TICK (parent unknown)` but would still leave "FOO" interned as a fresh
    // ticker id without this suppression.
    //
    // The reason gatedGetTokenInfo cannot cover this call site: the parent lookup is the
    // FIRST thing in the TICK block that can produce an error, so `error` is necessarily
    // still unset when it runs and the error-conditioned wrapper is a guaranteed
    // passthrough there. The suppression condition has to be structural instead, and it is
    // available: a parent that EXISTS is already interned (a token row is keyed by its
    // tick_id), so a parent this lookup would have to INSERT is by definition one that does
    // not exist, i.e. one whose ISSUE is about to be rejected. Interning it is therefore
    // always waste - and unlike the TICK and CALLBACK_TICK names, the parent name is not
    // stored on the row either (createIssue interns only those two), so nothing downstream
    // needs it. `isOwnershipEscrowed(parent)` runs only when parentInfo came back truthy,
    // which means the name resolved.
    //
    // What this does NOT claim to fix, deliberately: the ATTEMPTED TICK of a rejected ISSUE
    // is still interned, because db.js's createIssue calls createTicker to store the
    // rejected row at all. That is the platform-wide storage convention for every action
    // type, not an ISSUE defect, and changing it is a db.js/schema question outside this
    // rule's scope (spec row 6 is explicitly issue.js-only).
    //
    // Gated behind BATCH_ISSUANCE_LIMITS: skipping an insert shifts every later ticker id,
    // so below the flag this stays a transparent passthrough and a from-genesis replay
    // reproduces the historical ids byte-for-byte.
    async parentGetTokenInfo(tick, blockIndex, actionIndex, gateActive){
        if(!gateActive)
            return await this.indexerDb.getTokenInfo(tick, blockIndex, actionIndex);
        return await this.resolveOnlyGetTokenInfo(tick, blockIndex, actionIndex);
    }

    // The suppression mechanics the two wrappers above share.
    async resolveOnlyGetTokenInfo(tick, blockIndex, actionIndex){
        let prior = this.indexerDb.suppressIndexIdCreation;
        this.indexerDb.suppressIndexIdCreation = true;
        try {
            return await this.indexerDb.getTokenInfo(tick, blockIndex, actionIndex);
        } finally {
            this.indexerDb.suppressIndexIdCreation = prior;
        }
    }

    // Handle parsing the ISSUE transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // let str    = "0|JDOG|1000||18";
        // params = String(str).split('|');
        // data['SOURCE'] = this.config['ADDRESS']['BURN'];
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Wire parse, then the balances, preferences and fee object every rule below sees
        let ctx = await wire.parseWire.call(this, params, data, error);
        await wire.resolveRefsAndClone.call(this, ctx);
        await fees.loadFeeContext.call(this, ctx);

        // TICK Validations, then the limits on NEW names
        await tickRules.validateTickName.call(this, ctx);
        tickRules.validateTickForm.call(this, ctx);
        tickRules.validateReservedTick.call(this, ctx);
        tickRules.validateGasTick.call(this, ctx);
        await issuanceLimits.validateTickNamespace.call(this, ctx);
        await issuanceLimits.countTopLevelIssuance.call(this, ctx);

        // The existing token row, then the FORMAT and General validations against it
        await tokenState.loadTokenState.call(this, ctx);
        tokenState.validateFieldFormats.call(this, ctx);
        await tokenState.validateOwnership.call(this, ctx);
        await supplyRules.validateSupplyFields.call(this, ctx);
        supplyRules.validateTransferFields.call(this, ctx);
        await supplyRules.validateMintSupplyCaps.call(this, ctx);
        editRules.validateLockedEdits.call(this, ctx);
        await editRules.validateCallbackAndListFields.call(this, ctx);
        await controllerBinding.validateControllerContract.call(this, ctx);
        await controllerBinding.validateControllerBinding.call(this, ctx);
        await bridgeOptIn.validateBridgeRules.call(this, ctx);
        await editRules.validateMintWindowAndMemo.call(this, ctx);

        // The issuance fee, once every rule has passed, and whether it can be paid
        await fees.priceIssuance.call(this, ctx);
        await fees.validateFeePayment.call(this, ctx);

        // Record the issue, and create the token record only when it is valid
        let status = await settle.recordIssue.call(this, ctx);
        if(status=='valid')
            await settle.settleValidIssue.call(this, ctx);

        // Create action mappings
        await this.mapper.createMappings(ctx.data);

    }
}

module.exports = Issue;