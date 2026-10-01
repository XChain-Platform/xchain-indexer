'use strict';

function canonicalListIndex(item){
    return typeof item === 'string' && /^[1-9][0-9]*$/.test(item) ? item : null;
}

async function listItemId(db, type, item){
    if(type==1)
        return db.createTicker(item);
    if(type==2)
        return db.createAddress(item);
    if(type==3)
        return canonicalListIndex(item);
    return null;
}

async function isValidListRoot(db, index){
    let rows = await db.doQuery(
        `SELECT 1
         FROM lists l
         INNER JOIN index_statuses s ON (s.id=l.status_id)
         WHERE l.action_index=?
           AND l.list_action_index IS NULL
           AND s.status='valid'
         LIMIT 1`,
        [index]
    );
    return rows.length > 0;
}

async function getUnionMemberRoots(db, headIndex){
    let rows = await db.doQuery(
        `SELECT item_id AS action_index
         FROM list_items
         WHERE action_index=?
         ORDER BY item_id ASC`,
        [headIndex]
    );
    return rows.map((row) => String(row['action_index']));
}

async function getUnionMemberType(db, root){
    let roots = await getUnionMemberRoots(db, root);
    if(roots.length === 0)
        return false;
    let getStoredType = db.getListStoredType || db.getListType;
    return getStoredType.call(db, roots[0]);
}

module.exports = {
    listItemId,
    isValidListRoot,
    getUnionMemberRoots,
    getUnionMemberType,
};
