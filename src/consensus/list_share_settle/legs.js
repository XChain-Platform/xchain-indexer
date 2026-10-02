'use strict';

const { LIST_SHARE_TX_PREFIX, LIST_SHARE_LEG_ORDINAL } = require('./halt.js');
const { LIST_EDIT_ADD, LIST_EDIT_REMOVE } = require('../bridge_settle/reasons.js');

function metaField(value){
    return typeof value === 'string' && value.length ? value : null;
}

function planListShareLegs(options){
    const {
        seq,
        listType,
        added,
        removed,
        mirrorIndex,
        metaActive = false,
        meta = null,
        currentMeta = null,
    } = options;
    const hasCurrentMeta = Object.prototype.hasOwnProperty.call(options, 'currentMeta');
    if(!Number.isSafeInteger(seq) || seq <= 0)
        throw new TypeError('seq must be a positive safe integer');
    if(!Array.isArray(added)) throw new TypeError('added must be an array');
    if(!Array.isArray(removed)) throw new TypeError('removed must be an array');

    if(seq === 1){
        const name = meta && typeof meta.name === 'string' ? meta.name : '';
        const description = meta && typeof meta.description === 'string' ? meta.description : '';
        const fields = metaActive && (name.length || description.length)
            ? ['LIST', '4', String(listType), name, description, ''].concat(added)
            : ['LIST', '0', String(listType), ''].concat(added);
        return [{
            fields,
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
    if(hasCurrentMeta && metaActive && meta !== null){
        const name = metaField(meta.name);
        const description = metaField(meta.description);
        const currentName = metaField(currentMeta && currentMeta.name);
        const currentDescription = metaField(currentMeta && currentMeta.description);
        if(name !== currentName || description !== currentDescription){
            legs.push({
                fields: [
                    'LIST',
                    '5',
                    String(mirrorIndex),
                    name || '-',
                    description || '-',
                    '',
                ],
                ordinal: LIST_SHARE_LEG_ORDINAL.META,
            });
        }
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
