'use strict';

const { get, copy } = require('../../gate_registry');

function create(){
    // ---------------------------------------------------------------------------
    // Margins
    // ---------------------------------------------------------------------------

    const ADMIT_MARGIN_BLOCKS = get('mirror_admission_activation.ADMIT_MARGIN_BLOCKS');

    const ADMIT_MIN_FUTURE_BLOCKS = copy('mirror_admission_activation.ADMIT_MIN_FUTURE_BLOCKS');

    const ADMIT_MAX_FUTURE_BLOCKS = get('mirror_admission_activation.ADMIT_MAX_FUTURE_BLOCKS');


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

    return {
        ADMIT_MARGIN_BLOCKS,
        ADMIT_MIN_FUTURE_BLOCKS,
        ADMIT_MAX_FUTURE_BLOCKS,
        _readHeight,
        admitMarginBlocks,
        admitMaxFutureBlocks,
        isAdmitBlockInFollowerBound,
        isRowReadableAt,
    };
}

module.exports = { create };
