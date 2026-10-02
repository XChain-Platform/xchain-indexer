'use strict';

const { resolveMeta } = require('./meta_rules.js');

module.exports = {
    async storeMeta(data, status){
        if(data['VERSION']==='4'){
            if(status!=='valid')
                return;
            let storedData = { ...data, LIST_ACTION_INDEX: data['ACTION_INDEX'] };
            let name = data['NAME']==='' ? null : data['NAME'];
            let description = data['DESCRIPTION']==='' ? null : data['DESCRIPTION'];
            await this.indexerDb.createListMeta(storedData, name, description);
        } else if(data['VERSION']==='5'){
            let meta = { name: null, description: null };
            if(status==='valid'){
                let current = await this.indexerDb.getListMeta(
                    data['LIST_ACTION_INDEX'], data['BLOCK_INDEX']
                );
                meta = resolveMeta(current, data['NAME'], data['DESCRIPTION']);
            }
            await this.indexerDb.createListMeta(data, meta.name, meta.description);
        }
    },

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
