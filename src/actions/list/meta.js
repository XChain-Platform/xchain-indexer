'use strict';

const { metaFieldVerdict, resolveMeta, isNoChange } = require('./meta_rules.js');

const LIST_META_NAME_MAX_BYTES = 64;
const LIST_META_DESCRIPTION_MAX_BYTES = 512;
const LIST_META_GATE = 'list_meta_activation.LIST_META_ACTIVATION';

module.exports = {
    createMetaFormat(){
        return {
            format: 4,
            fields: 'VERSION|TYPE|NAME|DESCRIPTION|MEMO|ITEM',
            gate: LIST_META_GATE,
        };
    },

    setMetaFormat(){
        return {
            format: 5,
            fields: 'VERSION|LIST_ACTION_INDEX|NAME|DESCRIPTION|MEMO',
            gate: LIST_META_GATE,
        };
    },

    metaOwnerVerdict(){
        return 'invalid: LIST_ACTION_INDEX (not owner)';
    },

    validateMeta(data, format, error){
        if(error || (format!=4 && format!=5))
            return error;

        let isCreate = format==4;
        let name = data['NAME'] ?? '';
        let description = data['DESCRIPTION'] ?? '';
        error = metaFieldVerdict('NAME', name, LIST_META_NAME_MAX_BYTES, isCreate);
        if(!error)
            error = metaFieldVerdict(
                'DESCRIPTION',
                description,
                LIST_META_DESCRIPTION_MAX_BYTES,
                isCreate
            );
        if(!error && format==5 && isNoChange(name, description))
            error = 'invalid: NAME (no change)';
        return error;
    },

    async storeMeta(data, status){
        let storedData = data;
        let name = null;
        let description = null;

        if(status=='valid' && data['FORMAT']==4){
            storedData = { ...data, LIST_ACTION_INDEX: data['ACTION_INDEX'] };
            name = data['NAME'] || null;
            description = data['DESCRIPTION'] || null;
        } else if(status=='valid' && data['FORMAT']==5){
            let current = await this.indexerDb.getListMeta(
                data['LIST_ACTION_INDEX'], data['BLOCK_INDEX']
            );
            ({ name, description } = resolveMeta(
                current, data['NAME'] ?? '', data['DESCRIPTION'] ?? ''
            ));
        }

        await this.indexerDb.createListMeta(storedData, name, description);
    },
};
