// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

const FENCED = ['id', 'round_number', 'coin_pair', 'price', 'reference_block', 'status',
                'source_chain', 'source_action_index', 'push_generation'];
const UNFENCED = FENCED.filter(c => c !== 'push_generation');
const GREATEST = '`push_generation` = GREATEST(COALESCE(`push_generation`, 0), COALESCE(VALUES(`push_generation`), 0))';

function odku(sql) { return sql.split(' ON DUPLICATE KEY UPDATE ')[1]; }

function assignments(sql) {
    // Every top-level `col = ...` assignment of the ODKU body, in order.
    return odku(sql).split(/, (?=(?:`[a-z_]+`|status) = )/);
}

describe('price_snapshots mirror upsert holds the reorg fence monotonic @regression @tier1', function () {

    it('assigns push_generation once, last, through GREATEST and never through the status gate', function () {
        const sets = assignments(HubDbSync.priceUpsertSql(FENCED, 1));
        const gen = sets.filter(s => s.startsWith('`push_generation` ='));
        assert.deepStrictEqual(gen, [GREATEST]);
        assert.strictEqual(sets[sets.length - 1], GREATEST, 'the fence is the final assignment');
        assert.ok(!sets.some(s => s.startsWith('`push_generation` = IF(')),
            'a finalized row with a lower generation must not lower the fence');
    });

    it('keeps the status-only gate on every content column so a lower-generation dispute still lands', function () {
        const sets = assignments(HubDbSync.priceUpsertSql(FENCED, 1)).filter(s => !s.startsWith('`push_generation` ='));
        assert.ok(sets.length >= 5, 'the content columns and the status are all assigned');
        for (const s of sets) {
            assert.ok(s.includes("VALUES(status) IN ('finalized', 'disputed')"), s);
            assert.ok(!s.includes('push_generation'), 'no assignment reads the generation: ' + s);
        }
        assert.ok(sets.some(s => s.startsWith('`source_action_index` = IF(')),
            'source_action_index travels with the content, not the fence');
    });

    it('emits the identical ODKU body at one row and at many', function () {
        assert.strictEqual(odku(HubDbSync.priceUpsertSql(FENCED, 1)), odku(HubDbSync.priceUpsertSql(FENCED, 3)));
    });

    it('leaves the status-only gate alone when the delivered row carries no push_generation', function () {
        const sql = HubDbSync.priceUpsertSql(UNFENCED, 1);
        assert.ok(!sql.includes('push_generation'), 'no fence text at all without the column');
        assert.ok(odku(sql).includes("IF(VALUES(status) IN ('finalized', 'disputed'), VALUES(`price`), `price`)"));
    });
});
