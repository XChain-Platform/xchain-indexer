'use strict';

async function listItemId(db, type, item){
    if(type==1)
        return db.createTicker(item);
    if(type==2)
        return db.createAddress(item);
    return null;
}

module.exports = { listItemId };
