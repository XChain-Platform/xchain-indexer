'use strict';

const gateRegistry = require('../../consensus/gate_registry.js');
const { UNARMED } = require('../../protocol_changes/core.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';

function archiveHeadPickPredicate(alias) {
    return alias + '.match_batch_seq IS NOT NULL AND (' +
        alias + '.version = 1 OR (' + alias + '.version = 3 AND ' +
        alias + '.chain IS NULL AND ' + alias + '.block_index_doge >= ?))';
}

function foldArchiveHeadFloor(network) {
    const table = gateRegistry.get(FOLD_GATE);
    if(typeof network !== 'string' || !Object.prototype.hasOwnProperty.call(table, network))
        return UNARMED;
    const floor = table[network];
    return (typeof floor === 'number' && Number.isFinite(floor)) ? floor : UNARMED;
}

module.exports = { archiveHeadPickPredicate, foldArchiveHeadFloor };
