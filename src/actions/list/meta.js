'use strict';

const { metaFieldVerdict, isNoChange } = require('./meta_rules.js');

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

    validateMeta(data, format, error){
        if(error || (format!=4 && format!=5))
            return error;

        let isCreate = format==4;
        error = metaFieldVerdict('NAME', data['NAME'], LIST_META_NAME_MAX_BYTES, isCreate);
        if(!error)
            error = metaFieldVerdict(
                'DESCRIPTION',
                data['DESCRIPTION'],
                LIST_META_DESCRIPTION_MAX_BYTES,
                isCreate
            );
        if(!error && format==5 && isNoChange(data['NAME'], data['DESCRIPTION']))
            error = 'invalid: NAME (no change)';
        return error;
    },
};
