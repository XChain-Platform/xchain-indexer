'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// the split-brain fence must be identical in EVERY holder of
// state_checkpoints.
//
// tightened the checkpoint unique key so a same-seq split-brain collapses
// to exactly one admitted row, and applied it ON THE HUB ONLY. The indexer mirror
// and the explorer's hub-mirror both kept the older, WIDER key
// (chain, network, block_index, checkpoint_seq), which admits BOTH rows of a
// same-seq split-brain whenever their block_index differs. That is precisely the
// fork the fence exists to stop, surviving on the two sides most readers query.
//
// The hub-side comment reasons that "the anchor publisher's MAX(checkpoint_seq)
// selection can never see two rows at one seq and double-spend a DOGE anchor for
// one logical checkpoint". That is true of the hub's own DB and false of any
// consumer reading a mirror. A one-sided fence is not a fence; it moves where the
// fork is visible. This test is what keeps the three definitions from drifting
// apart again, since nothing else compares them.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT = path.join(__dirname, '../../..');

// Every file that declares the state_checkpoints table, and what it is.
const HOLDERS = [
    { label: 'hub (authority)',      file: 'xchain-hub/src/sql/state_checkpoints.sql' },
    { label: 'indexer mirror',       file: 'xchain-indexer/src/sql/state_checkpoints.sql' },
    { label: 'explorer hub-mirror',  file: 'xchain-explorer/src/sql/hub-mirror/state_checkpoints.sql' },
];

// The fence, as columns, in order. checkpoint_seq is derived deterministically
// from snapshot_block, so seq alone identifies the logical checkpoint; block_index
// must NOT be part of the key or two divergent payloads both get admitted.
const FENCE_COLUMNS = ['chain', 'network', 'checkpoint_seq'];

function readHolder(rel) {
    const p = path.join(REPO_ROOT, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// Pull the unique-key column list out of either spelling the schemas use:
//   UNIQUE KEY   uq_name (a, b, c)          (inline, indexer/explorer)
//   CREATE UNIQUE INDEX uq_name ON t (a, b) (statement, hub)
//
// Comments are stripped FIRST, and that is not fussiness. The hub schema explains
// the fence in prose ("the unique key is (chain, network, checkpoint_seq)"), which
// a naive match reads as a key named "is" whose columns happen to be correct. That
// is a false green: the test would pass while parsing documentation instead of DDL,
// and would keep passing if the real key were changed.
function uniqueKeyColumns(sqlWithComments) {
    const sql = sqlWithComments.replace(/^\s*--.*$/gm, '');
    const inline = sql.match(/UNIQUE\s+KEY\s+(\w+)\s*\(([^)]*)\)/i);
    if (inline) return { name: inline[1], cols: inline[2].split(',').map(c => c.trim()) };
    const stmt = sql.match(/CREATE\s+UNIQUE\s+INDEX\s+(\w+)\s+ON\s+\w+\s*\(([^)]*)\)/i);
    if (stmt) return { name: stmt[1], cols: stmt[2].split(',').map(c => c.trim()) };
    return null;
}

describe('state_checkpoints split-brain fence parity (#3096) @regression @tier1', function () {

    for (const holder of HOLDERS) {
        it(`${holder.label}: unique key is exactly (${FENCE_COLUMNS.join(', ')})`, function () {
            const sql = readHolder(holder.file);
            if (sql === null) return this.skip();   // sibling repo absent
            const key = uniqueKeyColumns(sql);
            assert.ok(key, holder.file + ' declares no unique key at all');
            assert.deepStrictEqual(key.cols, FENCE_COLUMNS,
                holder.label + ' (' + holder.file + ') carries ' + key.name + '(' + key.cols.join(', ') +
                '). A wider key admits both rows of a same-seq split-brain, which is the ' +
                'the split-brain fence exists to stop.');
        });

        it(`${holder.label}: block_index is NOT part of the fence`, function () {
            const sql = readHolder(holder.file);
            if (sql === null) return this.skip();
            const key = uniqueKeyColumns(sql);
            assert.ok(key);
            assert.ok(!key.cols.includes('block_index'),
                'including block_index is exactly the old uq_chain_block_seq defect: two ' +
                'BTC-tip-skewed leaders minting different payloads at one seq both survive');
        });
    }

    it('all present holders agree with one another, not merely with the constant', function () {
        // The per-holder assertions above could all be updated in lockstep to a new
        // wrong value; this one states the actual invariant, which is agreement.
        const seen = HOLDERS
            .map(h => ({ h, sql: readHolder(h.file) }))
            .filter(x => x.sql !== null)
            .map(x => ({ label: x.h.label, key: uniqueKeyColumns(x.sql) }));
        assert.ok(seen.length >= 1, 'expected at least this repo\'s own copy');
        const first = seen[0];
        for (const s of seen.slice(1)) {
            assert.deepStrictEqual(s.key.cols, first.key.cols,
                s.label + ' disagrees with ' + first.label + ': a fence applied to one holder ' +
                'and not another only moves where the fork becomes visible');
            assert.strictEqual(s.key.name, first.key.name,
                'the key NAME should match too, so operators reading SHOW INDEX on any host ' +
                'see the same thing');
        }
    });

    it('the tightening migration exists and is manual, not auto-applied at boot', function () {
        const dir = path.join(__dirname, '../../src/sql/migrations');
        const hit = fs.readdirSync(dir).find(f => /state-checkpoints-uq-chain-seq/.test(f));
        assert.ok(hit, 'the migration that tightens an existing DB must ship with the schema change');
        const sql = fs.readFileSync(path.join(dir, hit), 'utf8');
        // It tightens a unique key, so it can fail on pre-existing duplicates and can
        // reject writes from not-yet-upgraded code. Auto-applying it at boot under a
        // running old-code hub is the live failure this migration's manual mode exists to avoid.
        assert.match(sql, /xchain:migration mode=manual/,
            'must be manual: it applies inside the maintenance window at §8 step 4a, ' +
            'after the halt and before the hub code deploy');
        assert.match(sql, /DROP INDEX uq_chain_block_seq/,
            'must drop the old wider key, not just add the new one alongside it');
        assert.match(sql, /CREATE UNIQUE INDEX uq_chain_seq/);
        // Idempotent in both directions, matching the batch's migration discipline.
        assert.match(sql, /information_schema\.STATISTICS/,
            'both statements must be guarded so a re-run is a no-op');
    });
});
