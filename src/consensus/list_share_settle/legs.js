'use strict';

const { LIST_SHARE_TX_PREFIX, LIST_SHARE_LEG_ORDINAL } = require('./halt.js');
const { LIST_EDIT_ADD, LIST_EDIT_REMOVE } = require('../bridge_settle/reasons.js');

function planListShareLegs({ seq, listType, added, removed, mirrorIndex }){
    if(!Number.isSafeInteger(seq) || seq <= 0)
        throw new TypeError('seq must be a positive safe integer');
    if(!Array.isArray(added)) throw new TypeError('added must be an array');
    if(!Array.isArray(removed)) throw new TypeError('removed must be an array');

    if(seq === 1){
        return [{
            fields: ['LIST', '0', String(listType), ''].concat(added),
            ordinal: LIST_SHARE_LEG_ORDINAL.CREATE_OR_REMOVE,
        }];
    }

    if(!Number.isSafeInteger(mirrorIndex) || mirrorIndex <= 0)
        throw new TypeError('mirrorIndex must be a positive safe integer after seq 1');

    const legs = [];
    if(removed.length){
        legs.push({
            fields: ['LIST', '1', LIST_EDIT_REMOVE, String(mirrorIndex), ''].concat(removed),
            ordinal: LIST_SHARE_LEG_ORDINAL.CREATE_OR_REMOVE,
        });
    }
    if(added.length){
        legs.push({
            fields: ['LIST', '1', LIST_EDIT_ADD, String(mirrorIndex), ''].concat(added),
            ordinal: LIST_SHARE_LEG_ORDINAL.ADD,
        });
    }
    return legs;
}

function listShareLegTx(leg, { snapshotId, owner, blockIndex, blockTime }){
    return {
        data:          leg.fields.join('|'),
        source:        owner,
        destination:   null,
        amount:        null,
        tx_hash:       LIST_SHARE_TX_PREFIX + snapshotId.slice(0, 48),
        vout:          leg.ordinal,
        block_index:   blockIndex,
        block_time:    blockTime,
        raw_data:      null,
        fee:           null,
        source_pubkey: null,
        tx_outputs:    [],
    };
}

module.exports = { planListShareLegs, listShareLegTx };
