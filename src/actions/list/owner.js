'use strict';

module.exports = {
    async listOwner(rootIndex){
        return this.indexerDb.getListSource(rootIndex);
    },
};
