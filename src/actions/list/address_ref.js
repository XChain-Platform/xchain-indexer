'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const { isAddressRefItem } = require('./address_ref_parse.js');

const LIST_ADDRESS_REF_KEY = 'list_address_ref_activation.LIST_ADDRESS_REF_ACTIVATION';

module.exports = {
    async resolveAddressItem(item, data){
        if(data['TYPE']==2 && isAddressRefItem(item) &&
           gateRegistry.activeAt(LIST_ADDRESS_REF_KEY, this.config['NETWORK'],
               this.config['COIN'], data['BLOCK_INDEX'], null))
            return await this.indexerDb.resolveAddressRef(item);
        return item;
    },
};
