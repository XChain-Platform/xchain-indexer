'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const { metaFieldVerdict, isNoChange } = require('./meta_rules.js');

const LIST_META_NAME_MAX_BYTES = 64;
const LIST_META_DESCRIPTION_MAX_BYTES = 512;
const LIST_META_GATE = 'list_meta_activation.LIST_META_ACTIVATION';

module.exports = {
    installFormat(spec){
        Object.defineProperty(this.formats, spec.format, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: spec.fields,
        });
        this.formatGates[spec.format] = spec.gate;
        this.itemStartIndex[spec.format] = spec.fields.split('|').indexOf('ITEM');
    },

    deferFormat(spec){
        this.formatGates[spec.format] = spec.gate;
        this.itemStartIndex[spec.format] = spec.fields.split('|').indexOf('ITEM');
        Object.defineProperty(this.formats, spec.format, {
            configurable: true,
            enumerable: false,
            get: () => {
                if(!gateRegistry.activeAt(spec.gate, this.config['NETWORK'], this.config['COIN'], 0, null))
                    return undefined;
                this.installFormat(spec);
                return spec.fields;
            },
        });
    },

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
};
