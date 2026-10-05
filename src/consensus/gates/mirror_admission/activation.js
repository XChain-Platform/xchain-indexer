'use strict';

const { get, copy } = require('../../gate_registry');

function create({ _readHeight }){
    const MIRROR_ADMISSION_REGTEST_ENV = copy('mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ENV');
    const MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT = copy('mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT');

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

    const MIRROR_ADMISSION_ACTIVATION = get('mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION');

    const MIRROR_ADMISSION_CONSUMER_ACTIVATION = get('mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION');

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

    return {
        MIRROR_ADMISSION_ACTIVATION,
        MIRROR_ADMISSION_CONSUMER_ACTIVATION,
        MIRROR_ADMISSION_REGTEST_ENV,
        MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT,
        resolveMirrorAdmissionRegtest,
        admissionKey,
        isMirrorAdmissionProducerActive,
        isMirrorAdmissionConsumerActive,
    };
}

module.exports = { create };
