'use strict';

const { createListTransfer } = require('../../db/lists/sharing.js');

module.exports = {
    transferFormat(){
        return {
            format: 3,
            fields: 'VERSION|LIST_ACTION_INDEX|DESTINATION|MEMO',
            gate: 'list_transfer_activation.LIST_TRANSFER_ACTIVATION',
        };
    },

    async validateTransfer(data, format, list, error){
        if(!error && format==3){
            let destRef = await this.indexerDb.resolveAddressRefChecked(data['DESTINATION'], data['BLOCK_INDEX']);
            data['DESTINATION'] = destRef.value;
            if(destRef.rejected)
                error = 'invalid: DESTINATION (unresolvable ^id)';
        }

        if(!error && format==3 &&
           (this.util.isNull(data['DESTINATION']) || !this.util.isCryptoAddress(data['DESTINATION'])))
            error = 'invalid: DESTINATION (format)';

        if(!error && format==3){
            let root = await this.indexerDb.getListRootIndex(data['LIST_ACTION_INDEX']);
            if(data['SOURCE'] != await this.listOwner(root, data))
                error = 'invalid: LIST_ACTION_INDEX (not owner)';
        }

        return error;
    },

    async storeTransfer(data){
        if(data['FORMAT']==3)
            await createListTransfer(this.indexerDb, data, data['DESTINATION']);
    },
};
