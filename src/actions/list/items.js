'use strict';

module.exports = {
    async loadListMembers(data){
        if(data['TYPE']==3)
            return this.loadUnionMembers(data);
        return this.indexerDb.getList(data['LIST_ACTION_INDEX'], data['BLOCK_INDEX']);
    },

    async collectEditItems(data, format, params, edit){
        let firstItemIndex = this.itemStartIndex[format];
        for(let idx in params){
            if(Number(idx) < firstItemIndex) continue;
            let status = 'valid';
            let item = await this.resolveAddressItem(params[idx], data);
            if(data['TYPE']==3)
                ({ item, status } = await this.checkUnionItem(item, data));
            if(data['TYPE']==1){
                let tokenInfo = await this.indexerDb.getTokenInfo(item);
                if(!tokenInfo) status = 'invalid: TICK (unknown)';
            }
            if(data['TYPE']==2 && !this.indexerDb.isAnyCoinAddress(item, data['BLOCK_INDEX']))
                status = 'invalid: ADDRESS (format)';
            edit[item] = status;
        }
    },

    applyEditItems(data, format, edit, list, invalid){
        let changes = 0;
        for(let item in edit){
            let status = edit[item];
            if(status!='valid'){
                invalid[item] = status;
                continue;
            }
            if((format==0 || (format==1 && data['EDIT']==1)) && !list.includes(item)){
                list.push(item);
                changes++;
            }
            if(format==1 && data['EDIT']==2 && list.includes(item)){
                list.splice(list.indexOf(item), 1);
                changes++;
            }
        }
        return changes;
    },
};
