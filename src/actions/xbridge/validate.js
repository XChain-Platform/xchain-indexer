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
 * The XBRIDGE guards that answer from wire bytes plus node-uniform config alone:
 * the version byte, the activation gate, the chain rule, the TICK shape, the MEMO
 * fields and the source's sleep / list state. They are the checks the handler runs
 * BEFORE any token or balance read, which is what keeps the index-ticker id counter
 * identical on every node, so they are kept together in one file.
 *
 * Every function here is the method that used to sit on the handler class, moved
 * verbatim: the two that need handler state (config, util, indexerDb) are invoked
 * with `.call(this, ...)` from index.js, the way execute/slash_emission.js is.
 *
 ********************************************************************/

'use strict';

// The two bridge flag days are registry rows read by literal key (W5).
const gateRegistry = require('../../consensus/gate_registry');
const XCHAIN_BRIDGE_KEY = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
const TOKEN_BRIDGE_KEY  = 'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION';

const v = require('./verdicts.js');
const VERDICTS = v.VERDICTS;

// Version bytes this build knows. `this.formats` holds only the four USER formats, so it
// cannot answer "is this a known version": v2 and v5 are mirror-injected and carry no
// wire format, yet a broadcast of one is refused BY NAME rather than as an unknown
// version, which is the whole point of the two V*_SYSTEM_INJECTED verdicts.
const USER_VERSIONS     = [0, 1, 3, 4];
const INJECTED_VERSIONS = [2, 5];

// v0/v1/v2 are the XCHAIN bridge and gate on XCHAIN_BRIDGE_ACTIVATION (keyed
// '<COIN>:<network>'); v3/v4/v5 are the general token bridge and gate on
// TOKEN_BRIDGE_ACTIVATION (also '<COIN>:<network>'). The parity test pins TOKEN >= XCHAIN for every
// chain key, so a chain can never admit v3 without an engine behind it.
const TOKEN_VERSIONS    = [3, 4, 5];

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
 *                        BTC_ONLY versus V1_NOT_ON_BTC and, with `network`, keys the
 *                        XCHAIN activation map ('<COIN>:<network>', bare network as the
 *                        fallback); the token map is network-keyed and ignores the coin
 * @returns {{valid: boolean, verdict: (string|null)}} verdict is one of
 *          VERDICTS.BEFORE_ACTIVATION, UNKNOWN_VERSION, BTC_ONLY, V1_NOT_ON_BTC,
 *          V2_SYSTEM_INJECTED, V5_SYSTEM_INJECTED, or null when the format passes
 */
function validateFormat(data, ctx){

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
    //
    // Both bridge maps are keyed '<COIN>:<network>', so the coin goes with the height: BTC,
    // LTC and DOGE reach the bridge at three different heights on one network, and
    // passing the network alone would judge a DOGE block against a BTC number.
    let active = (TOKEN_VERSIONS.indexOf(format) !== -1)
        ? gateRegistry.activeAt(TOKEN_BRIDGE_KEY, ctx.network, ctx.coin, ctx.blockIndex, null)
        : gateRegistry.activeAt(XCHAIN_BRIDGE_KEY, ctx.network, ctx.coin, ctx.blockIndex, null);
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
    // which validateTickShape decides.
    if(format === 0 && ctx.coin !== 'BTC')
        return { valid: false, verdict: VERDICTS.BTC_ONLY };
    if(format === 1 && ctx.coin === 'BTC')
        return { valid: false, verdict: VERDICTS.V1_NOT_ON_BTC };

    return { valid: true, verdict: null };
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
 * Called with the handler as `this` (it reads this.util and this.config).
 *
 * @param {number} format - the version byte (0, 1, 3 or 4)
 * @param {Object} ctx    - the handler context; reads ctx.tick and ctx.coin
 * @returns {{valid: boolean, verdict: (string|null), origin: (string|null)}}
 */
function validateTickShape(format, ctx){
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

    return validateNativeTickShape.call(this, tick, parsed, ctx, pass);
}

/**
 * The v3 half of the TICK shape guard, in the token spec's own precedence order: a
 * rooted name, the GAS tick, a dotted name, then the rooted-length bound. Split out of
 * validateTickShape so each half stays readable; the order and the verdicts are the
 * ones the handler shipped with.
 *
 * Called with the handler as `this` (it reads this.config).
 *
 * @param {string}      tick   - the wire TICK
 * @param {Object|null} parsed - parseBridgedTick(tick, coin): non-null means a bridged copy
 * @param {Object}      ctx    - the handler context; reads ctx.coin
 * @param {Object}      pass   - the shared "no refusal" answer validateTickShape returns
 * @returns {{valid: boolean, verdict: (string|null), origin: (string|null)}}
 */
function validateNativeTickShape(tick, parsed, ctx, pass){

    // A lock names a NATIVE row. A rooted name is a bridged copy: burn it with v4.
    if(parsed)
        return { valid: false, verdict: VERDICTS.TICK_NOT_NATIVE, origin: null };

    // XCHAIN keeps v0. Case-folded because every ticker lookup is LOWER(tick), so
    // `xchain` and `XCHAIN` reach one row and must reach one verdict.
    if(String(tick).toUpperCase() === String(this.config['GAS']).toUpperCase())
        return { valid: false, verdict: VERDICTS.TICK_USE_V0, origin: null };

    // A dotted native name cannot be rooted: the parent split takes everything before
    // the LAST dot, so `BTC.PEPE.CASH` would need a `BTC.PEPE` row the bridge never
    // creates. Lifting this needs a prefix walk the bridge does not implement.
    // This also catches a subasset of THIS chain's own coin root, which parseBridgedTick
    // deliberately returns null for.
    if(String(tick).indexOf('.') !== -1)
        return { valid: false, verdict: VERDICTS.TICK_SUBASSET, origin: null };

    // The rooted form on the destination is `<THIS COIN>.<TICK>`, so a native tick
    // longer than MAX_TICK_LENGTH minus the root and the dot cannot be bridged at all
    // (246 characters for BTC and LTC, 245 for DOGE). Refused at lock time so no
    // transfer can strand on the destination.
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
 * Called with the handler as `this` (it reads this.indexerDb).
 *
 * @param {Object} data - the action row; reads SOURCE and BLOCK_INDEX
 * @param {Object} ctx  - the handler context; reads ctx.tick
 * @returns {Promise<{valid: boolean, verdict: (string|null)}>}
 */
async function validateSourceAllowed(data, ctx){
    if(await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        return { valid: false, verdict: v.SOURCE_SLEEPING };
    if(await this.indexerDb.isActionAllowed(null, ctx.tick, data['BLOCK_INDEX']) == false)
        return { valid: false, verdict: v.TICK_SLEEPING };
    if(await this.indexerDb.isActionAllowed(data['SOURCE'], ctx.tick) == false)
        return { valid: false, verdict: v.SOURCE_UNAUTHORIZED };
    return { valid: true, verdict: null };
}

/**
 * MEMO checks, byte-identical to the ones send.js / destroy.js / dividend.js run.
 * The length bound is the one that matters here: MEMO is stored, and a value past
 * MAX_MEMO_LENGTH would be truncated by the column rather than refused, which is a
 * verdict that depends on the database rather than on the chain.
 *
 * Called with the handler as `this` (it reads this.util and this.config).
 *
 * @param {Object} data - the action row; reads MEMO
 * @returns {{valid: boolean, verdict: (string|null)}}
 */
function validateMemo(data){
    if(!this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|') != -1)
        return { valid: false, verdict: v.MEMO_PIPE };
    if(!this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';') != -1)
        return { valid: false, verdict: v.MEMO_SEMICOLON };
    if(String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
        return { valid: false, verdict: v.MEMO_LENGTH };
    return { valid: true, verdict: null };
}

/**
 * Is `destCoin` in the origin row's BRIDGE_CHAINS opt-in list? Default is OFF:
 * an unset, empty or `-` field bridges nowhere. The list is a comma list of
 * destination coins stored as the raw wire string, compared verbatim so the refusal
 * matches what the issuer actually wrote.
 *
 * Called with the handler as `this` (it reads this.util).
 *
 * @param {Object} info     - the origin row's getTokenInfo projection
 * @param {string} destCoin - the requested destination coin
 * @returns {boolean}
 */
function isBridgeableTo(info, destCoin){
    let raw = (info) ? info['BRIDGE_CHAINS'] : null;
    if(this.util.isNull(raw) || String(raw) === '' || String(raw) === '-')
        return false;
    return String(raw).split(',').indexOf(String(destCoin)) !== -1;
}

module.exports = {
    USER_VERSIONS,
    INJECTED_VERSIONS,
    TOKEN_VERSIONS,
    validateFormat,
    validateTickShape,
    validateSourceAllowed,
    validateMemo,
    isBridgeableTo
};
