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

// ---------------------------------------------------------------------------
// The canonical encoding of an admission map, and why it lives in the TWIN
// ---------------------------------------------------------------------------

/*
 * The hub SIGNS the admission field and every indexer REBUILDS it to verify, so the
 * encoder is a consensus byte-twin exactly like the activation heights above it and
 * belongs beside them. A hub-only encoder plus a second copy in the indexer is the one
 * shape nothing in this tree could hold: every parity suite compares exported
 * CONSTANTS, so two copies of a FUNCTION could drift apart while the whole matrix
 * stayed green. One definition per repo, with the two files held byte-identical, is
 * what makes that drift impossible rather than merely unlikely.
 *
 * attest_response_canonical.js states the rule an appended canonical field must
 * satisfy, from the case it was written for: concatenated bare, `meta="X"
 * effective=1234` and `meta="X1" effective=234` produce identical bytes, so one honest
 * quorum's signatures would validate over two different values. Two things together
 * fix it, and neither alone: a '|' separator, and a canonical integer spelling.
 *
 * A MAP is strictly harder than one integer, because the field itself has internal
 * structure that could be re-split. Three properties make this encoding injective, and
 * the suites in both repos drive all three:
 *
 *   1. The chain-code vocabulary is CLOSED upper-case alphanumerics, so neither ':' nor
 *      ',' nor '|' can occur inside a code, and no alternative split of the field can
 *      move a delimiter.
 *   2. Every height is canonically spelled, so 'BTC:1,X:23' and 'BTC:12,X:3' are
 *      different byte strings for different maps, and a map has exactly ONE spelling:
 *      '007' can never appear.
 *   3. Codes are in ASCII order, so {BTC, DOGE} has one encoding rather than two.
 *
 * Without (3) an honest leader and an honest follower could build the same map into
 * different bytes purely from Object key order, which is an insertion-order artefact of
 * how the row was read.
 */

// A chain code is a closed vocabulary: upper-case letters and digits, nothing else. The
// injectivity argument rests on that, so the check lives here and not only in a test.
const CHAIN_CODE_RE = /^[A-Z0-9]{1,10}$/;

// Canonical base-10 spelling of a non-negative integer: digits only, no sign, no leading
// zeros. The rule the hub's lib/canonical_int.js applies to its other signed integers,
// restricted to non-negative because a height never is.
const CANONICAL_HEIGHT_RE = /^(?:0|[1-9][0-9]*)$/;

/**
 * Encode an admission map as canonical bytes: `CODE:digits` joined by ',', codes in
 * ASCII order. Throws on anything it cannot spell canonically, because an unspellable
 * map must never reach a signature.
 */
function encodeAdmitBlocks(map){
    if(!map || typeof map !== 'object')
        throw new Error('mirror_admission_activation: cannot encode a non-object admission map');
    let codes = Object.keys(map);
    if(codes.length === 0)
        throw new Error('mirror_admission_activation: refusing to encode an EMPTY admission map; a row with no ' +
            'admission height on any chain is a legacy row, and a legacy row carries no field at all');

    let parts = [];
    for(let code of codes.slice().sort()){
        if(!CHAIN_CODE_RE.test(code))
            throw new Error('mirror_admission_activation: chain code ' + JSON.stringify(code) +
                ' is outside the closed vocabulary the encoding is injective over');
        let v = map[code];
        // Checked on the RAW spelling, never on Number(v): coercing first hides the
        // spelling under test, exactly as the hub's lib/canonical_int.js explains.
        let s = (typeof v === 'number') ? (Number.isSafeInteger(v) ? String(v) : null)
              : (typeof v === 'string') ? v : null;
        if(s === null || !CANONICAL_HEIGHT_RE.test(s))
            throw new Error('mirror_admission_activation: admit_blocks[' + code + '] = ' + JSON.stringify(v) +
                ' is not a canonically spelled non-negative integer height');
        parts.push(code + ':' + s);
    }
    return parts.join(',');
}

/**
 * Decode canonical admission bytes back to a map, or null when the bytes are not the
 * unique canonical encoding of any map.
 *
 * The decoder is strict on purpose: it is the executable statement of what the encoder's
 * injectivity claim means. Round-tripping every encoded map and refusing every
 * non-canonical variant (leading zeros, out-of-order codes, a repeated code, an empty
 * field) is what the suites check, and a decoder that accepted variants would make that
 * check vacuous.
 */
function decodeAdmitBlocks(field){
    if(typeof field !== 'string' || field === '') return null;
    let parts = field.split(',');
    let map = {};
    let prev = null;
    for(let p of parts){
        let m = /^([A-Z0-9]{1,10}):((?:0|[1-9][0-9]*))$/.exec(p);
        if(!m) return null;
        let code = m[1];
        if(prev !== null && !(code > prev)) return null;   // out of order, or a repeat
        prev = code;
        let h = Number(m[2]);
        if(!Number.isSafeInteger(h)) return null;
        map[code] = h;
    }
    return map;
}

/**
 * Is this row in the admission era?
 *
 * Keyed on the ROW's own BTC block (snapshot_block for matches, calls, bridge transfers
 * and policy snapshots; the request's block for attest responses; the round's BTC anchor
 * for a price round) and never on a consumer's height, so the rule for a given row is
 * fixed the moment it is produced and the two eras can never share a signature.
 *
 * The activation key's COIN is BTC for every rail, because every one of those era blocks
 * IS a BTC height. The map is keyed by (coin, network) so the CONSUMER side can arm chain
 * by chain; the producer side reads the BTC key.
 */
function isAdmissionEra(network, eraBlock){
    return isMirrorAdmissionProducerActive('BTC', network, eraBlock);
}

/**
 * The canonical tail for a row's admission map: '' below the activation, and '|' plus the
 * encoded map at or above it.
 *
 * REFUSES IN BOTH DIRECTIONS, exactly as AttestationConsensus._buildCanonical does for
 * the mirror era. Building a legacy canonical for a modern row strands the row (its
 * signatures reproduce over bytes no verifier rebuilds); building a modern canonical for
 * a legacy row forks a from-genesis replay. Neither can be recovered from downstream, so
 * both throw where the caller that got it wrong is still on the stack.
 *
 * No per-rail canonical VERSION field is minted for this, and none exists anywhere in the
 * tree: this height-gated era check IS the versioning, and a version integer would
 * duplicate the gate while giving a Byzantine leader a second field to disagree about.
 *
 * @param {string} label the builder's canonical tag, for the refusal message
 * @param {string} network the row's network, half the activation key
 * @param {number} eraBlock the ROW's own BTC block
 * @param {object|null} map the row's admission map, or null for a legacy row
 * @returns {string} '' or '|' + encodeAdmitBlocks(map)
 */
function admissionCanonicalField(label, network, eraBlock, map){
    let value = admissionCanonicalValue(label, network, eraBlock, map);
    return value === null ? '' : '|' + value;
}

/**
 * The admission map as a canonical VALUE rather than a pipe-appended tail: null below the
 * activation, the encoded map at or above it, with the same two refusals as the field
 * form. This is the spelling a JSON-shaped canonical (the PRICE batch) carries under its
 * own key, where a '|' tail would be a byte inside a string rather than a delimiter. One
 * era gate for both spellings, so the two carriers can never disagree about which era a
 * row is in.
 */
function admissionCanonicalValue(label, network, eraBlock, map){
    let era = isAdmissionEra(network, eraBlock);
    let has = (map !== null && map !== undefined);
    if(era && !has)
        throw new Error(label + ': admission-era row at block ' + String(eraBlock) + ' on ' + String(network) +
            ' has no admit_blocks; refusing to build a legacy canonical');
    if(!era && has)
        throw new Error(label + ': legacy-era row at block ' + String(eraBlock) + ' on ' + String(network) +
            ' was handed admit_blocks ' + JSON.stringify(map) + '; refusing to build an admission-era canonical');
    if(!era) return null;
    return encodeAdmitBlocks(map);
}

// ---------------------------------------------------------------------------
// The mirror columns a stored map is read back from
// ---------------------------------------------------------------------------

// One nullable BIGINT UNSIGNED column per chain the federation serves (C28), spelled
// `admit_block_<code lower-cased>` in every mirror table's DDL. The hub writes them at
// finalization and every mirror client reads them back to rebuild the signed field, so the
// list lives in the twin rather than on one side: a chain the hub writes and an indexer does
// not read back is a row every indexer refuses (the rebuilt field misses a chain and no
// signature verifies), fail-closed but still an outage. Adding a chain adds it here and in
// the mirror .sql twins; it does NOT make rows signed before that chain existed admissible
// on it (C38), which is why the map is read from the columns actually set and never from
// this list.
const ADMIT_COLUMN_CHAINS = Object.freeze(['BTC', 'LTC', 'DOGE']);

/**
 * The admission map a stored or mirrored row carries in its per-chain columns, or null
 * for a legacy row (every column NULL or absent). Throws on a column that is set but is
 * not a usable height, because a row whose stored map cannot be spelled must never reach
 * a canonical: refusing here keeps the bad row out of every signature check downstream.
 */
function columnsAdmitBlocks(row){
    let r = row || {};
    let map = null;
    for(let c of ADMIT_COLUMN_CHAINS){
        let v = r['admit_block_' + c.toLowerCase()];
        if(v === null || v === undefined) continue;
        let h = Number(v);
        if(!Number.isSafeInteger(h) || h < 0)
            throw new Error('mirror_admission_activation: admit_block_' + c.toLowerCase() + ' = ' +
                JSON.stringify(v) + ' is not a usable admission height');
        if(map === null) map = {};
        map[c] = h;
    }
    return map;
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
    CHAIN_CODE_RE,
    CANONICAL_HEIGHT_RE,
    encodeAdmitBlocks,
    decodeAdmitBlocks,
    isAdmissionEra,
    admissionCanonicalField,
    admissionCanonicalValue,
    ADMIT_COLUMN_CHAINS,
    columnsAdmitBlocks,
};
