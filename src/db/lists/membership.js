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

function unionCreateItems(wireData){
    let commands = String(wireData || '').split(';');
    let first = commands[0].split('|');
    if(String(first[0]).trim().toUpperCase()==='BATCH')
        commands[0] = first.slice(2).join('|');
    return commands
        .map((command) => command.split('|').map((part) => part.trim()))
        .filter((parts) => parts[0].toUpperCase()==='LIST' && parts[1]==='0' && parts[2]==='3')
        .map((parts) => parts.slice(4));
}

async function orderUnionMemberRoots(db, roots, wireData){
    let stored = new Set(roots);
    for(let items of unionCreateItems(wireData)){
        let ordered = [];
        for(let item of items){
            if(canonicalListIndex(item) === null)
                continue;
            let memberRoot = String(await db.getListRootIndex(item));
            if(stored.has(memberRoot) && !ordered.includes(memberRoot))
                ordered.push(memberRoot);
        }
        if(ordered.length === roots.length)
            return ordered;
    }
    return roots;
}

async function getUnionMemberType(db, root){
    let rows = await db.doQuery(
        `SELECT li.item_id AS action_index, t.data AS wire_data
         FROM list_items li
         LEFT JOIN actions a ON (a.action_index=li.action_index)
         LEFT JOIN transactions t ON (t.tx_index=a.tx_index)
         WHERE li.action_index=?
         ORDER BY li.item_id ASC`,
        [root]
    );
    if(rows.length === 0)
        return false;
    let roots = rows.map((row) => String(row['action_index']));
    roots = await orderUnionMemberRoots(db, roots, rows[0]['wire_data']);
    let getStoredType = db.getListStoredType || db.getListType;
    return getStoredType.call(db, roots[0]);
}

module.exports = {
    listItemId,
    isValidListRoot,
    getUnionMemberRoots,
    getUnionMemberType,
};
