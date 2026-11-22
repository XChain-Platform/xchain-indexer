/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Locking, existence rechecks and race handling for boot-time schema creation.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../../observability/index.js');
const { tableNameOf } = require('./table_files.js');

async function declaredTableExistence(self, db, tableFiles){
    const exists = new Map();
    for(const file of tableFiles){
        const table = tableNameOf(file);
        try {
            const results = await db.query(
                'SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
                [self.dbName, table]
            );
            exists.set(file, results.length > 0);
        } catch(error){
            self.util.throwError('Error while trying to verify ' + table + ' table exists!');
            return null;
        }
    }
    return exists;
}

async function acquireSchemaCreateLock(self, db){
    const lockName = 'xchain_migrate_' + self.dbName;
    const got = await db.query('SELECT GET_LOCK(?, 300) AS l', [lockName]);
    if(!got || !got[0] || String(got[0].l) !== '1')
        throw new Error('verifyTables: could not acquire lock ' + lockName +
            '. No table was created by this process.');
    return lockName;
}

async function reconcileDeclaredTable(self, file, db){
    await self.alterTableForDrift(file, db);
    await self.reconcileTableIndexes(file, db);
}

function isTableExistsError(error){
    return error && (Number(error.errno) === 1050 || error.code === 'ER_TABLE_EXISTS_ERROR');
}

async function verifyDeclaredTable(self, file, db, wasPresent){
    const table = tableNameOf(file);
    let present = wasPresent;
    if(!present){
        const fresh = await declaredTableExistence(self, db, [file]);
        if(!fresh) return false;
        present = fresh.get(file);
        if(present)
            getLogger().warn('Table ' + table + ' appeared during schema verification; reconciling it instead of creating it.');
    }
    if(present){
        await reconcileDeclaredTable(self, file, db);
        return false;
    }
    try {
        await self.createTable(file);
        return true;
    } catch(error){
        if(!isTableExistsError(error)) throw error;
        const fresh = await declaredTableExistence(self, db, [file]);
        if(fresh && fresh.get(file)){
            getLogger().warn('Table ' + table + ' was created concurrently; reconciling it instead.');
            await reconcileDeclaredTable(self, file, db);
            return false;
        }
        throw new Error('verifyTables: CREATE reported that ' + table +
            ' exists, but information_schema still reports it absent. The table was not dropped.');
    }
}

module.exports = {
    acquireSchemaCreateLock,
    declaredTableExistence,
    verifyDeclaredTable,
};
