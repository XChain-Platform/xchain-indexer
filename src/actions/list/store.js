'use strict';

module.exports = {
    async storeList(data, status, edit, list, invalid, fee){
        await this.indexerDb.createList(data);
        this.util.addAddressTicker(data['SOURCE']);
        if(status=='valid'){
            for(let item in edit)
                await this.indexerDb.createListEdit(data, item, edit[item]);
            for(let item of list)
                await this.indexerDb.createListItem(data, item);
            for(let item in invalid)
                await this.indexerDb.createListItemInvalid(data, item, invalid[item]);
            await this.storeShare(data);
            await this.storeTransfer(data);
            await this.settleFee(data, fee);
        }
        await this.mapper.createMappings(data);
    },
};
