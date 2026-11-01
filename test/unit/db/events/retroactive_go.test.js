/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Unit coverage for the append-only retroactive-go event-row helpers.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const { goRulesSha } = require('../../../../src/consensus/retroactive/go_binding.js');
const {
    recordRetroactiveGo,
    readRetroactiveGoRows,
    findMatchingGo
} = require('../../../../src/db/events/retroactive_go.js');

function makeDb(rows = []){
    const calls = [];
    return {
        calls,
        async doQueryStrict(sql, params){
            calls.push({ sql: String(sql), params: params || [] });
            return rows;
        }
    };
}

function assertAppendOnly(db){
    assert.strictEqual(db.calls.some(({ sql }) => /\b(?:UPDATE|DELETE)\b/i.test(sql)), false);
}

describe('retroactive go event rows @regression @tier1', function () {
    const canonicalMap = 'canonical map';
    const target = 77;
    const rules = goRulesSha(canonicalMap, target);

    it('recordRetroactiveGo inserts the exact ordered JSON payload', async function () {
        const db = makeDb();

        await recordRetroactiveGo(db, { target, rules });

        assert.strictEqual(db.calls.length, 1);
        assert.match(db.calls[0].sql, /INSERT INTO events/i);
        assert.match(db.calls[0].sql, /NOW\(\)/i);
        assert.deepStrictEqual(db.calls[0].params,
            ['CONSENSUS_RETRO_GO', JSON.stringify({ target, rules })]);
        assertAppendOnly(db);
    });

    it('recordRetroactiveGo refuses a bad target or digest before querying', async function () {
        const badRows = [
            { target: -1, rules },
            { target: Number.MAX_SAFE_INTEGER + 1, rules },
            { target: String(target), rules },
            { target, rules: rules.toUpperCase() },
            { target, rules: 'ab' }
        ];

        for(const badRow of badRows){
            const db = makeDb();
            await assert.rejects(recordRetroactiveGo(db, badRow));
            assert.deepStrictEqual(db.calls, []);
        }
    });

    it('readRetroactiveGoRows reads a bounded newest-first page and skips unsafe rows', async function () {
        const olderRules = goRulesSha(canonicalMap, 70);
        const db = makeDb([
            { data: JSON.stringify({ target, rules }) },
            { data: '{bad' },
            { data: JSON.stringify({ target: String(target), rules }) },
            { data: JSON.stringify({ target, rules: rules.toUpperCase() }) },
            { data: JSON.stringify({ target: 70, rules: olderRules }) }
        ]);

        const goRows = await readRetroactiveGoRows(db);

        assert.deepStrictEqual(goRows, [
            { target, rules },
            { target: 70, rules: olderRules }
        ]);
        assert.strictEqual(db.calls.length, 1);
        assert.match(db.calls[0].sql, /WHERE code = 'CONSENSUS_RETRO_GO'/i);
        assert.match(db.calls[0].sql, /ORDER BY id DESC/i);
        assert.match(db.calls[0].sql, /LIMIT 100/i);
        assertAppendOnly(db);
    });

    it('findMatchingGo chooses the first matching row', function () {
        const matching = { target, rules };
        const duplicate = { target, rules };
        const rows = [{ target: 70, rules: goRulesSha(canonicalMap, 70) }, matching, duplicate];

        assert.strictEqual(findMatchingGo(rows, { canonicalMap, target }), matching);
    });

    it('findMatchingGo rejects another map or a deeper target', function () {
        const rows = [{ target, rules }];

        assert.strictEqual(findMatchingGo(rows, { canonicalMap: canonicalMap + 'x', target }), null);
        assert.strictEqual(findMatchingGo(rows, { canonicalMap, target: target - 1 }), null);
    });
});
