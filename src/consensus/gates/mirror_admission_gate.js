'use strict';

const { get, copy, activeAt } = require('../gate_registry');

/*
 * mirror_admission_gate.js - admission by height for the mirror barrier family.
 *
 * BYTE-IDENTICAL TWIN. The canonical copy is xchain-indexer/src/; xchain-hub/src/ and
 * xchain-explorer/src/ carry it byte for byte, so edit the indexer copy and copy it outward.
 * reconcile-twins.sh --check grades both pairs. The explorer pair is also held by
 * xchain-indexer/bin/sync-hub-mirror-client.sh --check (cmp -s); the hub pair by the byte
 * compare in the activation-constants parity suite, which skips without a sibling checkout
 * unless XCHAIN_REQUIRE_SIBLINGS=1 and also holds the exported constants value-identical to
 * xchain-documentation/protocol/constants.js. A one-sided edit forks consensus at the boundary.
 *
 * ONE REQUIRE, DELIBERATELY. This module is a DEP_FILES entry of sync-hub-mirror-client.sh,
 * vendored into the explorer beside hub_db_sync.js, so it requires only ../gate_registry, which
 * every consumer carries (price_batching_floor_gate.js is the precedent). Threading an
 * admission bound through eleven predicate signatures was considered and rejected.
 *
 * WHAT THIS IS FOR
 *
 * Eleven barrier hold points in the indexer block loop key on the block's protocol timestamp
 * t(B). Bitcoin accepts a block stamped up to 7200 s ahead of network-adjusted time, so a VALID
 * block holds a hub-connected indexer's block loop for that distance plus grace, while /status
 * reports the healthy 'future_block_wait' verdict throughout.
 *
 * No grace fixes this. A mirrored row binds at B when its signed effective_time <= t(B), and a
 * producer may mint such a row at any wall-clock instant up to t(B) - RELAY_MIN_FUTURE_S, so the
 * SET of rows binding at B is undetermined until wall clock reaches that instant.
 *
 * So the binding rule changes. Every mirrored row carries a signed ADMISSION HEIGHT per chain
 * that reads it; a row is readable at B on chain C only when admit_blocks[C] <= B; and each
 * barrier compares a per-table per-chain HEIGHT watermark against B rather than a clock against
 * t(B). A block stamped 7200 s ahead is height B like any other.
 */

// Margins
const ADMIT_MARGIN_BLOCKS = get('mirror_admission_activation.ADMIT_MARGIN_BLOCKS');

const ADMIT_MIN_FUTURE_BLOCKS = copy('mirror_admission_activation.ADMIT_MIN_FUTURE_BLOCKS');

const ADMIT_MAX_FUTURE_BLOCKS = get('mirror_admission_activation.ADMIT_MAX_FUTURE_BLOCKS');

// Activation maps
const MIRROR_ADMISSION_REGTEST_ENV = copy('mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ENV');
const MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT = copy('mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT');

/**
 * Resolve the regtest admission activation from the environment.
 *
 * The armed form resolves to 0 so a drill block sits ABOVE an armed node's threshold and BELOW
 * an inert node's null, the only per-process arming seam, which lets one venue carry an armed
 * and an inert indexer. Fails closed: anything unrecognised leaves regtest INERT and says so.
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

const MIRROR_ADMISSION_ACTIVATION = get('mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION');

const MIRROR_ADMISSION_CONSUMER_ACTIVATION = get('mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION');

// Predicates: every one fails CLOSED, and INERT is today's behaviour byte for byte.
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
 * `Number()` fails OPEN: `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are 0 and
 * `Number(true)` is 1, so each passes `Number.isFinite` and compares as a real height. On a
 * venue armed at 0 that made `isMirrorAdmissionProducerActive('BTC','regtest', null)` TRUE.
 * So a number must be finite and a string must be all digits.
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
 * would arm every null key at 0. The Number.isFinite guard on the THRESHOLD stops that and is
 * the most important line here; `_readHeight` on the HEIGHT closes the mirror image.
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
 * responses), never the consumer's height, so the two eras never share a signature.
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
 * An unknown table takes the default rather than throwing.
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
 * as the seconds-axis blockIntervalS does, so the two axes agree.
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
 * given that follower's own tip?
 *
 * The window is [ownTip + ADMIT_MIN_FUTURE_BLOCKS, ownTip + admitMaxFutureBlocks(chain)]. The
 * absolute time bounds on effective_time stay: a follower refuses on BOTH axes, so a broken hub
 * clock and a wrong hub tip are each caught by the axis that sees them.
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
 * LEGACY-ROW RULE, at every height: a row with no admission height for C (finalized below the
 * producer activation, or its map does not name C) binds by effective_time <= t(B) as today.
 * That is the fail-closed direction and makes a chain added after a row was signed safe.
 *
 * The SQL form is:
 *
 *   (admit_block_<c> IS NULL AND effective_time <= ?) OR (admit_block_<c> IS NOT NULL AND admit_block_<c> <= ?)
 *
 * never a bare `admit_block_<c> <= ?` on a nullable column, which is NULL for legacy rows,
 * silently drops them, and changes consensus.
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

// Canonical admission map encoding, kept in the twin
/*
 * The hub SIGNS the admission field and every indexer REBUILDS it to verify, so the encoder is a
 * consensus byte-twin like the activation heights above it. Two copies of a function could drift
 * while every constants parity suite stayed green; one definition per repo, held byte-identical,
 * rules that out.
 *
 * As attest_response_canonical.js explains, a bare concatenation is ambiguous, so an appended
 * field needs a '|' separator and a canonical integer spelling. A map has internal structure
 * that could be re-split, so three properties make the encoding injective:
 *
 *   1. The chain-code vocabulary is CLOSED upper-case alphanumerics, so no ':' ',' or '|' can
 *      occur in a code and no alternative split moves a delimiter.
 *   2. Every height is canonically spelled ('007' never appears), so 'BTC:1,X:23' and
 *      'BTC:12,X:3' differ.
 *   3. Codes are in ASCII order, so a map has one encoding rather than an insertion-order one.
 */

const CHAIN_CODE_RE = copy('mirror_admission_activation.CHAIN_CODE_RE');

const CANONICAL_HEIGHT_RE = copy('mirror_admission_activation.CANONICAL_HEIGHT_RE');

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
 * Strict on purpose: it is the executable statement of the encoder's injectivity claim. The
 * suites round-trip every encoded map and refuse every non-canonical variant (leading zeros,
 * out-of-order or repeated codes, an empty field).
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
 * Keyed on the ROW's own BTC block (snapshot_block, the request block for attest responses, the
 * round's BTC anchor for a price round), never the consumer's height, so the two eras never
 * share a signature. The activation key's COIN is BTC for every rail; only the consumer side
 * arms chain by chain.
 */
function isAdmissionEra(network, eraBlock){
    return isMirrorAdmissionProducerActive('BTC', network, eraBlock);
}

/**
 * The canonical tail for a row's admission map: '' unless the row is at or above the activation
 * and the map is present, else '|' plus the encoded map.
 *
 * A version seam can expose an admission map to an inert node or a legacy row to an armed node;
 * both take the legacy byte path so quorum verification decides. No per-rail canonical version
 * field exists: this height-gated era check is the versioning.
 *
 * @param {string} label the builder's canonical tag, retained for the stable caller API
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
 * activation or when the map is absent. A JSON-shaped canonical (the PRICE batch) carries it
 * under its own key, where a '|' tail would be a byte inside a string. One era gate serves both
 * spellings so their boundary semantics match.
 */
function admissionCanonicalValue(label, network, eraBlock, map){
    let era = isAdmissionEra(network, eraBlock);
    let has = (map !== null && map !== undefined);
    if(!era) return null;
    if(!has) return null;
    return encodeAdmitBlocks(map);
}

// Mirror columns a stored map is read back from
const ADMIT_COLUMN_CHAINS = get('mirror_admission_activation.ADMIT_COLUMN_CHAINS');

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
