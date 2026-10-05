'use strict';

const { get } = require('../../gate_registry');

function create(){
    // ---------------------------------------------------------------------------
    // The mirror columns a stored map is read back from
    // ---------------------------------------------------------------------------

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

    return {
        ADMIT_COLUMN_CHAINS,
        columnsAdmitBlocks,
    };
}

module.exports = { create };
