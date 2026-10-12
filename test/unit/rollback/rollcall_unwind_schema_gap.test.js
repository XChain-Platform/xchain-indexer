// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Check that a schema gap on one roll-call table never skips the other tables' unwind
// (rollcall_gates ships in a later migration than rollcalls and rollcall_absences).

'use strict';

const assert = require('assert');
const purgeSql = require('../../../src/db/rollback/purge.js');

const GATES     = 'DELETE FROM rollcall_gates WHERE close_block >= ?';
const ABSENCES  = 'DELETE FROM rollcall_absences WHERE close_block >= ?';
const VERDICTS  = 'DELETE FROM rollcalls WHERE close_block >= ?';

function schemaError(errno){
    const e = new Error('schema gap ' + errno);
    e.errno = errno;
    return e;
}

// A db whose doQuery records every statement and throws the mapped error for it.
function recordingDb(failures){
    const ran = [];
    return {
        ran,
        async doQuery(sql, args){
            ran.push({ sql, args });
            if(failures[sql]) throw failures[sql];
            return [];
        }
    };
}

describe('roll-call unwind schema-gap guard @regression', function () {
    it('deletes gates, absences and verdicts in that order on a migrated database', async function () {
        const db = recordingDb({});
        await purgeSql.unwindRollcallEpochs(db, 120);
        assert.deepStrictEqual(db.ran.map(r => r.sql), [GATES, ABSENCES, VERDICTS]);
        assert.ok(db.ran.every(r => r.args[0] === 120));
    });

    it('still unwinds absences and verdicts when rollcall_gates is missing (errno 1146)', async function () {
        const db = recordingDb({ [GATES]: schemaError(1146) });
        await purgeSql.unwindRollcallEpochs(db, 120);
        assert.deepStrictEqual(db.ran.map(r => r.sql), [GATES, ABSENCES, VERDICTS]);
    });

    it('still unwinds verdicts when rollcall_absences lacks the close_block column (errno 1054)', async function () {
        const db = recordingDb({ [ABSENCES]: schemaError(1054) });
        await purgeSql.unwindRollcallEpochs(db, 120);
        assert.deepStrictEqual(db.ran.map(r => r.sql), [GATES, ABSENCES, VERDICTS]);
    });

    it('a pre-migration database with none of the tables tries each delete and does not throw', async function () {
        const db = recordingDb({ [GATES]: schemaError(1146), [ABSENCES]: schemaError(1146), [VERDICTS]: schemaError(1146) });
        await purgeSql.unwindRollcallEpochs(db, 120);
        assert.strictEqual(db.ran.length, 3);
    });

    it('any other fault surfaces and stops the unwind before the verdicts go', async function () {
        const db = recordingDb({ [ABSENCES]: schemaError(1205) });
        await assert.rejects(purgeSql.unwindRollcallEpochs(db, 120), /schema gap 1205/);
        assert.deepStrictEqual(db.ran.map(r => r.sql), [GATES, ABSENCES]);
    });
});
