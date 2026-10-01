'use strict';

module.exports = {
    unionTypeActive(){
        return false;
    },

    async loadUnionMembers(){
        return [];
    },

    async checkUnionItem(item){
        return { item, status: 'valid' };
    },

    async validateUnionResult(data, format, list, changes, error){
        return error;
    },
};
