'use strict';

module.exports = {
    shareFormat(){
        return null;
    },

    async validateShare(data, format, list, error){
        return error;
    },

    async validateSharedEdit(data, format, list, changes, error){
        return error;
    },

    async storeShare(){},
};
