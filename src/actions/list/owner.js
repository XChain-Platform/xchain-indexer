'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const { getListOwner } = require('../../db/lists/sharing.js');

module.exports = {
    async listOwner(rootIndex, data){
        if(gateRegistry.activeAt('list_transfer_activation.LIST_TRANSFER_ACTIVATION',
            this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null))
            return getListOwner(this.indexerDb, rootIndex);
        return this.indexerDb.getListSource(rootIndex);
    },
};
