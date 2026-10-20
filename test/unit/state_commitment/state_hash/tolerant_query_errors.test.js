/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The state-hash read wrapper degrades only a schema gap (1146, 1054) to an
 * empty class. Every other read error, one without a numeric errno included,
 * must stop the hash rather than hash a section as no rows.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const { tolerantQuery } = require('../../../../src/consensus/state_hash/tolerant_query.js');
const { buildStateHashData } = require('../../../../src/consensus/state_hash.js');
const Database = require('../../../../src/db');

// Build an errno-carrying driver error, or a plain Error when errno is undefined.
function readError(errno){
    const e = new Error('read failed' + (errno === undefined ? '' : ' errno ' + errno));
    if(errno !== undefined) e.errno = errno;
    return e;
}

// A handle whose doQuery swallows like a non-transactional read and whose doQueryStrict throws.
function strictThrowingDb(error){
    return {
        doQuery:       async () => [],
        doQueryStrict: async () => { throw error; },
        getStatusId:   async () => 1
    };
}

describe('state_hash tolerantQuery read errors @regression', function(){
    it('returns an empty class for a missing table (1146) or column (1054)', async function(){
        for(const errno of [1146, 1054])
            assert.deepStrictEqual(await tolerantQuery(strictThrowingDb(readError(errno)), 'SELECT 1', []), []);
    });

    it('rethrows a driver error that is not a schema gap', async function(){
        const e = readError(1213);
        await assert.rejects(tolerantQuery(strictThrowingDb(e), 'SELECT 1', []), (got) => got === e);
    });

    it('rethrows an error with no numeric errno, such as a transaction fence', async function(){
        const e = readError(undefined);
        await assert.rejects(tolerantQuery(strictThrowingDb(e), 'SELECT 1', []), (got) => got === e);
    });

    it('reads through doQueryStrict, so a doQuery that would swallow the fault is never used', async function(){
        const e = readError(1205);
        await assert.rejects(buildStateHashData(strictThrowingDb(e), 100, { activationDelay: 6, gasTick: 'XCHAIN' }),
            (got) => got === e);
    });

    it('reads through doQuery only for a handle that has no doQueryStrict', async function(){
        const db = { doQuery: async (sql, args) => [{ sql, args }] };
        assert.deepStrictEqual(await tolerantQuery(db, 'SELECT ?', [7]), [{ sql: 'SELECT ?', args: [7] }]);
    });

    it('is given doQueryStrict by the production Database class', function(){
        assert.strictEqual(typeof Database.prototype.doQueryStrict, 'function');
    });
});
