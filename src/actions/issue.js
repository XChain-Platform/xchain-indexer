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
 *
 * FORMATS :
 * - 0 = Full
 * - 1 = Brief
 * - 2 = Edit MINT PARAMS
 * - 3 = Edit LOCK PARAMS
 * - 4 = Edit CALLBACK PARAMS
 * - 5 = Edit LIST PARAMS
 * - 6 = Bind/unbind a controller (programmable policy layer)
 *
 ********************************************************************/

class Issue {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

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
        // bind time and is the friction on a later drop. See Controller_Bound_Tokens.md.
        this.formats[6] = 'VERSION|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO';

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
        this.fieldList['LOCK']   = ['LOCK_MAX_SUPPLY', 'LOCK_MINT', 'LOCK_MINT_SUPPLY', 'LOCK_MAX_MINT', 'LOCK_DESCRIPTION', 'LOCK_SLEEP', 'LOCK_CALLBACK'];
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

    // BATCH_ISSUANCE_LIMITS, R6/F11: the intern-gating wrapper for the TICK and
    // CALLBACK_TICK lookups (the parent lookup has its own wrapper below, for a reason
    // spelled out there).
    // getTokenInfo interns any unseen name into index_tickers via createTicker BEFORE this
    // action's validity is known. Once `error` is already set the ISSUE cannot land valid
    // no matter what tokenInfo comes back, so minting a fresh dense ticker id for it is
    // pure waste an attacker can spend for free - R1's dotted-child exemption lets one
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

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Resolve compacted ^<id> TRANSFER / TRANSFER_SUPPLY references back to their
        // canonical addresses before the clone-for-storage and validation below, so the
        // SDK's default ^<id> wire form validates and is stored/credited identically to
        // the full address. At/after the address-ref resolution flag-day an unresolvable
        // reference is a hard reject here; below it the value is left as-is and rejected
        // by the isCryptoAddress checks (which the IS_GENESIS path skips, so those two
        // fields had no rejection at all on that path). See resolveAddressRefChecked.
        if(!error){
            let transferRef = await this.indexerDb.resolveAddressRefChecked(data['TRANSFER'], data['BLOCK_INDEX']);
            data['TRANSFER'] = transferRef.value;
            let supplyRef = await this.indexerDb.resolveAddressRefChecked(data['TRANSFER_SUPPLY'], data['BLOCK_INDEX']);
            data['TRANSFER_SUPPLY'] = supplyRef.value;
            if(transferRef.rejected)
                error = 'invalid: TRANSFER (unresolvable ^id)';
            else if(supplyRef.rejected)
                error = 'invalid: TRANSFER_SUPPLY (unresolvable ^id)';
        }

        let issue = Object.assign({}, data);

        if(!error)
            data = this.util.setNumberFormats(data);

        // Build out arrays of allowed characters and tick characters
        let allowedCharacters = String(this.config['TICK_CHARACTERS']).split('');
        let tickCharacters    = String(data['TICK']).split('');

        // Get source address balances and preferences. At genesis the SOURCE is always GAS,
        // which holds no balances and has set no preferences, so these resolve to the exact
        // empty/default result the queries would return; substituting them skips the
        // table-scanning reads on the ~240k-action genesis block. `balances` is only consumed
        // under a non-zero fee (genesis is fee-exempt, so it stays untouched), and the default
        // preferences object is the literal initializer of getAddressPreferences. Byte-identity
        // of the genesis ledger is asserted by scenario 22's reindex-determinism check.
        let balances    = data['IS_GENESIS']
            ? {}
            : await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = data['IS_GENESIS']
            ? { FEE_PREFERENCE: 2, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 1 }
            : await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // BATCH_ISSUANCE_LIMITS: governs both the caret-dot TICK rejection below (R6) and
        // the ticker-intern gating on every getTokenInfo call in this action (R6/F11 -
        // see gatedGetTokenInfo). Computed once, early, so every consumer below sees the
        // same activation state for this action's BLOCK_INDEX.
        // Both are consensus tightenings: below the flag every historical verdict
        // (including the two defects it closes) must replay identically from genesis.
        let batchIssuanceLimitsV2 = await this.actions.protocolChanges.isEnabled('BATCH_ISSUANCE_LIMITS', data['BLOCK_INDEX']);

        // TICK Validations

        // Verify TICK is not null/empty
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (null)';

        // Verify TICK does not begin or end with period (.)
        let str = String(data['TICK']);
        if(!error && (str.substring(0,1)=='.' || str.slice(-1)=='.'))
            error = 'invalid: TICK (period)';

        // Determine if this is a parent/child issuance using full TICK name
        let parts      = String(data['TICK']).split('.');
        let parent     = false;
        let parentInfo = false;
        if(parts.length>1){
            parent = parts.slice(0,-1).join('.');

            // Get information on parent TICK
            parentInfo = await this.parentGetTokenInfo(parent, data['BLOCK_INDEX'], data['ACTION_INDEX'], batchIssuanceLimitsV2);

            // Verify parent TICK exists
            if(!error && !parentInfo)
                error = 'invalid: TICK (parent unknown)';

            // Verify ISSUE is coming from PARENT TICK owner
            if(!error && parentInfo && parentInfo['OWNER']!=data['SOURCE'])
                error = 'invalid: TICK (parent issued by another address)';

            // Reject child issuance while the parent's ownership is escrowed in an open offer.
            // Genesis has no escrows (the escrows table is empty during bootstrap), so the
            // check is a guaranteed false; skip the read.
            if(!error && parentInfo && !data['IS_GENESIS'] && await this.indexerDb.isOwnershipEscrowed(parent))
                error = 'invalid: TICK (parent ownership escrowed)';
        }

        // Verify TICK contains only allowed characters
        for(let char of tickCharacters){
            if(!error && !allowedCharacters.includes(char))
                error = 'invalid: TICK (character)';
        }

        // Verify any TICK ID given is valid tick ID
        let tid = str.substring(1); // Possible TICK ID (everything after the ^ prefix)
        if(!error && str.substring(0,1)=='^' && !this.util.isNumeric(tid))
            error = 'invalid: TICK (id)';

        // R6 caret rule (review F4): isNumeric() is parseFloat-based, so a caret
        // tail containing '.' (e.g. "^12.5" or "^1.0") reads as a number and slips past the
        // check above, landing a status=valid ISSUE with a NULL ticker id (createTicker
        // never inserts a literal "^..." row - see db.js createTicker). Because the TICK
        // also contains a '.', it ALSO trips the parent/child split above, so such a tick
        // can masquerade as a child issuance; that is why batch.js's dotted-TICK exemption
        // classifier refuses to exempt ANY caret TICK. This is the paired indexer-side
        // rejection. Gated (tightens validity): below the flag the historical (defective)
        // verdict stands, so a from-genesis replay stays byte-identical.
        if(!error && batchIssuanceLimitsV2 && str.substring(0,1)=='^' && tid.indexOf('.')!=-1)
            error = 'invalid: TICK (caret dot)';

        // Verify TICK length is within acceptable range
        let len = String(data['TICK']).length,
            min = parseInt(this.config['MIN_TICK_LENGTH']),
            max = parseInt(this.config['MAX_TICK_LENGTH']);
        if(!error && (len < min || len > max))
            error = 'invalid: TICK (length)';

        // Verify no pipe in TICK (pipe is field delimiter)
        if(!error && String(data['TICK']).indexOf('|')!=-1)
            error = 'invalid: TICK (pipe)';

        // Verify no semicolon in TICK (semicolon is action delimiter)
        if(!error && String(data['TICK']).indexOf(';')!=-1)
            error = 'invalid: TICK (semicolon)';

        // Verify TICK is not on RESERVED_TICKS list (GAS address can issue GAS token; any address can on regtest)
        if(!error && this.config['RESERVED_TICKS'].indexOf(data['TICK'])!=-1 && !(data['TICK']==this.config['GAS'] && data['SOURCE']==this.config['ADDRESS']['GAS']) && this.config['NETWORK']!='regtest')
            error = 'invalid: TICK (reserved)';

        // Verify only GAS address can issue on GAS token
        if(!error && String(data['TICK']).toUpperCase()==this.config['GAS'] && data['SOURCE']!=this.config['ADDRESS']['GAS'] && this.config['NETWORK']!='regtest')
            error = 'invalid: GAS Address';

        // Verify the GAS token (XCHAIN) is only ever issued on BTC. It is the platform gas
        // token but exists as a real, balance-bearing token only on the BTC ledger; on
        // DOGE/LTC fees settle in native coin (XCHAIN is only a unit of account for sizing),
        // so XCHAIN is never created there. Regtest is exempt so the e2e harness can self-seed
        // play-money gas on any chain.
        if(!error && String(data['TICK']).toUpperCase()==this.config['GAS'] && this.config['COIN']!='BTC' && this.config['NETWORK']!='regtest')
            error = 'invalid: TICK (BTC-only)';

        // Per-TRANSACTION top-level issuance budget (EMISSION_ISSUANCE_LIMITS).
        //
        // THIS is the choke point the rule needs and the pre-dispatch BATCH scan is not: every
        // ISSUE arrives here, whether it came off the wire as a sub-command or was emitted by
        // a contract (execute.js processEmission routes an emission straight to this handler,
        // past that scan), and VM-emitted issuances are fee-exempt under
        // ISSUANCE_FEE_EMISSION_EXEMPT, so before this check one EXECUTE could register up to
        // maxEmissions (50) top-level names for nothing and a 250-command BATCH of EXECUTEs
        // up to 12,450. Operator decision 2026-08-15 (option a): count them.
        //
        // NO WIRE VERDICT MOVES. batch.js caps top-level ISSUE sub-commands at 1 per BATCH
        // (actionLimits['ISSUE'], in force below the BATCH_ISSUANCE_LIMITS flag as well) and a
        // non-BATCH transaction carries exactly one action, so at most ONE wire ISSUE ever
        // reaches this counter and it can only ever consume the first slot.
        //
        // Placed BEFORE the token-info read below so a refused issuance reaches
        // gatedGetTokenInfo with `error` already set and therefore interns no ticker id for a
        // name it never registers - the same free-consumption-of-dense-id-space economy that
        // wrapper exists for. Below it, the read has already happened.
        //
        // Counted on ARRIVAL rather than on success, matching the BATCH scan, which counts
        // sub-commands without regard to their validity. An ISSUE that consumes the slot and
        // then fails a later check has still spent it - deterministically, on every node, so
        // the ledger is a consensus value like any other.
        //
        // GENESIS IS EXEMPT: the bootstrap registers ~240k names from one synthetic source and
        // is not a spam surface (genesis.js is the only caller that can set IS_GENESIS). A
        // missing ledger is likewise inert: any caller that never came through a transaction
        // or an injected-execution context enforces nothing, which is the pre-flag behaviour.
        let issuanceLedger = data['ISSUANCE_LIMIT_LEDGER'];
        if(!error && !data['IS_GENESIS'] && issuanceLedger && this.isTopLevelIssuance(data['TICK']) &&
           await this.actions.protocolChanges.isEnabled('EMISSION_ISSUANCE_LIMITS', data['BLOCK_INDEX'])){
            issuanceLedger.topLevel = (Number(issuanceLedger.topLevel) || 0) + 1;
            if(issuanceLedger.topLevel > this.topLevelIssuanceLimit)
                error = 'invalid: ISSUE (limit)';
        }

        // Get information on token, then check distribution passing tokenInfo to avoid a second getTokenInfo call
        let tokenInfo     = await this.gatedGetTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'], error, batchIssuanceLimitsV2);
        // Genesis creates name ownership only (no balances/holders), so a genesis token is
        // never distributed; isDistributed only feeds CALLBACK edits, which carry null fields
        // at genesis anyway. Skip the holders read.
        let isDistributed = data['IS_GENESIS']
            ? false
            : await this.indexerDb.isDistributed(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'], tokenInfo);

        // Populate empty PARAMS with current setting
        if(tokenInfo){
            for(let key in tokenInfo){
                if(this.util.isNull(data[key]))
                    data[key] = tokenInfo[key];
            }
        }

        // Get information on CALLBACK_TICK
        let cbInfo = false;
        if(data['CALLBACK_TICK'])
            cbInfo = await this.gatedGetTokenInfo(data['CALLBACK_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'], error, batchIssuanceLimitsV2);

        // FORMAT Validations

        // Set decimal precision for TICK and CALLBACK_TICK
        let tick_decimals     = (!this.util.isNull(tokenInfo) && !this.util.isNull(tokenInfo['DECIMALS'])) ? tokenInfo['DECIMALS'] : data['DECIMALS'],
            callback_decimals = (!this.util.isNull(cbInfo) && !this.util.isNull(cbInfo['DECIMALS'])) ? cbInfo['DECIMALS'] : 0;

        // Verify AMOUNT field formats
        for(let name of this.fieldList['AMOUNT']){
            let value    = issue[name],
                decimals = (name=='CALLBACK_AMOUNT') ? callback_decimals : tick_decimals;
            if(!error && !this.util.isNull(value) && !this.util.isValidAmountFormat(decimals, value))
                error = "invalid: " + name + " (format)";
        }

        // Verify LOCK field formats
        for(let name of this.fieldList['LOCK']){
            let value = issue[name];
            if(!error && !this.util.isNull(value) && !this.util.isValidLockValue(value))
                error = "invalid: " + name + " (format)";
        };

        // General Validations

        // Verify SOURCE is not sleeping. GAS is never put to sleep and there are no lists at
        // genesis, so isActionAllowed is always true during bootstrap; skip the read.
        if(!error && !data['IS_GENESIS'] && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify ISSUE is coming from TICK owner
        if(!error && tokenInfo && tokenInfo['OWNER']!=data['SOURCE'])
            error = 'invalid: issued by another address';

        // Reject any ISSUE that edits an existing tick while its ownership is escrowed
        // (covers v1 description edit, v2 mint params, v3 lock params, v4 callback params,
        // v5 list params, and v0 re-issuance from the existing owner). The escrow itself
        // was opened by a successful ORDER/SWAP/DISPENSER from the same SOURCE; only
        // closing the offer (via cancel/expire/match/sweep) releases this lock.
        if(!error && tokenInfo && !data['IS_GENESIS'] && await this.indexerDb.isOwnershipEscrowed(data['TICK']))
            error = 'invalid: TICK (ownership escrowed)';

        // Verify LOCK fields cannot be changed once enabled/locked.
        //
        // Gate: LOCK_NULL_PRIOR_UNSET makes isValidLock read an absent/NULL prior
        // as unset instead of falling through to "locked". getTokenInfo skips NULL columns
        // when it replays the `issues` rows, so a token whose genesis ISSUE omitted the lock
        // fields arrived here with an undefined prior and every later LOCK was refused with
        // "invalid: <FIELD> (locked)" on a flag that had never been locked. Resolved once for
        // the whole field loop against the processing block: the gate must not be able to
        // differ field to field within one action. Below the flag-day the legacy verdict
        // stands, so from-genesis replay stays byte-identical.
        let lockNullPriorUnset = await this.actions.protocolChanges.isEnabled('LOCK_NULL_PRIOR_UNSET', data['BLOCK_INDEX']);
        for(let name of this.fieldList['LOCK']){
            let value = issue[name];
            if(!error && tokenInfo && !this.util.isNull(value) && !this.util.isValidLock(tokenInfo, issue, name, lockNullPriorUnset))
                error = "invalid: " + name + " (locked)";
        }

        // Verify MAX_SUPPLY min/max
        if(!error && !this.util.isNull(data['MAX_SUPPLY']) && this.util.bcgt(data['MAX_SUPPLY'], 0) && (this.util.bclt(data['MAX_SUPPLY'], this.config.MIN_TOKEN_SUPPLY) || this.util.bcgt(data['MAX_SUPPLY'], this.config.MAX_TOKEN_SUPPLY)))
            error = 'invalid: MAX_SUPPLY (min/max)';

        // Verify MAX_SUPPLY is not set below current SUPPLY
        if(!error && !this.util.isNull(data['MAX_SUPPLY']) && this.util.bcgt(data['MAX_SUPPLY'], 0) && this.util.bclt(data['MAX_SUPPLY'], await this.indexerDb.getTokenSupply(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'])))
            error = 'invalid: MAX_SUPPLY < SUPPLY';

        // Verify a MAX_SUPPLY cap is declared before allowing LOCK_MAX_SUPPLY. The cap is taken from
        // this action when present, else the existing token record. Minted supply is NOT
        // required (a fair-mint token locks its cap at issuance, before any supply exists);
        // locking with no declared cap would permanently brick the TICK at a cap of zero.
        //
        // Gate: LOCK_MAX_SUPPLY_EXACT changes the guard from a truthy check to a strict ==1
        // check, fixing a false-positive where an explicit LOCK_MAX_SUPPLY=0 field (a no-op
        // lock intent) triggered the cap validation and produced an invalid outcome. The change
        // is gated so that a heterogeneous fleet and any from-genesis replay all switch over at
        // the same coordinated block, avoiding a ledger fork on any block carrying an explicit
        // LOCK_MAX_SUPPLY=0 field. Pre-launch chains activate at genesis (all zeros), so the
        // strict check is in force from block 0.
        let lockMaxSupplyExact = await this.actions.protocolChanges.isEnabled('LOCK_MAX_SUPPLY_EXACT', data['BLOCK_INDEX']);
        let lockMaxSupplySet   = lockMaxSupplyExact ? (data['LOCK_MAX_SUPPLY']==1) : data['LOCK_MAX_SUPPLY'];
        if(!error && lockMaxSupplySet){
            let lockCap = (!this.util.isNull(data['MAX_SUPPLY'])) ? data['MAX_SUPPLY'] : ((tokenInfo) ? tokenInfo['MAX_SUPPLY'] : null);
            if(this.util.isNull(lockCap) || this.util.bclt(lockCap, this.config.MIN_TOKEN_SUPPLY))
                error = 'invalid: LOCK_MAX_SUPPLY (no max supply)';
        }

        // Verify DECIMAL min/max
        if(!error && !this.util.isNull(data['DECIMALS']) && (this.util.bclt(data['DECIMALS'], this.config.MIN_TOKEN_DECIMALS) || this.util.bcgt(data['DECIMALS'], this.config.MAX_TOKEN_DECIMALS)))
            error = 'invalid: DECIMALS (min/max)';

        // Verify DECIMALS cannot be changed after supply has been issued
        if(!error && !this.util.isNull(data['DECIMALS']) && tokenInfo && this.util.bcgt(tokenInfo['SUPPLY'], 0) && String(data['DECIMALS'])!=String(tokenInfo['DECIMALS']))
            error = 'invalid: DECIMALS (locked)';

        // Verify TRANSFER addresses. Genesis bootstrap is exempt: it seeds Counterparty/
        // Dogeparty owner addresses that are mainnet-format and so fail isCryptoAddress on a
        // regtest network. The manifest is trusted (hash-pinned), so the format check is skipped.
        if(!error && !this.util.isNull(data['TRANSFER']) && !data['IS_GENESIS'] && !this.util.isCryptoAddress(data['TRANSFER']))
            error = 'invalid: TRANSFER (bad address)';

        // Verify TRANSFER_SUPPLY and SOURCE are different
        if(data['TRANSFER_SUPPLY'] == data['SOURCE'])
            delete data['TRANSFER_SUPPLY'];

        // Verify TRANSFER_SUPPLY addresses. Genesis bootstrap is exempt for the same reason
        // as TRANSFER above: the airdrop pass (genesis.js) credits XCP/XDP snapshot holders
        // whose addresses are source-chain mainnet format, and the snapshots are hash-pinned.
        if(!error && !this.util.isNull(data['TRANSFER_SUPPLY']) && !data['IS_GENESIS'] && !this.util.isCryptoAddress(data['TRANSFER_SUPPLY']))
            error = 'invalid: TRANSFER_SUPPLY (bad address)';

        // Verify MINT_SUPPLY is allowed and LOCK_MINT_SUPPLY is not set
        if(!error && !this.util.isNull(data['MINT_SUPPLY']) && tokenInfo && tokenInfo['LOCK_MINT_SUPPLY']==1)
            error = 'invalid: MINT_SUPPLY (locked)';

        // Resolve the uncapped-supply exemption ONCE for the three cross-checks below that
        // compare another field against MAX_SUPPLY. MAX_SUPPLY is stored as 0 when the ISSUE
        // omits it (createToken / db.js) and 0 is the documented UNCAPPED sentinel, so on such
        // a token there is no ceiling for MINT_SUPPLY or MINT_ADDRESS_MAX to exceed, and the
        // comparisons would otherwise reject an uncapped token's own genesis parameters.
        // At/after the UNCAPPED_MAX_SUPPLY_ZERO flag-day the checks are skipped when no
        // positive cap is declared (matching the bcgt(MAX_SUPPLY,0) guards above and mint.js's
        // ceiling); below it every verdict is unchanged, so a from-genesis replay stays
        // byte-identical. Resolved once, not per check, since the gate must not differ between
        // comparisons inside one action, and only on the still-valid path, so a rejected action
        // never spends a decoder-DB read it cannot use. LOCK_MAX_SUPPLY is deliberately not
        // covered: locking a cap that does not exist is still refused by the unchanged guard
        // above.
        let uncappedSupply = !error && !this.util.bcgt(data['MAX_SUPPLY'], 0) &&
            await this.actions.protocolChanges.isEnabled('UNCAPPED_MAX_SUPPLY_ZERO', data['BLOCK_INDEX']);

        // Verify MINT_SUPPLY is less than MAX_SUPPLY
        if(!error && !uncappedSupply && !this.util.isNull(data['MINT_SUPPLY']) && this.util.bcgt(data['MINT_SUPPLY'], data['MAX_SUPPLY']))
            error = 'invalid: MINT_SUPPLY > MAX_SUPPLY';

        // Cumulative MINT_SUPPLY cap: MINT_SUPPLY mints fresh supply on EVERY valid ISSUE (line
        // ~640 credits it unconditionally), so on a re-ISSUE it stacks on top of the supply that
        // already exists. The single-shot MINT_SUPPLY>MAX_SUPPLY guard above ignores that, letting
        // an owner re-ISSUE MINT_SUPPLY repeatedly (LOCK_MINT_SUPPLY unset) and inflate past
        // MAX_SUPPLY - and past a locked NFT edition size, since LOCK_MAX_SUPPLY only freezes the
        // cap, not minting. Enforce the cap against SUPPLY + MINT_SUPPLY, mirroring mint.js's
        // cumulative invariant. getTokenSupply reflects earlier same-block mints/issues; this
        // action's own MINT_SUPPLY is credited later, so it is not yet counted. Gated (tightens
        // validity): flips fleet-wide at one coordinated block; pre-launch chains activate at
        // genesis. The cumulative cap is likewise inapplicable to an uncapped token, for the
        // same reason as the checks above.
        if(!error && !uncappedSupply && !this.util.isNull(data['MINT_SUPPLY']) && this.util.bcgt(data['MINT_SUPPLY'], 0)
           && await this.actions.protocolChanges.isEnabled('ISSUE_MINT_SUPPLY_CUMULATIVE_CAP', data['BLOCK_INDEX'])){
            let currentSupply = await this.indexerDb.getTokenSupply(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let projected     = this.util.bcadd(currentSupply, data['MINT_SUPPLY'], data['DECIMALS']);
            if(this.util.bcgt(projected, this.util.bcadd(data['MAX_SUPPLY'], 0, data['DECIMALS'])))
                error = 'invalid: MINT_SUPPLY exceeds MAX_SUPPLY';
        }

        // Verify MINT_ADDRESS_MAX is less than MAX_SUPPLY (skipped on an uncapped token, see uncappedSupply above)
        if(!error && !uncappedSupply && !this.util.isNull(data['MINT_ADDRESS_MAX']) && this.util.bcgt(data['MINT_ADDRESS_MAX'], 0) && this.util.bcgt(data['MINT_ADDRESS_MAX'], data['MAX_SUPPLY']))
            error = 'invalid: MINT_ADDRESS_MAX > MAX_SUPPLY';

        // Verify MINT_ADDRESS_MAX is greater than than MAX_MINT
        if(!error && !this.util.isNull(data['MINT_ADDRESS_MAX']) && this.util.bcgt(data['MINT_ADDRESS_MAX'], 0) && this.util.bclt(data['MINT_ADDRESS_MAX'], data['MAX_MINT']))
            error = 'invalid: MINT_ADDRESS_MAX < MAX_MINT';

        // Verify MAX_SUPPLY can not be changed if LOCK_MAX_SUPPLY is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_MAX_SUPPLY'] && !this.util.isNull(data['MAX_SUPPLY']) && String(data['MAX_SUPPLY']) != String(tokenInfo['MAX_SUPPLY']))
            error = 'invalid: MAX_SUPPLY (locked)';

        // Verify MAX_MINT can not be changed if LOCK_MAX_MINT is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_MAX_MINT'] && !this.util.isNull(data['MAX_MINT']) && String(data['MAX_MINT']) != String(tokenInfo['MAX_MINT']))
            error = 'invalid: MAX_MINT (locked)';

        // Verify DESCRIPTION is under MAX_TOKEN_DESCRIPTION (rejects at exactly 250; effective max is 249 chars)
        if(!error && data['DESCRIPTION'] && String(data['DESCRIPTION']).length >= this.config.MAX_TOKEN_DESCRIPTION)
            error = 'invalid: DESCRIPTION (length)';

        // Verify DESCRIPTION can not be changed if LOCK_DESCRIPTION is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_DESCRIPTION'] && !this.util.isNull(data['DESCRIPTION']) && data['DESCRIPTION'] != tokenInfo['DESCRIPTION'])
            error = 'invalid: DESCRIPTION (locked)';

        // Verify CALLBACK_BLOCK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_BLOCK']) && String(data['CALLBACK_BLOCK']) != String(tokenInfo['CALLBACK_BLOCK']))
            error = 'invalid: CALLBACK_BLOCK (locked)';

        // Verify CALLBACK_TICK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_TICK']) && data['CALLBACK_TICK'] != tokenInfo['CALLBACK_TICK'])
            error = 'invalid: CALLBACK_TICK (locked)';

        // Verify CALLBACK_TICK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_AMOUNT']) && String(data['CALLBACK_AMOUNT']) != String(tokenInfo['CALLBACK_AMOUNT']))
            error = 'invalid: CALLBACK_AMOUNT (locked)';

        // Verify CALLBACK_BLOCK is greater than current block index
        if(!error && tokenInfo && !this.util.isNull(issue['CALLBACK_BLOCK']) && this.util.bclt(data['CALLBACK_BLOCK'], data['BLOCK_INDEX']))
            error = 'invalid: CALLBACK_BLOCK (block index)';

        // Verify CALLBACK_BLOCK can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_BLOCK']) && tokenInfo && String(data['CALLBACK_BLOCK']) != String(tokenInfo['CALLBACK_BLOCK']) && isDistributed)
            error = 'invalid: CALLBACK_BLOCK (supply distributed)';

        // Verify CALLBACK_TICK can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_TICK']) && tokenInfo && data['CALLBACK_TICK'] != tokenInfo['CALLBACK_TICK'] && isDistributed)
            error = 'invalid: CALLBACK_TICK (supply distributed)';

        // // Verify CALLBACK_AMOUNT can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_AMOUNT']) && tokenInfo && data['CALLBACK_AMOUNT'] != tokenInfo['CALLBACK_AMOUNT'] && isDistributed)
            error = 'invalid: CALLBACK_AMOUNT (supply distributed)';

        // Verify ALLOW_LIST is a valid list of addresses
        if(!error && !this.util.isNull(data['ALLOW_LIST']) && await this.indexerDb.isValidList(data['ALLOW_LIST'],2) == false)
            error = 'invalid: ALLOW_LIST (bad list)';

        // Verify BLOCK_LIST is a valid list of addresses
        if(!error && !this.util.isNull(data['BLOCK_LIST']) && await this.indexerDb.isValidList(data['BLOCK_LIST'],2) == false)
            error = 'invalid: BLOCK_LIST (bad list)';

        // Verify CONTROLLER references an existing, active contract on this chain.
        // The bound contract's `guard` method is consulted before guarded native
        // actions on this token settle (see Controller_Bound_Tokens.md). Mirrors the
        // contract-active check in actions/execute.js so a token can only bind to a
        // contract the indexer can actually execute. A guard whose `guard` method is
        // missing/throws is fail-closed at runtime (denies the action), not here.
        if(!error && !this.util.isNull(data['CONTROLLER'])){
            let controllerInfo = await this.indexerDb.getContract(data['CONTROLLER']);
            if(!controllerInfo){
                error = 'invalid: CONTROLLER (unknown)';
            } else {
                let controllerStatus = await this.indexerDb.getStatusString(controllerInfo.status_id);
                if(controllerStatus !== 'valid')
                    error = 'invalid: CONTROLLER (not active)';
            }
        }

        // Programmable policy layer: token controller bind/unbind (format 6). The CONTROLLER-active
        // check above already validated the bound contract (when CONTROLLER is set); here we validate
        // the per-action-class binding semantics. SOURCE-is-owner is enforced by the generic
        // "issued by another address" check above (tokenInfo is required, so it always applies).
        if(!error && format === 6){
            let actionClass = (this.util.isNull(data['ACTION_CLASS'])) ? null : String(data['ACTION_CLASS']).toLowerCase();
            let isUnbind    = (String(data['UNBIND']) === '1');
            if(!tokenInfo){
                // Can only bind a controller to an existing token you own
                error = 'invalid: TICK (unknown)';
            } else if(this.config['CONTROLLER_BINDABLE_CLASSES'].indexOf(actionClass) === -1){
                error = 'invalid: ACTION_CLASS (unknown)';
            } else {
                let tickId    = await this.indexerDb.getTickerId(data['TICK']);
                let effective = await this.indexerDb.getEffectiveTokenController(tickId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                if(isUnbind){
                    // UNBIND: an effective (still-gating) controller must exist for this class, and
                    // it must be a live bind. A second unbind while one is already in its cooldown
                    // window is rejected (the drop is already scheduled).
                    if(!effective)
                        error = 'invalid: ACTION_CLASS (not bound)';
                    else if(Number(effective.is_unbind) === 1)
                        error = 'invalid: ACTION_CLASS (already unbinding)';
                } else {
                    // BIND: CONTROLLER required, no controller may already gate this class (no
                    // stacking; replace = unbind-then-bind, which preserves the cooldown's teeth),
                    // and any COOLDOWN_BLOCKS given must be a non-negative integer.
                    if(this.util.isNull(data['CONTROLLER']))
                        error = 'invalid: CONTROLLER (null)';
                    else if(effective)
                        error = 'invalid: ACTION_CLASS (already bound)';
                    else if(!this.util.isNull(issue['COOLDOWN_BLOCKS']) && !/^\d+$/.test(String(issue['COOLDOWN_BLOCKS'])))
                        error = 'invalid: COOLDOWN_BLOCKS (format)';
                }
            }
        }

        // The mint-window recency checks exist to stop an ISSUE from BACKDATING a
        // window, so at/above the ISSUE_INHERITED_MINT_WINDOW activation they apply
        // only to a value the ISSUE explicitly carries on the wire (`issue` is the
        // pre-merge snapshot; the CALLBACK edit checks above detect explicit fields
        // the same way). Below it they also run against values the
        // populate-empty-params merge inherited from the existing token record,
        // which rejects every re-parameterizing ISSUE once the token's mint window
        // has opened (the inherited MINT_START_BLOCK is by then in the past); that
        // legacy behaviour is preserved below the flag day so a from-genesis replay
        // reproduces the historical rejections. An explicitly restated past value is
        // rejected either way.
        let inheritedWindowExempt = await this.actions.protocolChanges.isEnabled('ISSUE_INHERITED_MINT_WINDOW', data['BLOCK_INDEX']);
        let mintStartRecency      = inheritedWindowExempt ? issue['MINT_START_BLOCK'] : data['MINT_START_BLOCK'];
        let mintStopRecency       = inheritedWindowExempt ? issue['MINT_STOP_BLOCK']  : data['MINT_STOP_BLOCK'];

        // Verify MINT_START_BLOCK is greater than or equal to current block
        if(!error && !this.util.isNull(mintStartRecency) && this.util.bcgt(mintStartRecency, 0) && this.util.bclt(mintStartRecency, data['BLOCK_INDEX']))
            error = 'invalid: MINT_START_BLOCK < BLOCK_INDEX';

        // Verify MINT_STOP_BLOCK is greater than or equal to current block
        if(!error && !this.util.isNull(mintStopRecency) && this.util.bcgt(mintStopRecency, 0) && this.util.bclt(mintStopRecency, data['BLOCK_INDEX']))
            error = 'invalid: MINT_STOP_BLOCK < BLOCK_INDEX';

        // Verify MINT_STOP_BLOCK is greater than or equal to MINT_START_BLOCK
        if(!error && !this.util.isNull(data['MINT_STOP_BLOCK']) && this.util.bcgt(data['MINT_START_BLOCK'], 0) && this.util.bcgt(data['MINT_STOP_BLOCK'], 0) && this.util.bclt(data['MINT_STOP_BLOCK'], data['MINT_START_BLOCK']))
            error = 'invalid: MINT_STOP_BLOCK < MINT_START_BLOCK';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // The GAS token itself cannot pay an XCHAIN issuance fee to come into
        // existence (chicken-and-egg), so its genesis issuance is fee-exempt.
        // Only the exact GAS tick qualifies (subtokens like XCHAIN.foo do not),
        // and only its first issuance (!tokenInfo). Off regtest, GAS issuance is
        // restricted to the GAS address (checked above), so this cannot be abused.
        let gasBootstrap = (String(data['TICK']).toUpperCase() === String(this.config['GAS']).toUpperCase());

        // Determine if an issuance FEE is required, and what that fee is.
        // VM-emitted ISSUEs (IS_EMISSION) are fee-exempt by design: the deployer
        // already paid DEPLOY/EXECUTE gas (base + per-byte + per-emission gas) and
        // emissions are bounded by maxEmissions, so this is not a spam vector. This
        // mirrors the per-tx db_hits fee, which already skips emissions. The
        // exemption is gated by its own ISSUANCE_FEE_EMISSION_EXEMPT activation so
        // the change in fee behaviour switches over at a coordinated flag-day rather
        // than implicitly the moment a node upgrades (which would fork the ledger
        // between node versions on the first constructor that emits an ISSUE).
        // Before activation every node charges the fee (old behaviour); after it
        // every node exempts.
        let issuanceFeeActive = await this.actions.protocolChanges.isEnabled('ISSUANCE_FEE', data['BLOCK_INDEX']);
        let emissionExempt    = await this.actions.protocolChanges.isEnabled('ISSUANCE_FEE_EMISSION_EXEMPT', data['BLOCK_INDEX']);
        if(!error && !tokenInfo && !gasBootstrap && !data['IS_GENESIS'] && !(data['IS_EMISSION'] && emissionExempt) && issuanceFeeActive){
            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                // Unified gas schedule
                let schedule = this.config['GAS_SCHEDULE'];
                let gasCost  = parentInfo ? schedule.ISSUE_SUBTOKEN : schedule.ISSUE;
                fees['GAS_COST']     = gasCost;
                fees['AMOUNT']       = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);
                fees['FEE_VERSION']  = 2;
            } else {
                // Legacy per-chain fee
                if(parentInfo)
                    fees['AMOUNT'] = this.config['ISSUANCE_FEE_SUBTOKEN'];
                else
                    fees['AMOUNT'] = this.config['ISSUANCE_FEE_TOKEN'];
            }
        }

        // Validate fee payment (native coin or XCHAIN balance)
        if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(paymentMode === 'native'){
                // Native coin fee: validate against oracle price
                let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    fees['PAYMENT_MODE']       = 1;
                    fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    fees['NATIVE_COIN']        = validation.nativeCoin;
                    fees['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(paymentMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                // XCHAIN balance deduction (default)
                if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        let status = (error) ? error : 'valid';
        data['STATUS'] = issue['STATUS'] = status;

        console.log("\t ISSUE : " + data['TICK'] + ' : ' + data['STATUS']);

        await this.indexerDb.createIssue(issue);

        this.util.addAddressTicker(data['SOURCE'], data['TICK']);

        if(!this.util.isNull(data['TRANSFER_SUPPLY']))
            this.util.addAddressTicker(data['TRANSFER_SUPPLY'], data['TICK']);

        if(status=='valid'){

            let credits = [],
                debits  = [];

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Support token ownership transfers
            data['OWNER']  = (!this.util.isNull(data['TRANSFER'])) ? data['TRANSFER'] : data['SOURCE'];

            // Create/update record in tokens table
            await this.indexerDb.createToken(data);

            // Programmable policy layer: append the token controller bind/unbind event (format 6).
            // The binding lives in token_controllers (not the token record); the issues row above is
            // the audit trail. issue['CONTROLLER']/['COOLDOWN_BLOCKS'] are the raw (pre-numeric)
            // values, which map cleanly onto the BIGINT/INT columns.
            if(format === 6){
                let tickId      = await this.indexerDb.getTickerId(data['TICK']);
                let actionClass = String(data['ACTION_CLASS']).toLowerCase();
                let boundById   = await this.indexerDb.createAddress(data['SOURCE']);
                if(String(data['UNBIND']) === '1'){
                    // The drop schedules at block + the live bind's committed cooldown; the controller
                    // keeps gating until then. effective is non-null + a live bind (validated above).
                    let effective   = await this.indexerDb.getEffectiveTokenController(tickId, actionClass, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                    let cooldown    = Number(effective.cooldown_blocks) || 0;
                    let cooldownEnd = parseInt(data['BLOCK_INDEX']) + cooldown;
                    await this.indexerDb.recordTokenControllerEvent({
                        action_index: data['ACTION_INDEX'], tick_id: tickId, action_class: actionClass,
                        contract_index: effective.contract_index, bound_by_id: boundById, is_unbind: 1,
                        cooldown_blocks: cooldown, cooldown_end_block: cooldownEnd, block_index: data['BLOCK_INDEX']
                    });
                } else {
                    let cooldown = (this.util.isNull(issue['COOLDOWN_BLOCKS'])) ? 0 : parseInt(issue['COOLDOWN_BLOCKS']);
                    await this.indexerDb.recordTokenControllerEvent({
                        action_index: data['ACTION_INDEX'], tick_id: tickId, action_class: actionClass,
                        contract_index: issue['CONTROLLER'], bound_by_id: boundById, is_unbind: 0,
                        cooldown_blocks: cooldown, cooldown_end_block: null, block_index: data['BLOCK_INDEX']
                    });
                }
            }

            if(data['MINT_SUPPLY'])
                credits.push([data['TICK'], data['MINT_SUPPLY'], data['SOURCE']]);

            if(data['MINT_SUPPLY'] && data['TRANSFER_SUPPLY']){
                debits.push([data['TICK'],  data['MINT_SUPPLY'], data['SOURCE']]);
                credits.push([data['TICK'], data['MINT_SUPPLY'], data['TRANSFER_SUPPLY']]);
            }

            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }

        await this.mapper.createMappings(data);

    }
}

module.exports = Issue;