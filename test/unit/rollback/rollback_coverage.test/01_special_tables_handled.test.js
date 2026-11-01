// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { readRollbackSource } = require('../../../helpers/rollback_source.js');
const { rollbackBuckets } = require('../../../../src/hub/table_lifecycle.js');

// Code-only text: comments cut, quotes blanked, string joins and whitespace collapsed.
function normalizedSource(src){
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map(line => {
        let quote = null;
        for(let i = 0; i < line.length; i++){
            const ch = line[i];
            if(quote){ if(ch === quote && line[i - 1] !== '\\') quote = null; continue; }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; continue; }
            if(ch === '/' && line[i + 1] === '/') return line.slice(0, i);
        }
        return line;
    }).join('\n');
    return code.replace(/[`"']/g, ' ').replace(/\s+\+\s+/g, ' ').replace(/\s+/g, ' ');
}

function unhandledTables(tables, norm){
    return tables.filter(table =>
        !new RegExp('(?:DELETE (?:\\w+ )?FROM|UPDATE) ' + table + '\\b').test(norm));
}

describe('Indexer special rollback coverage @regression', function(){
    const norm = normalizedSource(readRollbackSource());

    it('requires source handling for every special and recomputed table', function(){
        const { SPECIAL_CASE, RECOMPUTED } = rollbackBuckets();
        assert.ok(SPECIAL_CASE.length + RECOMPUTED.length > 5,
            'expected populated special and recomputed rollback buckets');
        const missing = unhandledTables([...new Set([...SPECIAL_CASE, ...RECOMPUTED])], norm);
        assert.deepStrictEqual(missing, [], 'rollback never deletes or updates: ' + missing.join(', ') +
            '; add reorg handling in the Rollback module or reclassify the registry row');
    });

    it('flags an unhandled table and ignores statements that exist only in comments', function(){
        assert.deepStrictEqual(unhandledTables(['synthetic_special_table'], norm),
            ['synthetic_special_table']);
        const comments = normalizedSource('// DELETE FROM synthetic_t\n/* UPDATE synthetic_t */');
        assert.deepStrictEqual(unhandledTables(['synthetic_t'], comments), ['synthetic_t']);
    });
});
