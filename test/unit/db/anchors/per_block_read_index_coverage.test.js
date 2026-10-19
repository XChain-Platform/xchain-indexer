'use strict';

/*********************************************************************
 *
 * Two reads that run once per block must have an index that serves their
 * predicate, or each block re-reads the whole table. On the shared regtest
 * rail (2026-10-14) both were caught at 4 to 8 s per block once the buffer
 * pool stopped holding them:
 *
 *   collectAnchorInvalid scopes anchor_actions by c.block_index_doge = B;
 *   getMirroredStateCheckpointCandidates ranges state_checkpoints on
 *   (chain, network, block_index >= ?).
 *
 * The test captures the SQL each function actually issues, pulls the driving
 * predicate out of it, and checks the table's declared indexes (read with the
 * runtime's own parsers, so what this sees is what reconcileTableIndexes heals)
 * for one whose leading columns serve that predicate. A change to either query
 * that moves its predicate onto an unindexed column fails here too.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SRC     = path.join(__dirname, '..', '..', '..', '..', 'src');
const SQL_DIR = path.join(SRC, 'sql');

const sqlText     = require(path.join(SRC, 'db', 'database', 'sql_text.js'));
const schemaDrift = require(path.join(SRC, 'db', 'database', 'schema_drift.js'));
const parser      = Object.assign({}, sqlText, schemaDrift);

const { collectAnchorInvalid } = require(path.join(SRC, 'consensus', 'state_hash', 'archive_invalid_section.js'));
const anchorsDb = require(path.join(SRC, 'db', 'anchors', 'index.js'));

// The (chain, network) equality prefix and the strict snapshot_block range of an anchor-axis
// checkpoint read, pulled out of the SQL it issues.
function anchorAxisPredicate(sql){
    const where = /\bWHERE\b([\s\S]*?)\bORDER\s+BY\b/i.exec(sql);
    assert.ok(where, 'no WHERE ... ORDER BY in: ' + sql);
    const equality = [...where[1].matchAll(/\b(\w+)\s*=\s*\?/g)].map(m => m[1]);
    const range    = /\b(\w+)\s*>\s*\?/.exec(where[1]);
    assert.ok(equality.includes('chain') && equality.includes('network'), 'no chain and network equality in: ' + where[1]);
    assert.ok(range, 'no > ? range in: ' + where[1]);
    return range[1];
}

// Every index the table's SQL source declares, standalone and inline, as column lists.
function declaredIndexes(table){
    const data = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    return parser.parseExpectedIndexes(data, table)
        .concat(parser.parseInlineIndexes(data, table))
        .map(i => ({ name: i.name, columns: i.columns.map(c => c.toLowerCase()) }));
}

// An index serves `equality` columns (any order) followed by `range` when its leading
// columns are exactly that set and then the range column: the B-tree shape MariaDB
// needs to seek instead of scanning.
function servingIndex(table, equality, range){
    const eq = equality.map(c => c.toLowerCase()).sort();
    const want = eq.length + 1;
    return declaredIndexes(table).find(i =>
        i.columns.length >= want &&
        i.columns.slice(0, eq.length).slice().sort().join(',') === eq.join(',') &&
        i.columns[eq.length] === range.toLowerCase());
}

// The BTC-anchor-axis twins of the mirrored read, for a DOGE- or LTC-origin escrow checkpoint.
function registerAnchorAxisIndexTests(){
it('getMirroredStateCheckpointCandidatesAfterAnchor: state_checkpoints is indexed on (chain, network, snapshot_block)', async function(){
    let captured = null;
    const self = { mirrorDb: () => ({ doQueryStrict: async (sql) => { captured = sql; return []; } }) };
    await anchorsDb.getMirroredStateCheckpointCandidatesAfterAnchor.call(self, 'DOGE', 'regtest', 50200);
    assert.ok(captured, 'getMirroredStateCheckpointCandidatesAfterAnchor issued no query');
    const range = anchorAxisPredicate(captured);
    assert.strictEqual(range, 'snapshot_block');
    assert.ok(servingIndex('state_checkpoints', ['chain', 'network'], range),
        'state_checkpoints.sql declares no index on (chain, network, ' + range + ')');
});

it('getEarliestValidAnchorCheckpointAfterAnchor: anchor_actions is indexed on (chain, network, snapshot_block)', async function(){
    let captured = null;
    const self = { doQueryStrict: async (sql) => { captured = sql; return []; } };
    await anchorsDb.getEarliestValidAnchorCheckpointAfterAnchor.call(self, 0, 'DOGE', 'regtest', 50200);
    assert.ok(captured, 'getEarliestValidAnchorCheckpointAfterAnchor issued no query');
    const range = anchorAxisPredicate(captured);
    assert.strictEqual(range, 'snapshot_block');
    assert.ok(servingIndex('anchor_actions', ['chain', 'network'], range),
        'anchor_actions.sql declares no index on (chain, network, ' + range + ')');
});
}

describe('per-block reads have an index on their driving predicate @regression @tier1', function(){

    it('collectAnchorInvalid: anchor_actions is indexed on the chunk-height column it scopes by', async function(){
        let captured = null;
        const db = { doQuery: async (sql) => { captured = sql; return []; } };
        await collectAnchorInvalid(db, 50200, 'regtest', 'DOGE');
        assert.ok(captured, 'collectAnchorInvalid issued no query');

        // The per-block scope is `<alias>.<col> BETWEEN ? AND ?` on an anchor_actions alias.
        const scope = /(\w+)\.(\w+)\s+BETWEEN\s+\?\s+AND\s+\?/i.exec(captured);
        assert.ok(scope, 'no BETWEEN ? AND ? block scope in: ' + captured);
        const aliasRe = new RegExp('anchor_actions\\s+' + scope[1] + '\\b', 'i');
        assert.ok(aliasRe.test(captured), 'scope alias ' + scope[1] + ' is not an anchor_actions alias');

        const idx = servingIndex('anchor_actions', [], scope[2]);
        assert.ok(idx,
            'anchor_actions.sql declares no index leading on ' + scope[2] + ', the column collectAnchorInvalid ' +
            'scopes every block by; without one each block reads every archive head (declared: ' +
            declaredIndexes('anchor_actions').map(i => i.name + '(' + i.columns.join(',') + ')').join('; ') + ')');
    });

    it('getMirroredStateCheckpointCandidates: state_checkpoints is indexed on (chain, network, block_index)', async function(){
        let captured = null;
        const self = { mirrorDb: () => ({ doQueryStrict: async (sql) => { captured = sql; return []; } }) };
        await anchorsDb.getMirroredStateCheckpointCandidates.call(self, 'DOGE', 'regtest', 50200);
        assert.ok(captured, 'getMirroredStateCheckpointCandidates issued no query');

        const where = /\bWHERE\b([\s\S]*?)\bORDER\s+BY\b/i.exec(captured);
        assert.ok(where, 'no WHERE ... ORDER BY in: ' + captured);
        const equality = [...where[1].matchAll(/\b(\w+)\s*=\s*\?/g)].map(m => m[1]);
        const range    = /\b(\w+)\s*>=\s*\?/.exec(where[1]);
        assert.deepStrictEqual(equality.slice().sort(), ['chain', 'network']);
        assert.ok(range, 'no >= ? range in: ' + where[1]);

        const idx = servingIndex('state_checkpoints', equality, range[1]);
        assert.ok(idx,
            'state_checkpoints.sql declares no index on (' + equality.join(', ') + ', ' + range[1] + '); without ' +
            'one each block reads and filesorts every checkpoint for the chain (declared: ' +
            declaredIndexes('state_checkpoints').map(i => i.name + '(' + i.columns.join(',') + ')').join('; ') + ')');
    });

    registerAnchorAxisIndexTests();

    it('a dated mode=auto migration adds both indexes with the declared names and columns', function(){
        const dir = path.join(SQL_DIR, 'migrations');
        const want = [
            /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_anchor_block_doge\s+ON\s+anchor_actions\s*\(\s*block_index_doge\s*\)/i,
            /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chain_block\s+ON\s+state_checkpoints\s*\(\s*chain\s*,\s*network\s*,\s*block_index\s*\)/i,
            /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_anchor_chain_snapshot\s+ON\s+anchor_actions\s*\(\s*chain\s*,\s*network\s*,\s*snapshot_block\s*\)/i,
            /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chain_snapshot\s+ON\s+state_checkpoints\s*\(\s*chain\s*,\s*network\s*,\s*snapshot_block\s*\)/i,
        ];
        for(const re of want){
            const hit = fs.readdirSync(dir).filter(f => f.endsWith('.sql'))
                .find(f => re.test(fs.readFileSync(path.join(dir, f), 'utf8')));
            assert.ok(hit, 'no migration matches ' + re);
            assert.ok(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*auto\b/im.test(fs.readFileSync(path.join(dir, hit), 'utf8')),
                hit + ' must be tagged `-- xchain:migration mode=auto`');
        }
    });
});
