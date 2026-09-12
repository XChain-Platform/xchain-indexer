'use strict';
/*
 * mirror_admission_activation.js - admission by height for the mirror barrier family.
 *
 * BYTE-IDENTICAL TWIN. This file exists at xchain-indexer/src/, xchain-hub/src/ and, once
 * vendored, xchain-explorer/src/. The three copies are held identical by
 * bin/sync-hub-mirror-client.sh --check (a cmp -s byte compare, not a digest) and the
 * exported constants are held value-identical to xchain-documentation/protocol/constants.js
 * by the activation-constants parity suite. A one-sided edit forks consensus at the boundary.
 *
 * ZERO REQUIRES, DELIBERATELY. This module is a CLIENT_FILES entry: it is vendored into the
 * explorer beside hub_db_sync.js, which can carry no dependency the explorer does not have.
 * price_batching_floor_activation.js is the precedent. The alternative considered and
 * rejected was threading an admission bound through eleven predicate signatures, their
 * waiters and every call site.
 *
 * WHAT THIS IS FOR
 *
 * Eleven barrier hold points in the indexer block loop key on the block's own protocol
 * timestamp t(B). Bitcoin consensus accepts a block stamped up to 7200 s ahead of
 * network-adjusted time, so a VALID block holds a hub-connected indexer's whole block loop
 * for that distance plus the member's grace, while /status reports the deliberately healthy
 * 'future_block_wait' verdict for the entire stall.
 *
 * No grace can fix this. A mirrored row binds at B when its signed effective_time <= t(B),
 * and a producer may mint such a row at any wall-clock instant up to t(B) - RELAY_MIN_FUTURE_S,
 * so the SET of rows binding at B is not determined until wall clock reaches that instant.
 * Any correct barrier under that binding rule must wait for it, whatever its grace.
 *
 * So the binding rule changes. Every mirrored row carries a signed ADMISSION HEIGHT per chain
 * that reads it; a row is readable at B on chain C only when admit_blocks[C] <= B; and each
 * barrier certifies completeness by comparing a per-table per-chain HEIGHT watermark against B
 * rather than a clock against t(B). Heights do not move with stamps, so a block stamped 7200 s
 * ahead is height B like any other.
 */

// ---------------------------------------------------------------------------
// Margins
// ---------------------------------------------------------------------------

// How far ahead of the producer's observed admission tip a row is stamped, in BLOCKS of each
// chain in its map. Not a new number: producers already size their forward margin as 4 blocks
// of the gating chain and then CONVERT it to seconds. On the admission axis the conversion is
// deleted, which is why an unknown chain needs no nominal block interval here at all.
const ADMIT_MARGIN_BLOCKS = Object.freeze({
    default:                      4,
    attestation_responses:        1,    // their 120 s forward margin was chosen to be as SHORT as propagation allows
    oracle_prices:                1,    // effective_at stays the economic filter; admission is what the barrier certifies
    anchor_reward_attestations: 144,    // the existing ANCHOR_REWARD_MIRROR_MATURITY, already frozen fleet-wide
});

// A row may never be admissible at a block that already exists, or a producer could backdate
// a row into a block its peers have already committed.
const ADMIT_MIN_FUTURE_BLOCKS = 1;

// The follower's upper bound, PER CHAIN, sized so each chain's height window spans the same
// 3600 s the existing absolute effective_time ceiling already allows: ceil(3600 / interval).
//
// A flat block count here would be a silent tightening. Six blocks is an hour on BTC but six
// minutes on DOGE, so a flat [tip + 1, tip + 6] would collapse clock-skew tolerance from
// 3600 s to 360 s on DOGE and refuse honest rows between hubs whose tips differ by three blocks.
const ADMIT_MAX_FUTURE_BLOCKS = Object.freeze({
    BTC:      6,
    LTC:     24,
    DOGE:    60,
    default:  6,
});

// ---------------------------------------------------------------------------
// The activation maps
// ---------------------------------------------------------------------------

const MIRROR_ADMISSION_REGTEST_ENV = 'XC_MIRROR_ADMISSION_ACTIVATION';
const MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT = 0;

/**
 * Resolve the regtest admission activation from the environment.
 *
 * The armed form resolves to 0 so a drill block sits ABOVE an armed node's threshold and BELOW
 * an inert node's null. That is the only per-process arming seam the codebase has, and it is
 * what lets one venue carry an armed and an inert indexer and show them binding the same row at
 * different blocks. Fails closed: anything unrecognised leaves regtest INERT and says so,
 * rather than stamping NaN into a height comparison.
 *
 * @param {object} env the process environment, or a stand-in
 * @returns {number|null}
 */
function resolveMirrorAdmissionRegtest(env){
    let raw = (env || {})[MIRROR_ADMISSION_REGTEST_ENV];
    if(raw === undefined || raw === null) return null;
    let s = String(raw).trim().toLowerCase();
    if(s === '' || s === 'off' || s === 'inert' || s === 'false' || s === 'no' || s === 'none') return null;
    if(s === 'armed' || s === 'genesis' || s === 'on' || s === 'true' || s === 'yes')
        return MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT;
    if(/^\d+$/.test(s)){
        let h = parseInt(s, 10);
        if(Number.isFinite(h) && h >= 0) return h;
    }
    console.error('MIRROR ADMISSION: ignoring ' + MIRROR_ADMISSION_REGTEST_ENV + '=' +
                  JSON.stringify(String(raw)) + '; regtest stays INERT. Expected a non-negative ' +
                  'height, "armed", or "off".');
    return null;
}

/*
 * TWO maps, one module, with an ordering rule that is the whole point: every PRODUCER height is
 * sized strictly BELOW its CONSUMER height for the same key, so no row is ever produced legacy
 * and read modern. Get that backwards and a consumer above its height reads an admission column
 * the producer below its own height never wrote, and binds nothing.
 *
 * Keyed by (coin, network), not by network alone. A single per-network height cannot arm a
 * family that binds on every chain: one number is an LTC height on an LTC indexer and a BTC
 * height on a BTC indexer, so the two legs of one cross-chain match would cross the flag day at
 * unrelated instants. The 'COIN:network' key shape is established precedent.
 *
 * Mainnet is null under the 2026-08-29 write hold. Testnet is sized at the release cut from the
 * measured tip plus the roll window plus slack, per key. The v7 HUB_SCHEMA_VERSION roll
 * completes BEFORE any network's activation height: the heights map rides frames carrying no
 * schema_version, so a v7 indexer above the activation against a v6 hub would see no heights at
 * all and defer forever under the fail-closed rule.
 */
const MIRROR_ADMISSION_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,   // SIZED AT THE CUT, strictly below the consumer height for this key
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    'BTC:regtest':  resolveMirrorAdmissionRegtest(process.env),
    'LTC:regtest':  resolveMirrorAdmissionRegtest(process.env),
    'DOGE:regtest': resolveMirrorAdmissionRegtest(process.env),
});

const MIRROR_ADMISSION_CONSUMER_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,   // SIZED AT THE CUT, strictly above the producer height for this key
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    'BTC:regtest':  resolveMirrorAdmissionRegtest(process.env),
    'LTC:regtest':  resolveMirrorAdmissionRegtest(process.env),
    'DOGE:regtest': resolveMirrorAdmissionRegtest(process.env),
});

// ---------------------------------------------------------------------------
// Predicates. Every one fails CLOSED, and INERT is today's behaviour byte for byte.
// ---------------------------------------------------------------------------

/**
 * Build the map key. Coin codes are upper case, network names lower case, both normalised here
 * so a caller passing 'btc' or 'TESTNET' cannot silently miss a key and read INERT.
 */
function admissionKey(coin, network){
    if(coin === null || coin === undefined || network === null || network === undefined) return null;
    let c = String(coin).trim().toUpperCase();
    let n = String(network).trim().toLowerCase();
    if(c === '' || n === '') return null;
    return c + ':' + n;
}

/**
 * Read a height STRICTLY, returning null for anything that is not one.
 *
 * `Number()` is the wrong tool here and the reason is a fail-OPEN, which is the one direction
 * this design may never fail. `Number(null)`, `Number('')`, `Number('   ')`, `Number([])` and
 * `Number(false)` are all 0, and `Number(true)` is 1, so every one of them passes a bare
 * `Number.isFinite` check and then compares as a real height. On a venue armed at 0 that made
 * `isMirrorAdmissionProducerActive('BTC','regtest', null)` return TRUE: an unreadable height
 * arming a consensus flag day. `undefined` and `NaN` fail closed, which is exactly why the hole
 * reads as covered until it is driven.
 *
 * So: a number must actually be a finite number, and a string must be all digits. Nothing else
 * is a height, and an empty array is not the number zero.
 *
 * @returns {number|null} the height, or null when the input is not one
 */
function _readHeight(height){
    if(typeof height === 'number') return Number.isFinite(height) ? height : null;
    if(typeof height === 'string'){
        let s = height.trim();
        if(/^-?\d+$/.test(s)){
            let h = parseInt(s, 10);
            return Number.isFinite(h) ? h : null;
        }
    }
    return null;
}

/**
 * Shared by both predicates. `0 >= null` is true in JavaScript, so a bare `height >= MAP[key]`
 * would arm every null key at height 0. The Number.isFinite guard on the THRESHOLD is what
 * stops that, and it is the single most important line in this file; `_readHeight` on the
 * HEIGHT is the second, and it closes the mirror image of the same trap.
 */
function _activeIn(map, coin, network, height){
    let key = admissionKey(coin, network);
    if(key === null) return false;
    if(!Object.prototype.hasOwnProperty.call(map, key)) return false;   // an unknown chain is INERT, never armed
    let threshold = map[key];
    if(!Number.isFinite(threshold)) return false;                       // null, undefined and NaN are all INERT
    let h = _readHeight(height);
    if(h === null) return false;                                        // an unreadable height never arms a flag day
    return h >= threshold;
}

/**
 * Is the PRODUCER armed for this chain at this height: does a hub stamp an admission map into
 * the signed canonical, and refuse to finalize a row whose map it cannot justify?
 *
 * Evaluated on the ROW's own BTC block (snapshot_block, or the request block for attest
 * responses), never on the consumer's height, so the rule for a given row is fixed the moment
 * it is produced and the two eras never share a signature.
 */
function isMirrorAdmissionProducerActive(coin, network, height){
    return _activeIn(MIRROR_ADMISSION_ACTIVATION, coin, network, height);
}

/**
 * Is the CONSUMER armed: does an indexer on this chain bind mirrored rows by admit_blocks[C]
 * instead of by effective_time <= t(B)?
 */
function isMirrorAdmissionConsumerActive(coin, network, height){
    return _activeIn(MIRROR_ADMISSION_CONSUMER_ACTIVATION, coin, network, height);
}

/**
 * The admission margin for a mirrored table, in blocks of each chain in the row's map.
 * An unknown table takes the default rather than throwing: a table added later without an
 * override should behave like the four that already use the default.
 */
function admitMarginBlocks(table){
    if(table === null || table === undefined) return ADMIT_MARGIN_BLOCKS.default;
    let t = String(table).trim();
    return Object.prototype.hasOwnProperty.call(ADMIT_MARGIN_BLOCKS, t) && t !== 'default'
        ? ADMIT_MARGIN_BLOCKS[t]
        : ADMIT_MARGIN_BLOCKS.default;
}

/**
 * The follower's upper bound in blocks for a chain. An unrecognised chain takes BTC's interval,
 * exactly as the seconds-axis blockIntervalS already does, so the two axes cannot disagree
 * about what an unknown chain is.
 */
function admitMaxFutureBlocks(chain){
    if(chain === null || chain === undefined) return ADMIT_MAX_FUTURE_BLOCKS.default;
    let c = String(chain).trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(ADMIT_MAX_FUTURE_BLOCKS, c) && c !== 'DEFAULT'
        ? ADMIT_MAX_FUTURE_BLOCKS[c]
        : ADMIT_MAX_FUTURE_BLOCKS.default;
}

/**
 * The follower's admission bound: is `admitBlock` an acceptable admission height for `chain`,
 * given that follower's own tip for that chain?
 *
 * The window is [ownTip + ADMIT_MIN_FUTURE_BLOCKS, ownTip + admitMaxFutureBlocks(chain)].
 * This does NOT retire the absolute time bounds on effective_time: a follower refuses on BOTH
 * axes, so a hub with a broken clock and a hub with a wrong tip are each caught by the axis
 * that can actually see them.
 *
 * @returns {boolean} true when the height is inside the window; false for any unreadable input
 */
function isAdmitBlockInFollowerBound(chain, admitBlock, ownTip){
    let h = _readHeight(admitBlock);
    let tip = _readHeight(ownTip);
    if(h === null || tip === null) return false;    // a null tip is not tip zero: see _readHeight
    if(!Number.isInteger(h) || h < 0) return false;
    let lo = tip + ADMIT_MIN_FUTURE_BLOCKS;
    let hi = tip + admitMaxFutureBlocks(chain);
    return h >= lo && h <= hi;
}

/**
 * Is a mirrored row readable at block B on chain C?
 *
 * THE LEGACY-ROW RULE, AND IT HOLDS AT EVERY HEIGHT, not merely below the flag day. A row with
 * no admission height for C, whether because it was finalized below the producer activation or
 * because its map simply does not name C, binds by effective_time <= t(B) exactly as today.
 * That is the fail-closed direction, and it is what makes a chain added to the federation after
 * a row was signed safe by construction rather than silently unbound.
 *
 * The SQL form of this same rule is the shape that matters most in review:
 *
 *   (admit_block_<c> IS NULL AND effective_time <= ?) OR (admit_block_<c> IS NOT NULL AND admit_block_<c> <= ?)
 *
 * and NEVER a bare `admit_block_<c> <= ?` on a nullable column, which evaluates to NULL for
 * legacy rows, silently drops them, and is a silent consensus change. The codebase carries both
 * the written case study of that exact failure and the established IS NULL OR remedy.
 *
 * @param {number|null|undefined} admitBlock the row's admission height for THIS chain, or null
 * @param {number} blockHeight B, this node's block being processed
 * @param {number} effectiveTime the row's signed effective_time
 * @param {number} blockTime t(B), protocol time of B
 */
function isRowReadableAt(admitBlock, blockHeight, effectiveTime, blockTime){
    if(admitBlock === null || admitBlock === undefined){
        let et = _readHeight(effectiveTime), bt = _readHeight(blockTime);
        if(et === null || bt === null) return false;   // an unreadable timestamp never binds a row
        return et <= bt;
    }
    let h = _readHeight(admitBlock), b = _readHeight(blockHeight);
    if(h === null || b === null) return false;
    return h <= b;
}

module.exports = {
    ADMIT_MARGIN_BLOCKS,
    ADMIT_MIN_FUTURE_BLOCKS,
    ADMIT_MAX_FUTURE_BLOCKS,
    MIRROR_ADMISSION_ACTIVATION,
    MIRROR_ADMISSION_CONSUMER_ACTIVATION,
    MIRROR_ADMISSION_REGTEST_ENV,
    MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT,
    resolveMirrorAdmissionRegtest,
    admissionKey,
    isMirrorAdmissionProducerActive,
    isMirrorAdmissionConsumerActive,
    admitMarginBlocks,
    admitMaxFutureBlocks,
    isAdmitBlockInFollowerBound,
    isRowReadableAt,
};
