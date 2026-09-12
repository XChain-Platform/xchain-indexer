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
 * XChain Platform Action - XBRIDGE (user-broadcast lock/burn, system-injected settle)
 *
 * The module shape, the method names, the parameter sets and the exact verdict strings
 * are the SEAM every bridge lane builds against. The wire side (v0, v1, v3, v4) is built
 * here by lane L3; the mirror-injected settle legs (v2, v5) live in ../bridge_settle.js.
 *
 * TWO WRITERS THIS HANDLER CALLS THAT DO NOT EXIST YET, raised to the orchestrator by
 * lane L3 rather than invented here (neither spec, nor the seam contract, nor any lane's
 * surface list names them, and both sit in files this lane does not own):
 *
 *   1. `xbridges` action table plus `Database.createXbridge(data)`. Every user-broadcast
 *      action on the platform records its own row (sends, destroys, cross_chain_calls);
 *      the hub's CrossChainBridgeEngine polls the indexer's `getpendingbridgetransfers`
 *      for confirmed locks and burns, and that read (lane L15) has nothing to read
 *      without this table. The row needs: action_index, format (the version byte),
 *      tick_id, source_id, dest_chain, dest_address_id (v0/v3) or origin_address_id
 *      (v1/v4), amount, decimals, min_depth, memo, status_id, block_index.
 *   2. `Database.setTokenBridged(tick, blockIndex)` for the token spec's `tokens.bridged`
 *      bit (section 8), set by the first applied v3 lock. `createToken` derives every
 *      tokens column from the issues rows and this one is not derivable from an ISSUE,
 *      so it needs its own setter.
 *
 * One action name, one handler with a version switch, one manifest entry, one decoder
 * name, one doc page. The version decides who may broadcast it and on which chain -
 * the shape ATTEST (v0 request, v1 response, v2 expiry) and XCALL already use.
 *
 * FORMATS:
 *   v0 - lock,   user-broadcast, BTC only:        VERSION|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO
 *   v1 - burn,   user-broadcast, non-BTC only:    VERSION|BTC_ADDRESS|AMOUNT|MEMO
 *   v2 - settle, mirror-injected, never broadcast (from a finalized bridge_transfers row)
 *   v3 - lock,   user-broadcast, origin chain:    VERSION|TICK|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO
 *   v4 - burn,   user-broadcast, bridged rows:    VERSION|TICK|ORIGIN_ADDRESS|AMOUNT|MEMO
 *   v5 - settle, mirror-injected, never broadcast (the v2 legs carrying a tick)
 *
 * WHERE THE WORK SPLITS. This file owns the WIRE side: parse, guards, verdicts, and the
 * ledger effect of a lock and a burn. The mirror-injected settle legs (v2 and v5) are
 * applied from ../bridge_settle.js, which is a separate file for the same reason
 * cross_settle.js is separate from the handlers whose escrow it releases: a settle leg is
 * driven by an end-of-block pass over mirrored rows, not by a transaction on this chain.
 *
 * ACTIVATION. v0/v1/v2 gate on ../xchain_bridge_activation.js, v3/v4/v5 on
 * ../token_bridge_activation.js, both keyed on the block_index of the chain being parsed.
 * Below the gate a broadcast is 'invalid: XBRIDGE before activation' (the per-feature
 * shape anchor.js uses) and no settle leg is ever injected, so pre-activation block hashes
 * are unchanged on every chain.
 *
 * Two closures do NOT gate on either activation and hold on every non-BTC chain from the
 * commit that lands them (base spec D62): ISSUE of the GAS tick off BTC, and DESTROY of
 * the GAS tick off BTC. They live in issue.js and destroy.js (lane L4), not here.
 *
 * Spec: the base bridge spec sections 4 to 9; the token bridge spec
 * sections 5 to 7. Docs: xchain-documentation/protocol/actions/xbridge.md (lane L9).
 *
 ********************************************************************/

'use strict';

const xchainBridgeActivation = require('../xchain_bridge_activation.js');
const tokenBridgeActivation  = require('../token_bridge_activation.js');

// Version bytes this build knows. `this.formats` holds only the four USER formats, so it
// cannot answer "is this a known version": v2 and v5 are mirror-injected and carry no
// wire format, yet a broadcast of one is refused BY NAME rather than as an unknown
// version, which is the whole point of the two V*_SYSTEM_INJECTED verdicts.
const USER_VERSIONS     = [0, 1, 3, 4];
const INJECTED_VERSIONS = [2, 5];

// v0/v1/v2 are the XCHAIN bridge and gate on XCHAIN_BRIDGE_ACTIVATION; v3/v4/v5 are the
// general token bridge and gate on TOKEN_BRIDGE_ACTIVATION. The parity test pins
// TOKEN >= XCHAIN per network, so a chain can never admit v3 without an engine behind it.
const TOKEN_VERSIONS    = [3, 4, 5];

// Platform-wide verdicts this handler REUSES rather than minting a bridge-specific twin.
// Every one of them is already written by send.js / destroy.js / dividend.js for exactly
// the condition it names, so reusing the literal keeps one string per condition across
// the whole action set (the rule XBridge.VERDICTS states for its own strings).
const TICK_UNKNOWN       = 'invalid: TICK (unknown)';
const SOURCE_SLEEPING    = 'invalid: SOURCE (sleeping)';
const TICK_SLEEPING      = 'invalid: TICK (sleeping)';
const SOURCE_UNAUTHORIZED= 'invalid: SOURCE (not authorized)';
const MEMO_PIPE          = 'invalid: MEMO (pipe)';
const MEMO_SEMICOLON     = 'invalid: MEMO (semicolon)';
const MEMO_LENGTH        = 'invalid: MEMO (length)';
const FEE_NATIVE_REQUIRED= 'invalid: insufficient fee (native coin output required)';
const FEE_INSUFFICIENT   = 'invalid: insufficient funds (FEE)';

/**
 * Every verdict string XBRIDGE can write to data['STATUS'], frozen here so the handler,
 * its unit tests, the SDK and the docs all quote ONE source.
 *
 * THESE STRINGS ARE CONSENSUS. A verdict is persisted in index_statuses and enters
 * actions_hash, so renaming one re-grades history on replay and forks the fleet. Reuse an
 * existing string wherever the spec says to (the REUSED block at the foot of this object)
 * rather than minting a clearer one.
 *
 * PRECEDENCE, as implemented, top to bottom:
 *   version known -> activation -> broadcast of an injected version -> chain rule ->
 *   the tick guards (v3/v4 only: row kind, GAS, dot, length) -> TICK unknown ->
 *   BRIDGE_CHAINS (v3) -> DEST_COIN -> the address field -> AMOUNT -> sleep and list ->
 *   MEMO -> funds -> the fee refusals every action shares.
 *
 * Activation sits ABOVE the chain and injected-version rules deliberately: below the gate
 * the feature is not live at all, so the whole action answers with one string rather than
 * a per-version taxonomy of something no chain can run yet. Within the tick guards the
 * order is the token spec's own refusal list, which is why TICK_NOT_BRIDGEABLE is reached
 * before DEST_COIN: a destination the issuer never opted into is a fact about the TOKEN.
 */
const VERDICTS = {
    // Shared gates (base spec D6).
    BEFORE_ACTIVATION:   'invalid: XBRIDGE before activation',        // below XCHAIN_BRIDGE_ACTIVATION / TOKEN_BRIDGE_ACTIVATION for this network
    UNKNOWN_VERSION:     'invalid: VERSION (unknown)',                // a version byte outside 0-5; a KNOWN version below its gate is BEFORE_ACTIVATION instead
    BTC_ONLY:            'invalid: XBRIDGE (BTC only)',               // v0 broadcast on any chain other than BTC; the literal the five BTC-only handlers share
    V1_NOT_ON_BTC:       'invalid: XBRIDGE v1 is not valid on BTC',   // v1 broadcast on BTC (the inverse-chain shape anchor.js uses)
    V2_SYSTEM_INJECTED:  'invalid: XBRIDGE v2 is system-injected',    // a BROADCAST v2 on any chain, as a broadcast XCALL v2 is refused
    V5_SYSTEM_INJECTED:  'invalid: XBRIDGE v5 is system-injected',    // a BROADCAST v5 on any chain, the v2 rule carried to the general formats

    // Field refusals (base spec section 4, v0 and v1).
    DEST_COIN:           'invalid: DEST_COIN',                        // not a supported coin, or equal to this chain's coin
    DEST_ADDRESS:        'invalid: DEST_ADDRESS',                     // fails isCryptoAddress(address, DEST_COIN, network)
    AMOUNT:              'invalid: AMOUNT',                           // not a positive decimal, or more fractional digits than the token's DECIMALS
    INSUFFICIENT_FUNDS:  'invalid: insufficient funds',               // the source's balance of the tick on this chain is short

    // Tick refusals (token spec section 5), in the spec's precedence order.
    TICK_NOT_NATIVE:     'invalid: TICK (not native here)',                     // v3 on a bridged row, or on a chain that is not the row's origin
    TICK_USE_V0:         'invalid: TICK (use XBRIDGE v0)',                      // v3 of the GAS tick; XCHAIN keeps v0
    TICK_SUBASSET:       'invalid: TICK (subassets are not bridgeable yet)',    // a dotted name; the prefix walk is a later milestone
    TICK_TOO_LONG:       'invalid: TICK (too long to bridge)',                  // <ORIGIN>.<NAME> would exceed the destination's tick length
    TICK_NOT_BRIDGEABLE: 'invalid: TICK (not bridgeable to DEST_COIN)',         // DEST_COIN is not in the origin row's BRIDGE_CHAINS (section 7)
    TICK_NOT_BRIDGED:    'invalid: TICK (not bridged)',                         // v4 on a native row

    // Address refusals for the formats whose address field is not DEST_ADDRESS. NOT named
    // verbatim in either spec: they follow v0's field-named convention (`invalid: <FIELD>`),
    // which is the only shape the base spec's refusal list uses. L3 owns confirming these
    // two literals against the manifest and the docs page before the first signed row.
    BTC_ADDRESS:         'invalid: BTC_ADDRESS',                      // v1: fails isCryptoAddress(address, 'BTC', network)
    ORIGIN_ADDRESS:      'invalid: ORIGIN_ADDRESS',                   // v4: fails isCryptoAddress(address, <origin>, network)

    // Platform-wide strings this handler REUSES. Listed here so XBridge.VERDICTS stays a
    // complete inventory of what the handler can write (the SDK, the docs page and the
    // unit tests read it as one), but every literal is the one an existing handler
    // already writes for the same condition; none of them is new to the platform.
    TICK_UNKNOWN:        TICK_UNKNOWN,                                // no row for TICK on this chain (send.js, destroy.js)
    SOURCE_SLEEPING:     SOURCE_SLEEPING,                             // the source address is asleep (send.js)
    TICK_SLEEPING:       TICK_SLEEPING,                               // the token is asleep (send.js)
    SOURCE_UNAUTHORIZED: SOURCE_UNAUTHORIZED,                         // the source is off an allow list or on a block list (send.js)
    MEMO_PIPE:           MEMO_PIPE,                                   // MEMO carries the field delimiter (send.js)
    MEMO_SEMICOLON:      MEMO_SEMICOLON,                              // MEMO carries the action delimiter (send.js)
    MEMO_LENGTH:         MEMO_LENGTH,                                 // MEMO longer than MAX_MEMO_LENGTH (send.js)
    FEE_NATIVE_REQUIRED: FEE_NATIVE_REQUIRED,                         // off BTC a protocol fee must be a native-coin output (sweep.js)
    FEE_INSUFFICIENT:    FEE_INSUFFICIENT,                            // the source cannot cover XBRIDGE_BASE in XCHAIN (sweep.js)
};

class XBridge {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Wire formats, by version byte. v2 and v5 carry no user format: they are injected
        // from a finalized bridge_transfers row and are refused outright when broadcast.
        this.formats = {};
        this.formats[0] = 'VERSION|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO';
        this.formats[1] = 'VERSION|BTC_ADDRESS|AMOUNT|MEMO';
        this.formats[3] = 'VERSION|TICK|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO';
        this.formats[4] = 'VERSION|TICK|ORIGIN_ADDRESS|AMOUNT|MEMO';
    }

    /**
     * The default handler entry. actions.js dispatches every parsed XBRIDGE here, exactly
     * as it dispatches SEND to send.js and ANCHOR to anchor.js:
     *
     *     if(action=='XBRIDGE')  await this.actionXbridge.parse(params, data, error);
     *
     * Dispatches on data['FORMAT']: 0 and 3 to applyLock, 1 and 4 to applyBurn, 2 and 5 to
     * the system-injected refusal. Writes exactly one verdict to data['STATUS'] and, on a
     * valid action, the ledger effect through this.indexerDb, then this.mapper.
     *
     * DB READ ORDER IS CONSENSUS. getTokenInfo() interns its argument in index_tickers
     * (createTicker), and index ids feed the ledger hash, so a read that happens on one
     * node and not another forks the id counter. Every read below therefore sits behind
     * a guard that depends only on wire bytes and node-uniform config: the pure-string
     * tick guards run FIRST and a refused shape never reaches a read, on every node.
     *
     * @param {Array<string>}       params - the raw `|`-split wire fields, VERSION first
     * @param {Object}              data   - the action row under construction. Reads FORMAT,
     *                                       SOURCE, BLOCK_INDEX, BLOCK_TIME, ACTION_INDEX,
     *                                       IS_GENESIS; writes STATUS and the parsed fields
     * @param {string|null|undefined} error - a verdict an earlier gate already reached; when
     *                                       set, the handler records the row and adds no
     *                                       effect (the send.js convention)
     * @returns {Promise<void>}
     */
    async parse(params, data, error){

        let format = data['FORMAT'];

        // Parse the positional wire fields for the four user formats. v2 and v5 have no
        // user format, so nothing is mapped for them; they are refused (or handed to the
        // settle pass) below on the version byte alone.
        if(this.formats[format] !== undefined)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Raw wire clone for the action row, taken BEFORE setNumberFormats so the record
        // keeps the amount text exactly as it was broadcast (the dividend.js precedent).
        let xbridge = Object.assign({}, data);

        if(!error)
            data = this.util.setNumberFormats(data);

        // The handler context every method below shares. `coin` is this chain's coin and
        // decides BTC_ONLY versus V1_NOT_ON_BTC; `network` keys both activation maps.
        // `credits` / `debits` are the ledger plan applyLock / applyBurn fill in, so the
        // two apply methods can stay pure verdict functions from the caller's side.
        let ctx = {
            coin:          this.config['COIN'],
            network:       this.config['NETWORK'],
            blockIndex:    data['BLOCK_INDEX'],
            blockTime:     data['BLOCK_TIME'],
            isGenesis:     data['IS_GENESIS'] === true,
            tick:          null,
            origin:        null,
            tokenInfo:     null,
            sourceBalance: null,
            escrow:        null,
            credits:       [],
            debits:        []
        };

        // Shared gates: known version, activation, broadcast-of-an-injected-version, chain.
        if(!error){
            let gate = this.validateFormat(data, ctx);
            if(!gate.valid)
                error = gate.verdict;
        }

        // A system-injected settle leg that passed the gates is NOT this handler's to
        // apply: ../bridge_settle.js drives v2 and v5 from the mirrored bridge_transfers
        // row at the pinned end-of-block pass position (lane L14). Returning without
        // writing a verdict leaves that row entirely to the settle pass, which is the
        // only writer of it.
        if(!error && INJECTED_VERSIONS.indexOf(format) !== -1)
            return;

        // Resolve the tick this action moves. v0 and v1 are the GAS tick by construction
        // (XCHAIN is the only asset the base spec bridges); v3 and v4 carry it on the wire.
        if(format === 0 || format === 1)
            ctx.tick = this.config['GAS'];
        if(format === 3 || format === 4)
            ctx.tick = data['TICK'];

        // Pure-string tick guards (row kind, GAS, dot, length). No database read, so the
        // refused shapes above never intern a junk ticker id.
        if(!error){
            let shape = this._validateTickShape(format, ctx);
            if(!shape.valid)
                error = shape.verdict;
            ctx.origin = shape.origin;
        }

        // Reads, only on a path that has passed every wire-only guard.
        let preferences = null;
        if(!error){
            ctx.tokenInfo     = await this.indexerDb.getTokenInfo(ctx.tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            ctx.sourceBalance = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            preferences       = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Version-specific validation and the ledger plan.
        if(!error){
            let result = (format === 0 || format === 3)
                ? await this.applyLock(data, ctx)
                : await this.applyBurn(data, ctx);
            if(!result.valid)
                error = result.verdict;
        }

        // Protocol fee: the flat XBRIDGE_BASE gas entry for every user-broadcast version
        // (base spec D3, token spec R5). Charged AFTER the amount was debited from the
        // in-memory balance above, so on BTC - where the fee is paid out of the same
        // XCHAIN balance a v0 lock moves - AMOUNT and the fee must fit together and a
        // source cannot spend one balance twice.
        let fees = null;
        if(!error){
            fees                = await this.util.createFeesObject(this.indexerDb, data, preferences);
            fees['GAS_COST']    = this.util.resolveGasScheduleCost('XBRIDGE_BASE');
            fees['AMOUNT']      = this.util.feeForAction(this.util.bcmul(fees['GAS_COST'], this.config['GAS_PRICE'], 8), data);
            fees['FEE_VERSION'] = 2;

            if(this.util.bcgt(fees['AMOUNT'], 0)){
                let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
                if(paymentMode === 'native'){
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
                    error = FEE_NATIVE_REQUIRED;
                } else if(!this.util.hasBalance(ctx.sourceBalance, fees['TICK_ID'], fees['AMOUNT'])){
                    error = FEE_INSUFFICIENT;
                }
            }
        }

        let status = (error) ? error : 'valid';
        data['STATUS'] = xbridge['STATUS'] = status;

        // Fields the lock stamps onto its OWN row, as read at its OWN block: the hub signs
        // `decimals` into the transfer record, and applies max(platform depth, min_depth)
        // from the stamped value rather than re-reading the origin row at poll time, so a
        // later format 7 edit can never make an accepted lock un-signable and two
        // followers can never disagree (token spec D24). Carried on the invalid row too,
        // so the record says what the action asked for.
        xbridge['DECIMALS']  = data['DECIMALS'];
        xbridge['MIN_DEPTH'] = data['MIN_DEPTH'];
        xbridge['DEST_CHAIN']= data['DEST_CHAIN'];

        console.log("\t XBRIDGE v" + format + " : " + ctx.tick + ' : ' + this.util.logAmount(data['AMOUNT']) +
                    ' : ' + (data['DEST_CHAIN'] || ctx.origin || '') + ' : ' + status);

        // MISSING WRITER 1 (see the file header): the xbridges table and this method do
        // not exist yet. The call is unconditional on purpose, because a handler that
        // silently skips its own record is worse than one that fails loudly, and because
        // the hub's poll and the pending read are both built on this row.
        await this.indexerDb.createXbridge(xbridge);

        // Register the SOURCE so the action is findable by address even when it was
        // refused. The tick is only attached when this action got far enough to resolve
        // one: addAddressTicker records the address either way, and passing undefined is
        // what keeps a null out of the tickers list an invalid refusal would otherwise add.
        this.util.addAddressTicker(data['SOURCE'], this.util.isNull(ctx.tick) ? undefined : ctx.tick);

        if(status == 'valid'){

            let credits = ctx.credits,
                debits  = ctx.debits;

            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            // updateTokens is what lowers the burned token's SUPPLY: a burn is a debit with
            // no offsetting credit, and supply is recomputed from the ledger
            // (credits - debits + escrows), the DESTROY supply path verbatim.
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);

            // MISSING WRITER 2 (see the file header): the first applied v3 sets the origin row's
            // `bridged` bit, which is never cleared in milestone 1, so emptying
            // BRIDGE_CHAINS after bridging cannot reopen the policy door while copies are
            // outstanding (token spec section 8).
            if(format === 3)
                await this.indexerDb.setTokenBridged(ctx.tick, data['BLOCK_INDEX']);
        }

        await this.mapper.createMappings(data);
    }

    /**
     * Pure-string guards on the TICK a lock or a burn names. No database read: every
     * answer here comes from the wire bytes plus node-uniform config, which is what lets
     * parse() run them before any getTokenInfo and keep the index-ticker id counter
     * identical on every node.
     *
     * Returns { valid, verdict, origin }, where `origin` is the bridged row's origin coin
     * for a v4 burn and null everywhere else.
     *
     * @param {number} format - the version byte (0, 1, 3 or 4)
     * @param {Object} ctx    - the handler context; reads ctx.tick and ctx.coin
     * @returns {{valid: boolean, verdict: (string|null), origin: (string|null)}}
     */
    _validateTickShape(format, ctx){
        let pass = { valid: true, verdict: null, origin: null };

        // v0 and v1 move the GAS tick, which is protocol-reserved on every chain and needs
        // no shape check at all.
        if(format === 0 || format === 1)
            return pass;

        let tick   = ctx.tick;
        let parsed = this.util.parseBridgedTick(tick, ctx.coin);

        if(format === 4){
            // A burn names a BRIDGED copy. parseBridgedTick is null for anything that is
            // not `<ORIGIN>.<NAME>` with ORIGIN a supported coin other than this one, which
            // is exactly "not a bridged row here".
            if(!parsed)
                return { valid: false, verdict: VERDICTS.TICK_NOT_BRIDGED, origin: null };
            return { valid: true, verdict: null, origin: parsed.origin };
        }

        // v3, in the token spec's own precedence order.

        // A lock names a NATIVE row. A rooted name is a bridged copy: burn it with v4.
        if(parsed)
            return { valid: false, verdict: VERDICTS.TICK_NOT_NATIVE, origin: null };

        // XCHAIN keeps v0. Case-folded because every ticker lookup is LOWER(tick), so
        // `xchain` and `XCHAIN` reach one row and must reach one verdict.
        if(String(tick).toUpperCase() === String(this.config['GAS']).toUpperCase())
            return { valid: false, verdict: VERDICTS.TICK_USE_V0, origin: null };

        // A dotted native name cannot be rooted: the parent split takes everything before
        // the LAST dot, so `BTC.PEPE.CASH` would need a `BTC.PEPE` row the bridge never
        // creates. The prefix walk that lifts this is a later milestone (token spec D15).
        // This also catches a subasset of THIS chain's own coin root, which parseBridgedTick
        // deliberately returns null for.
        if(String(tick).indexOf('.') !== -1)
            return { valid: false, verdict: VERDICTS.TICK_SUBASSET, origin: null };

        // The rooted form on the destination is `<THIS COIN>.<TICK>`, so a native tick
        // longer than MAX_TICK_LENGTH minus the root and the dot cannot be bridged at all
        // (246 characters for BTC and LTC, 245 for DOGE). Refused at lock time so no
        // transfer can strand (token spec D14).
        let rooted = String(ctx.coin).length + 1 + String(tick).length;
        if(rooted > this.config['MAX_TICK_LENGTH'])
            return { valid: false, verdict: VERDICTS.TICK_TOO_LONG, origin: null };

        return pass;
    }

    /**
     * Shared checks every user-broadcast version runs between its address checks and its
     * balance check: SOURCE asleep, TICK asleep, SOURCE off an allow list or on a block
     * list. The token spec states them for v3 ("a sleeping or list-blocked source cannot
     * lock"); they are applied to v0, v1 and v4 as well because SLEEP is a source-level
     * freeze the platform applies to every value-moving action and XBRIDGE moves value.
     * Positioned exactly where send.js runs them, and every string is send.js's own.
     *
     * @param {Object} data - the action row; reads SOURCE and BLOCK_INDEX
     * @param {Object} ctx  - the handler context; reads ctx.tick
     * @returns {Promise<{valid: boolean, verdict: (string|null)}>}
     */
    async _validateSourceAllowed(data, ctx){
        if(await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            return { valid: false, verdict: SOURCE_SLEEPING };
        if(await this.indexerDb.isActionAllowed(null, ctx.tick, data['BLOCK_INDEX']) == false)
            return { valid: false, verdict: TICK_SLEEPING };
        if(await this.indexerDb.isActionAllowed(data['SOURCE'], ctx.tick) == false)
            return { valid: false, verdict: SOURCE_UNAUTHORIZED };
        return { valid: true, verdict: null };
    }

    /**
     * MEMO checks, byte-identical to the ones send.js / destroy.js / dividend.js run.
     * The length bound is the one that matters here: MEMO is stored, and a value past
     * MAX_MEMO_LENGTH would be truncated by the column rather than refused, which is a
     * verdict that depends on the database rather than on the chain.
     *
     * @param {Object} data - the action row; reads MEMO
     * @returns {{valid: boolean, verdict: (string|null)}}
     */
    _validateMemo(data){
        if(!this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|') != -1)
            return { valid: false, verdict: MEMO_PIPE };
        if(!this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';') != -1)
            return { valid: false, verdict: MEMO_SEMICOLON };
        if(String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            return { valid: false, verdict: MEMO_LENGTH };
        return { valid: true, verdict: null };
    }

    /**
     * Is `destCoin` in the origin row's BRIDGE_CHAINS opt-in list? Default is OFF (token
     * spec R4): an unset, empty or `-` field bridges nowhere. The list is a comma list of
     * destination coins stored as the raw wire string, compared verbatim so the refusal
     * matches what the issuer actually wrote.
     *
     * @param {Object} info     - the origin row's getTokenInfo projection
     * @param {string} destCoin - the requested destination coin
     * @returns {boolean}
     */
    _isBridgeableTo(info, destCoin){
        let raw = (info) ? info['BRIDGE_CHAINS'] : null;
        if(this.util.isNull(raw) || String(raw) === '' || String(raw) === '-')
            return false;
        return String(raw).split(',').indexOf(String(destCoin)) !== -1;
    }

    /**
     * Format-level validation shared by every user-broadcast version: the version byte is
     * one this build knows, the action is at or above its own activation for this network,
     * the chain is legal for this version, and the field arity matches this.formats.
     *
     * Runs BEFORE any balance or token read, so a refusal costs no query, and it is the
     * only place the shared gates are evaluated: applyLock and applyBurn assume they were
     * reached with a version, a chain and an activation that already passed.
     *
     * Field ARITY is not a refusal of its own: setActionParams pads a short action's
     * missing fields with null and the platform ignores trailing extras, so a missing
     * field is refused by ITS OWN check below (a missing DEST_ADDRESS is
     * 'invalid: DEST_ADDRESS', never a generic arity verdict). That is the convention
     * every other handler follows, and neither spec names an arity string.
     *
     * @param {Object} data - the action row. Reads FORMAT, BLOCK_INDEX, IS_SYNTHETIC and
     *                        the parsed wire fields; never mutated by this method
     * @param {Object} ctx  - handler context: { coin, network, blockIndex, blockTime,
     *                        isGenesis }. `coin` is this chain's coin, which decides
     *                        BTC_ONLY versus V1_NOT_ON_BTC; `network` keys both activation
     *                        maps
     * @returns {{valid: boolean, verdict: (string|null)}} verdict is one of
     *          VERDICTS.BEFORE_ACTIVATION, UNKNOWN_VERSION, BTC_ONLY, V1_NOT_ON_BTC,
     *          V2_SYSTEM_INJECTED, V5_SYSTEM_INJECTED, or null when the format passes
     */
    validateFormat(data, ctx){

        let format = data['FORMAT'];

        // A version byte outside 0-5. Checked first, the way every handler checks it, so a
        // garbage version never reaches an activation map or a chain rule.
        if(format === null || format === undefined ||
           (USER_VERSIONS.indexOf(format) === -1 && INJECTED_VERSIONS.indexOf(format) === -1))
            return { valid: false, verdict: VERDICTS.UNKNOWN_VERSION };

        // The shared activation gate, keyed on the block_index of the CHAIN BEING PARSED
        // and never on a transfer's snapshot_block. Below it every version is refused with
        // one string and no settle leg is ever injected, so pre-activation block hashes are
        // unchanged on every chain. It runs before the chain and injected-version rules so
        // that a pre-activation chain gives ONE answer for the whole action rather than a
        // per-version taxonomy of a feature that is not live yet.
        let active = (TOKEN_VERSIONS.indexOf(format) !== -1)
            ? tokenBridgeActivation.isTokenBridgeActive(ctx.blockIndex, ctx.network)
            : xchainBridgeActivation.isXchainBridgeActive(ctx.blockIndex, ctx.network);
        if(!active)
            return { valid: false, verdict: VERDICTS.BEFORE_ACTIVATION };

        // A BROADCAST of a mirror-injected version. IS_SYNTHETIC is stamped only by the
        // indexer's own injection passes, never by a decoded transaction, so this is the
        // same test xcall.js makes for its synthetic v2 expiry.
        if(format === 2 && !data['IS_SYNTHETIC'])
            return { valid: false, verdict: VERDICTS.V2_SYSTEM_INJECTED };
        if(format === 5 && !data['IS_SYNTHETIC'])
            return { valid: false, verdict: VERDICTS.V5_SYSTEM_INJECTED };

        // Chain rules for the two XCHAIN formats. v0 locks into the BTC-side escrow, so it
        // is BTC-only (the literal the five BTC-only handlers share); v1 burns a foreign
        // chain's copy, so it is everywhere BUT BTC (the inverse-chain shape anchor.js
        // uses). v3 and v4 carry no chain literal: their chain rule is the tick's row kind,
        // which _validateTickShape decides.
        if(format === 0 && ctx.coin !== 'BTC')
            return { valid: false, verdict: VERDICTS.BTC_ONLY };
        if(format === 1 && ctx.coin === 'BTC')
            return { valid: false, verdict: VERDICTS.V1_NOT_ON_BTC };

        return { valid: true, verdict: null };
    }

    /**
     * Apply a LOCK: v0 (XCHAIN, BTC only) and v3 (any bridgeable native token, on its own
     * origin chain).
     *
     * EFFECT, identical for both versions:
     *   debit(SOURCE, tick, AMOUNT)
     *   credit(ADDRESS.BRIDGE_<DEST_COIN>, tick, AMOUNT)
     * No escrow rows are written, so the escrow journal's totality contract is untouched;
     * the escrow is an ordinary balance at a protocol role address nobody holds a key for,
     * which is what makes it reconcile in db.sanityCheck and ride balances_root for free.
     * Fee: the GAS_SCHEDULE entry XBRIDGE_BASE, 5,000 gas, for both v0 and v3.
     *
     * A v3 lock ALSO stamps the origin row's DECIMALS and MIN_DEPTH as read at its own
     * block onto its own action row (a later edit of the origin row can then never make an
     * accepted lock un-signable, and no two followers can disagree) and sets the origin
     * row's `bridged` bit, which is never cleared in milestone 1.
     *
     * v3 consults isActionAllowed for the source and tick the way SEND does: a sleeping or
     * list-blocked source cannot lock.
     *
     * @param {Object} data - the action row. Reads FORMAT, SOURCE, TICK (v3 only),
     *                        DEST_COIN, DEST_ADDRESS, AMOUNT, MEMO, BLOCK_INDEX,
     *                        BLOCK_TIME, ACTION_INDEX; writes STATUS
     * @param {Object} ctx  - handler context: { coin, network, blockIndex, blockTime,
     *                        tokenInfo, sourceBalance }
     * @returns {Promise<{valid: boolean, verdict: (string|null)}>} verdict is one of
     *          VERDICTS.TICK_NOT_NATIVE, TICK_USE_V0, TICK_SUBASSET, TICK_TOO_LONG,
     *          TICK_NOT_BRIDGEABLE, DEST_COIN, DEST_ADDRESS, AMOUNT, INSUFFICIENT_FUNDS,
     *          or null when the lock applies
     */
    async applyLock(data, ctx){

        let format = data['FORMAT'];
        let info   = ctx.tokenInfo;

        if(!info)
            return { valid: false, verdict: TICK_UNKNOWN };

        // The issuer's opt-in, read at the lock's OWN block. Ordered BEFORE the DEST_COIN
        // check because the token spec's refusal list puts every TICK refusal ahead of the
        // base v0/v1 field refusals: a destination the issuer never opted into is a
        // property of the TOKEN, and saying so is more useful than "unknown coin" for a
        // name that happens to be both.
        if(format === 3 && !this._isBridgeableTo(info, data['DEST_COIN']))
            return { valid: false, verdict: VERDICTS.TICK_NOT_BRIDGEABLE };

        // DEST_COIN is a supported coin other than this one. Compared verbatim, not
        // case-folded: COINS carries the canonical upper-case symbols and the platform's
        // other cross-chain field (xcall.js TARGET_CHAIN) compares the same way, so one
        // spelling is legal and a lock can never be addressed at a coin the escrow map
        // does not key.
        let dest  = data['DEST_COIN'];
        let coins = this.config['COINS'] || [];
        if(this.util.isNull(dest) || coins.indexOf(String(dest)) === -1 || String(dest) === String(ctx.coin))
            return { valid: false, verdict: VERDICTS.DEST_COIN };

        // The keyless escrow role address for that destination, in THIS chain's bundle. A
        // coin with no BRIDGE_<COIN> address configured has no escrow to lock into, so the
        // destination is refused rather than the balance being credited to a null address.
        let escrow = (this.config['ADDRESS'] || {})['BRIDGE_' + String(dest)];
        if(this.util.isNull(escrow))
            return { valid: false, verdict: VERDICTS.DEST_COIN };

        // Coin-and-network-aware, the call swap.js already makes for a foreign GET_ADDRESS.
        // A mint on a mis-validated address is a permanent loss, which is why this is the
        // full base58check / bech32 validator and not a shape heuristic.
        if(!this.util.isCryptoAddress(data['DEST_ADDRESS'], String(dest), ctx.network))
            return { valid: false, verdict: VERDICTS.DEST_ADDRESS };

        // A positive decimal with at most the token's own DECIMALS fractional digits.
        if(this.util.isNull(data['AMOUNT']) ||
           !this.util.isValidAmountFormat(info['DECIMALS'], data['AMOUNT'], ctx.blockTime) ||
           !this.util.bcgt(data['AMOUNT'], 0))
            return { valid: false, verdict: VERDICTS.AMOUNT };

        let allowed = await this._validateSourceAllowed(data, ctx);
        if(!allowed.valid)
            return allowed;

        let memo = this._validateMemo(data);
        if(!memo.valid)
            return memo;

        if(!this.util.hasBalance(ctx.sourceBalance, info['TICK_ID'], data['AMOUNT']))
            return { valid: false, verdict: VERDICTS.INSUFFICIENT_FUNDS };

        // The lock stamps what the hub will sign and what the federation will wait for, as
        // read at THIS block. DECIMALS is signed into the transfer record; MIN_DEPTH is
        // not signed at all, it is carried beside the pending row so each validator's own
        // poll applies max(platform depth, min_depth) without re-reading the origin row.
        data['DECIMALS']   = info['DECIMALS'];
        data['MIN_DEPTH']  = (info['MIN_DEPTH'] && this.util.isNumeric(info['MIN_DEPTH'])) ? parseInt(info['MIN_DEPTH']) : 0;
        data['DEST_CHAIN'] = String(dest);

        // Ledger effect: the units leave the source and sit in the keyless escrow on this
        // chain. No escrow ROW is written - the escrow is an ordinary balance at a protocol
        // role address - so the escrow journal's totality contract is untouched, and the
        // held units reconcile in db.sanityCheck and ride balances_root for free.
        ctx.escrow = escrow;
        this.util.addAddressTicker(escrow, ctx.tick);
        ctx.debits.push([ctx.tick, data['AMOUNT'], data['SOURCE']]);
        ctx.credits.push([ctx.tick, data['AMOUNT'], escrow]);

        // Reduce the in-memory balance so the protocol fee, which on BTC is paid out of
        // this same XCHAIN balance for a v0 lock, cannot be covered by units this lock
        // already moved.
        ctx.sourceBalance = this.util.debitBalances(ctx.sourceBalance, info['TICK_ID'], data['AMOUNT']);

        return { valid: true, verdict: null };
    }

    /**
     * Apply a BURN: v1 (XCHAIN, every chain except BTC) and v4 (a bridged row, on the
     * chain holding the copy).
     *
     * EFFECT, identical for both versions:
     *   debit(SOURCE, tick, AMOUNT)
     *   token SUPPLY -= AMOUNT on THIS chain (the DESTROY supply path)
     * Fee: XBRIDGE_BASE, 5,000 gas, paid in native coin off BTC, which on LTC and DOGE
     * means a fee output that clears the chain's dust threshold - the sizing SWEEP_BASE was
     * chosen for.
     *
     * The burn lowers only the LOCAL chain's supply. MAX_SUPPLY binds on the origin chain
     * only: a foreign chain's supply is a shadow of the origin escrow and is never counted
     * against the cap.
     *
     * For v4 the origin chain is the tick's prefix (<ORIGIN>.<NAME>) and ORIGIN_ADDRESS is
     * validated against it with isCryptoAddress(address, origin, network); a v4 on a native
     * row is TICK_NOT_BRIDGED. Removing a chain from an origin row's BRIDGE_CHAINS stops
     * new locks and never blocks a burn, so an issuer can close a door but never strand
     * anyone.
     *
     * @param {Object} data - the action row. Reads FORMAT, SOURCE, TICK (v4 only),
     *                        BTC_ADDRESS (v1) or ORIGIN_ADDRESS (v4), AMOUNT, MEMO,
     *                        BLOCK_INDEX, BLOCK_TIME, ACTION_INDEX; writes STATUS
     * @param {Object} ctx  - handler context: { coin, network, blockIndex, blockTime,
     *                        tokenInfo, sourceBalance }
     * @returns {Promise<{valid: boolean, verdict: (string|null)}>} verdict is one of
     *          VERDICTS.TICK_NOT_BRIDGED, BTC_ADDRESS, ORIGIN_ADDRESS, AMOUNT,
     *          INSUFFICIENT_FUNDS, or null when the burn applies
     */
    async applyBurn(data, ctx){

        let format = data['FORMAT'];
        let info   = ctx.tokenInfo;

        if(!info)
            return { valid: false, verdict: TICK_UNKNOWN };

        if(format === 4){
            // The copy must be owned by THIS chain's keyless bridge role address for the
            // origin chain. A row with the right shape but another owner is a squatted name
            // that predates the reserved-root guard, not a bridged copy, and burning it
            // would lower a supply no escrow backs.
            let owner = (this.config['ADDRESS'] || {})['BRIDGE_' + String(ctx.origin)];
            if(this.util.isNull(owner) || String(info['OWNER']) !== String(owner))
                return { valid: false, verdict: VERDICTS.TICK_NOT_BRIDGED };

            // ORIGIN_ADDRESS is where the escrow releases on the origin chain, so it is
            // validated against the ORIGIN's address parameters, not this chain's.
            if(!this.util.isCryptoAddress(data['ORIGIN_ADDRESS'], String(ctx.origin), ctx.network))
                return { valid: false, verdict: VERDICTS.ORIGIN_ADDRESS };

            data['DEST_CHAIN'] = String(ctx.origin);
        } else {
            // v1 always redeems to BTC: XCHAIN's escrow is the BTC-side role address.
            if(!this.util.isCryptoAddress(data['BTC_ADDRESS'], 'BTC', ctx.network))
                return { valid: false, verdict: VERDICTS.BTC_ADDRESS };

            data['DEST_CHAIN'] = 'BTC';
        }

        if(this.util.isNull(data['AMOUNT']) ||
           !this.util.isValidAmountFormat(info['DECIMALS'], data['AMOUNT'], ctx.blockTime) ||
           !this.util.bcgt(data['AMOUNT'], 0))
            return { valid: false, verdict: VERDICTS.AMOUNT };

        let allowed = await this._validateSourceAllowed(data, ctx);
        if(!allowed.valid)
            return allowed;

        let memo = this._validateMemo(data);
        if(!memo.valid)
            return memo;

        if(!this.util.hasBalance(ctx.sourceBalance, info['TICK_ID'], data['AMOUNT']))
            return { valid: false, verdict: VERDICTS.INSUFFICIENT_FUNDS };

        data['DECIMALS']  = info['DECIMALS'];
        data['MIN_DEPTH'] = 0;

        // Ledger effect: a debit with no offsetting credit. updateTokens then recomputes
        // this chain's SUPPLY from the ledger (credits - debits + escrows), which is the
        // DESTROY supply path verbatim. Only the LOCAL supply moves: a foreign chain's
        // supply is a shadow of the origin escrow, and MAX_SUPPLY binds on the origin only.
        ctx.debits.push([ctx.tick, data['AMOUNT'], data['SOURCE']]);
        ctx.sourceBalance = this.util.debitBalances(ctx.sourceBalance, info['TICK_ID'], data['AMOUNT']);

        return { valid: true, verdict: null };
    }
}

XBridge.VERDICTS = VERDICTS;

module.exports = XBridge;
