/*********************************************************************
 *
 * Copyright © 2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const betsDb = require('../../../../src/db/bets/index.js');
const { buildBetsRpc } = require('../../../../src/api/rpc/bets.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

function compactSql(sql){
    return sql.replace(/\s+/g, ' ').trim();
}

function queryRecorder(result){
    const calls = [];
    const doQuery = async (...args) => {
        calls.push(args);
        return result;
    };
    doQuery.calls = calls;
    return doQuery;
}

function assertEffectiveListFold(sql){
    const query = compactSql(sql);
    assert.match(query, /CASE WHEN ae\.action_index IS NULL THEN f\.allow_list ELSE NULLIF\(ae\.allow_list, 0\) END as allow_list/);
    assert.match(query, /CASE WHEN be\.action_index IS NULL THEN f\.block_list ELSE NULLIF\(be\.block_list, 0\) END as block_list/);
    assert.match(query, /LEFT JOIN bet_edits ae ON \( ae\.action_index=\( SELECT MAX\(e\.action_index\).*e\.feed_action_index=f\.action_index AND es\.status='valid' AND e\.allow_list IS NOT NULL/s);
    assert.match(query, /LEFT JOIN bet_edits be ON \( be\.action_index=\( SELECT MAX\(e\.action_index\).*e\.feed_action_index=f\.action_index AND es\.status='valid' AND e\.block_list IS NOT NULL/s);
}

describe('public BET reads expose effective list references', function(){
    it('folds the latest valid allow and block edits into a detail row', async function(){
        const db = {
            util: { isNull: value => value === null || value === undefined },
            doQuery: queryRecorder([{
                action_index: '41',
                allow_list: null,
                block_list: '93',
                deadline: '1000'
            }])
        };

        const feed = await betsDb.getBetFeedInfo.call(db, 41);

        assert.deepStrictEqual(feed, {
            ACTION_INDEX: 41,
            ALLOW_LIST: null,
            BLOCK_LIST: 93,
            DEADLINE: 1000
        });
        assertEffectiveListFold(db.doQuery.calls[0][0]);
        assert.deepStrictEqual(db.doQuery.calls[0][1], [41]);
    });

    it('folds the latest valid edits independently into every feed-list row', async function(){
        const rows = [
            { action_index: 41, allow_list: null, block_list: 93 },
            { action_index: 42, allow_list: 77, block_list: null }
        ];
        const db = {
            util: {
                isNull: value => value === null || value === undefined,
                isNumeric: value => Number.isFinite(Number(value))
            },
            doQuery: queryRecorder(rows)
        };

        const result = await betsDb.getBetFeedRows.call(db, { status: 'open', limit: 25 });

        assert.strictEqual(result, rows);
        assertEffectiveListFold(db.doQuery.calls[0][0]);
        assert.deepStrictEqual(db.doQuery.calls[0][1], ['open']);
    });

    it('rejects regressions that admit invalid edits or leak the zero sentinel', async function(){
        const db = {
            util: { isNull: () => true, isNumeric: () => false },
            doQuery: queryRecorder([])
        };
        await betsDb.getBetFeedRows.call(db, {});
        const query = db.doQuery.calls[0][0];

        assert.throws(() => assertEffectiveListFold(
            query.replace("es.status='valid'", "es.status='invalid'")
        ), assert.AssertionError);
        assert.throws(() => assertEffectiveListFold(
            query.replace('NULLIF(ae.allow_list, 0)', 'ae.allow_list')
        ), assert.AssertionError);
    });

    it('returns effective references unchanged through detail and listing RPCs', async function(){
        const detail = { ACTION_INDEX: 41, ALLOW_LIST: null, BLOCK_LIST: 93 };
        const rows = [{ action_index: 41, allow_list: null, block_list: 93 }];
        const view = recordingView({
            getLatestBlockIndex: 500,
            getBetFeedInfo: detail,
            getBetFeedPools: [],
            getBetFeedRows: rows
        });
        const rpc = buildBetsRpc({ indexer: fakeIndexer({ view }) });

        assert.deepStrictEqual(await rpc.getbetfeed({ action_index: 41 }), {
            network: 'regtest',
            feed: detail,
            pools: []
        });
        assert.deepStrictEqual(await rpc.getbetfeeds({ limit: 10 }), {
            latest_block_index: 500,
            network: 'regtest',
            count: 1,
            next_cursor: null,
            feeds: rows
        });
    });
});
