'use strict';

const { copy } = require('../../gate_registry');

function create({ isMirrorAdmissionProducerActive }){
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
     * The canonical tail for a row's admission map: '' unless both the row is at or above the
     * activation and the map is present, and '|' plus the encoded map when both are true.
     *
     * A version seam can expose either an admission map to an inert node or a legacy row to an
     * armed node. Both cases take the legacy byte path so mixed versions can bind the row and
     * let quorum verification decide whether its signatures match. Only an armed node with a
     * present map emits admission bytes.
     *
     * No per-rail canonical VERSION field is minted for this, and none exists anywhere in the
     * tree: this height-gated era check IS the versioning, and a version integer would
     * duplicate the gate while giving a Byzantine leader a second field to disagree about.
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
     * activation or when the map is absent, and the encoded map when the era is armed and the
     * map is present. This is the spelling a JSON-shaped canonical (the PRICE batch) carries
     * under its own key, where a '|' tail would be a byte inside a string rather than a
     * delimiter. One era gate for both spellings keeps their boundary semantics identical.
     */
    function admissionCanonicalValue(label, network, eraBlock, map){
        let era = isAdmissionEra(network, eraBlock);
        let has = (map !== null && map !== undefined);
        if(!era) return null;
        if(!has) return null;
        return encodeAdmitBlocks(map);
    }

    return {
        CHAIN_CODE_RE,
        CANONICAL_HEIGHT_RE,
        encodeAdmitBlocks,
        decodeAdmitBlocks,
        isAdmissionEra,
        admissionCanonicalField,
        admissionCanonicalValue,
    };
}

module.exports = { create };
