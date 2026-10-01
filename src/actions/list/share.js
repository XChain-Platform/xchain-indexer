'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const { isListShared } = require('../../db/lists/sharing.js');
const { LIST_SHARE_MAX_MEMBERS } = require('../../protocol/constants.js');

const LIST_SHARE_GATE = 'list_share_activation.LIST_SHARE_ACTIVATION';

module.exports = {
    shareFormat(){
        return {
            format: 2,
            fields: 'VERSION|LIST_ACTION_INDEX|MEMO',
            gate: LIST_SHARE_GATE,
        };
    },

    async validateShare(data, format, list, error){
        if(error || format!=2 || data['IS_GENESIS'])
            return error;

        let root = await this.indexerDb.getListRootIndex(data['LIST_ACTION_INDEX']);
        if(data['SOURCE'] != await this.listOwner(root, data))
            return 'invalid: LIST_ACTION_INDEX (not owner)';
        if(![1,2].includes(Number(data['TYPE'])))
            return 'invalid: LIST_ACTION_INDEX (type)';
        if(await isListShared(this.indexerDb, root))
            return 'invalid: LIST_ACTION_INDEX (already shared)';
        if(list.length > LIST_SHARE_MAX_MEMBERS)
            return 'invalid: LIST_ACTION_INDEX (list exceeds LIST_SHARE_MAX_MEMBERS)';
        return error;
    },

    async validateSharedEdit(data, format, list, changes, error){
        if(error || format!=1 || data['IS_GENESIS'] ||
           !gateRegistry.activeAt(LIST_SHARE_GATE, this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null))
            return error;

        let root = await this.indexerDb.getListRootIndex(data['LIST_ACTION_INDEX']);
        if(await isListShared(this.indexerDb, root) && list.length > LIST_SHARE_MAX_MEMBERS)
            return 'invalid: ITEM (shared list exceeds LIST_SHARE_MAX_MEMBERS)';
        return error;
    },

    async storeShare(){},
};
