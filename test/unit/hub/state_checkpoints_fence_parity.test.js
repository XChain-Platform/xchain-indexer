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
// Decides whether a holder path may be trusted before its DDL is read.
const { siblingCheckout } = require('../../helpers/sibling_checkout.js');

// Where the SIBLING checkouts live. This repo's own copy is deliberately not
// resolved through here: <root>/xchain-indexer/... only resolves when the checkout
// directory happens to be named xchain-indexer, so in a worktree or a renamed clone
// the mirror this suite exists to check skipped ITSELF while the suite printed green.
const SIBLING_ROOT = path.join(__dirname, '../../../..');
const OWN_COPY     = path.join(__dirname, '../../../src/sql/state_checkpoints.sql');

// A bare clone may legitimately lack the siblings; a run that declared them supplied
// (XCHAIN_REQUIRE_SIBLINGS=1, which bin/ci-all.sh and the CI sibling jobs set) must
// fail instead, because there a missing holder means a broken checkout, not a skip.
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Every file that declares the state_checkpoints table, and what it is. `own` is this
// repo's copy, never optional. `authority` is the hub's, the copy the other two mirror:
// a comparison the authority dropped out of only proves two mirrors drifted together.
const HOLDERS = [
    { label: 'hub (authority)',      file: 'xchain-hub/src/sql/state_checkpoints.sql', authority: true },
    { label: 'indexer mirror',       file: 'xchain-indexer/src/sql/state_checkpoints.sql', own: true },
    { label: 'explorer hub-mirror',  file: 'xchain-explorer/src/sql/hub-mirror/state_checkpoints.sql' },
];

// The fence, as columns, in order. checkpoint_seq is derived deterministically
// from snapshot_block, so seq alone identifies the logical checkpoint; block_index
// must NOT be part of the key or two divergent payloads both get admitted.
const FENCE_COLUMNS = ['chain', 'network', 'checkpoint_seq'];

function holderPath(holder) {
    return holder.own ? OWN_COPY : path.join(SIBLING_ROOT, holder.file);
}

// The DDL, or null for a sibling that is legitimately not checked out. Never null for
// this repo's own copy, and never null under XCHAIN_REQUIRE_SIBLINGS=1.
function readHolder(holder) {
    const p = holderPath(holder);
    // Refuses an absent sibling and a lane symlink into a live main checkout alike; the
    // own copy sits inside this checkout, so only absence can refuse it.
    const verdict = siblingCheckout(__dirname, p);
    if (verdict.usable) return fs.readFileSync(p, 'utf8');
    if (holder.own)
        throw new Error('this repo\'s own state_checkpoints.sql did not resolve at ' + p
            + '; repoint OWN_COPY rather than letting the mirror drop out of its own parity check');
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the ' + holder.label + ' copy is unusable at ' + p
            + ': ' + verdict.reason + '. Check the sibling out, or unset the variable to accept the gap.');
    return null;
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
            const sql = readHolder(holder);
            if (sql === null) return this.skip();   // sibling repo absent
            const key = uniqueKeyColumns(sql);
            assert.ok(key, holder.file + ' declares no unique key at all');
            assert.deepStrictEqual(key.cols, FENCE_COLUMNS,
                holder.label + ' (' + holder.file + ') carries ' + key.name + '(' + key.cols.join(', ') +
                '). A wider key admits both rows of a same-seq split-brain, which is the ' +
                'the split-brain fence exists to stop.');
        });

        it(`${holder.label}: block_index is NOT part of the fence`, function () {
            const sql = readHolder(holder);
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
        //
        // The list must keep naming both roles. Dropping the authority row turns this into
        // two mirrors agreeing with each other, and dropping the own row leaves the copy
        // this repo actually ships out of its own parity check: both read green.
        assert.strictEqual(HOLDERS.filter(h => h.authority).length, 1,
            'exactly one holder is the authority the others mirror; the list lost it');
        assert.strictEqual(HOLDERS.filter(h => h.own).length, 1,
            'exactly one holder is this repo\'s own copy; the list lost it');
        const seen = HOLDERS
            .map(h => ({ h, sql: readHolder(h) }))
            .filter(x => x.sql !== null)
            .map(x => ({ label: x.h.label, own: !!x.h.own, authority: !!x.h.authority,
                key: uniqueKeyColumns(x.sql) }));
        assert.ok(seen.some(s => s.own), 'this repo\'s own copy is never optional here');
        // Compare everything TO the authority. Without it there is nothing to be in parity
        // with, so this states the gap instead of passing on two mirrors that agree.
        const first = seen.find(s => s.authority);
        if (!first) return this.skip();
        for (const s of seen.filter(s => s !== first)) {
            assert.deepStrictEqual(s.key.cols, first.key.cols,
                s.label + ' disagrees with ' + first.label + ': a fence applied to one holder ' +
                'and not another only moves where the fork becomes visible');
            assert.strictEqual(s.key.name, first.key.name,
                'the key NAME should match too, so operators reading SHOW INDEX on any host ' +
                'see the same thing');
        }
    });
});

describe('state_checkpoints split-brain fence parity (#3096) @regression @tier1', function () {
    it('the tightening migration exists and is manual, not auto-applied at boot', function () {
        const dir = path.join(__dirname, '../../../src/sql/migrations');
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
