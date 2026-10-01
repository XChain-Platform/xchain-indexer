'use strict';

module.exports = {
    async chargeFee(data, format, changes, error){
        return { error, fees: null };
    },

    async settleFee(data, fee){
        if(!fee) return;
    },
};
