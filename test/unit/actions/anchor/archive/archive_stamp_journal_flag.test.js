// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const anchors = require('../../../../../src/db/anchors/index.js');
const { archiveHeadPredicate } = require('../../../../../src/consensus/state_hash.js');
const observability = require('../../../../../src/observability/index.js');
const diag = require('../../../../../src/actions/anchor/diagnostic_events.js');
const { reportArchiveFailure } = require(
    '../../../../../src/actions/anchor/archive/archive_verdict.js');

describe('archive stamp journal flag', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('journals archive status only for an exact true flag on both scopes', async function () {
        const queries = [];
        const db = {
            async createStatus() {
                return 7;
            },
            async doQuery(sql, args) {
                queries.push({ sql, args });
                return [];
            }
        };

        await anchors.setAnchorArchiveStatus.call(db, 40, 'invalid_archive');
        await anchors.setAnchorArchiveStatus.call(db, 41, 'invalid_archive', false);
        await anchors.setAnchorArchiveStatus.call(db, 42, 'invalid_archive', true);
        await anchors.setAnchorArchiveRowStatus.call(db, 43, 'invalid_archive');
        await anchors.setAnchorArchiveRowStatus.call(db, 44, 'invalid_archive', false);
        await anchors.setAnchorArchiveRowStatus.call(db, 45, 'invalid_archive', true);

        const headPredicate = ' AND ' + archiveHeadPredicate('a');
        assert.deepStrictEqual(queries, [
            {
                sql: 'UPDATE anchor_actions SET status_id = ? WHERE action_index = ?',
                args: [7, 40]
            },
            {
                sql: 'UPDATE anchor_actions SET status_id = ? WHERE action_index = ?',
                args: [7, 41]
            },
            {
                sql: 'UPDATE anchor_actions SET pre_archive_status_id = IF(status_id = ?, ' +
                    'pre_archive_status_id, status_id), status_id = ? WHERE action_index = ?',
                args: [7, 7, 42]
            },
            {
                sql: 'UPDATE anchor_actions a SET a.status_id = ? WHERE a.action_index = ?' +
                    headPredicate,
                args: [7, 43]
            },
            {
                sql: 'UPDATE anchor_actions a SET a.status_id = ? WHERE a.action_index = ?' +
                    headPredicate,
                args: [7, 44]
            },
            {
                sql: 'UPDATE anchor_actions a SET a.pre_archive_status_id = IF(a.status_id = ?, ' +
                    'a.pre_archive_status_id, a.status_id), a.status_id = ? WHERE ' +
                    'a.action_index = ?' + headPredicate,
                args: [7, 7, 45]
            }
        ]);
    });

    it('forwards only an exact true journal flag to both archive setters', async function () {
        sinon.stub(observability.getLogger(), 'warn');
        sinon.stub(diag, 'noteAnchorFailed');
        const calls = [];
        const handler = {
            indexerDb: {
                setAnchorArchiveStatus: async (...args) => calls.push(['action', ...args]),
                setAnchorArchiveRowStatus: async (...args) => calls.push(['row', ...args])
            }
        };
        const failure = {
            logLine: 'archive validation failed',
            event: { chain: 'BTC', reason: 'invalid_archive: mismatch' },
            actionIndex: '41'
        };

        for (const sectionScoped of [false, true]) {
            await reportArchiveFailure(handler, failure, sectionScoped);
            await reportArchiveFailure(handler, failure, sectionScoped, false);
            await reportArchiveFailure(handler, failure, sectionScoped, 1);
            await reportArchiveFailure(handler, failure, sectionScoped, true);
        }

        assert.deepStrictEqual(calls, [
            ['action', 41, 'invalid_archive'],
            ['action', 41, 'invalid_archive'],
            ['action', 41, 'invalid_archive'],
            ['action', 41, 'invalid_archive', true],
            ['row', 41, 'invalid_archive'],
            ['row', 41, 'invalid_archive'],
            ['row', 41, 'invalid_archive'],
            ['row', 41, 'invalid_archive', true]
        ]);
    });
});
