// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');

const { archiveHeadPredicate } = require('../../../../src/consensus/state_hash.js');
const { writeArchiveStatus } = require('../../../../src/db/anchors/archive_status_journal.js');

describe('archive_status_journal', function () {
    it('writes an action-wide archive status', async function () {
        const queries = [];
        const db = {
            async doQuery(sql, args) {
                queries.push({ sql, args });
                return [];
            }
        };

        await writeArchiveStatus(db, 42, 7, false);

        assert.deepStrictEqual(queries, [{
            sql: 'UPDATE anchor_actions SET status_id = ? WHERE action_index = ?',
            args: [7, 42]
        }]);
    });

    it('writes only the archive head row when scoped', async function () {
        const queries = [];
        const db = {
            async doQuery(sql, args) {
                queries.push({ sql, args });
                return [];
            }
        };

        await writeArchiveStatus(db, 43, 8, true);

        assert.deepStrictEqual(queries, [{
            sql: 'UPDATE anchor_actions a SET a.status_id = ? WHERE a.action_index = ? AND ' +
                archiveHeadPredicate('a'),
            args: [8, 43]
        }]);
    });
});
