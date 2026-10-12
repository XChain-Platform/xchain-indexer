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
                meta = resolveMeta(
                    current, data['NAME'] ?? '', data['DESCRIPTION'] ?? ''
                );
            }
            await this.indexerDb.createListMeta(data, meta.name, meta.description);
        }
    },

    async writeListRows(data, edit, list, invalid){
        let db = this.indexerDb;
        if(typeof db.createListItems === 'function'){
            await db.createListEdits(data, edit);
            await db.createListItems(data, list);
            await db.createListItemsInvalid(data, invalid);
            return;
        }
        for(let item in edit)
            await db.createListEdit(data, item, edit[item]);
        for(let item of list)
            await db.createListItem(data, item);
        for(let item in invalid)
            await db.createListItemInvalid(data, item, invalid[item]);
    },

    async storeList(data, status, edit, list, invalid, fee){
        if(data['FORMAT']==5 && this.isFormatActive(5, data)){
            await this.storeMeta(data, status);
            if(status=='valid')
                await this.settleFee(data, fee);
            await this.mapper.createMappings(data);
            return;
        }

        await this.indexerDb.createList(data);
        this.util.addAddressTicker(data['SOURCE']);
        if(status=='valid'){
            await this.writeListRows(data, edit, list, invalid);
            await this.storeShare(data);
            await this.storeTransfer(data);
            await this.settleFee(data, fee);
        }
        await this.mapper.createMappings(data);
        if(status=='valid' && data['FORMAT']==4)
            await this.storeMeta(data, status);
    },
};
