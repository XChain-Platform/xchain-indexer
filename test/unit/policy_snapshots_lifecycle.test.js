// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/*
 * policy_snapshots is rollback-exempt on BOTH sides, and this pins it.
 *
 * A policy_snapshots row is an append-only, quorum-signed per-token policy snapshot
 * mirrored from the hub. It is latest-wins per (network, origin_chain, tick) and is
 * never retracted: a superseding policy arrives as a NEW row at a higher policy_seq,
 * never as a deletion of the old one. It therefore carries no hub_db_sync
 * RETRACTION_COLUMNS entry either.
 *
 * What that buys is the classification asserted here: a chain reorg must never delete
 * one. Block replay does not recreate the row (nothing on this chain produced it), so a
 * generic-list delete on reorg would strip a signed snapshot the mirror cannot get back
 * until the hub happens to re-serve it, and every consumer reading policy between the
 * reorg and that re-serve would read a policy that the federation never retired. The
 * injected LIST/ISSUE/SLEEP actions the apply mints ARE rolled back normally, and the
 * bridge_settlements row keyed kind='policy' goes with them, so replay re-applies the
 * snapshot from the surviving mirrored row.
 *
 * The registry ships as two byte-identical twins (xchain-indexer/src/tableLifecycle.js
 * and xchain-sync/src/tableLifecycle.js), and rollback-coverage.test.js already locks
 * those two files byte-identical. This guard is deliberately NOT that check: it reads
 * each copy's OWN registry and pins the two fields, so a twin edit that moves both files
 * in lockstep (the shape byte-identity cannot see) still fails here. Source and replica
 * disagreeing about this table is a fork; both agreeing on the wrong value is a silent
 * loss of signed policy on every reorg.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const TABLE = 'policy_snapshots';

// The two registry copies. The sync twin is loaded from its own checkout rather than
// assumed equal to this repo's: see the header. Absent sibling skips, except under
// XCHAIN_REQUIRE_SIBLINGS=1 (the CI job that checks siblings out), where green-by-skip
// is not allowed to hide a fork-class divergence.
const SYNC_ROOT = process.env.XCHAIN_SYNC_PATH
    ? path.resolve(process.env.XCHAIN_SYNC_PATH)
    : path.resolve(__dirname, '..', '..', '..', 'xchain-sync');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
const SYNC_REGISTRY = path.join(SYNC_ROOT, 'src', 'tableLifecycle.js');

const COPIES = [
    { side: 'xchain-indexer', file: path.resolve(__dirname, '../../src/tableLifecycle.js') },
    { side: 'xchain-sync',    file: SYNC_REGISTRY },
];

describe('policy_snapshots rollback classification @regression @tier1', function () {

    for (const copy of COPIES) {

        // Each copy is require()d fresh off its own path so a divergent twin is visible
        // here even though both files parse and export the same shape.
        function load(ctx) {
            if (!fs.existsSync(copy.file)) {
                if (REQUIRE_SIBLINGS)
                    throw new Error('policy_snapshots rollback guard cannot run: registry missing at ' +
                        copy.file + ' (check out xchain-sync or set XCHAIN_SYNC_PATH)');
                ctx.skip();
                return null;
            }
            return require(copy.file);
        }

        it(copy.side + ': ' + TABLE + ' is declared rollback exempt and replicaRollback exempt', function () {
            const lifecycle = load(this);
            if (!lifecycle) return;
            const row = lifecycle.entry(TABLE);
            assert.ok(row, TABLE + ' is absent from the ' + copy.side + ' registry; a hub-mirrored table ' +
                'with no entry is unclassified, which is how tables shipped ahead of their rollback wiring');
            assert.strictEqual(row.rollback, 'exempt',
                copy.side + ': a chain reorg must never delete an append-only signed policy snapshot; ' +
                'block replay does not recreate it, so any other rollback class loses federation-signed ' +
                'policy the local chain cannot reproduce');
            assert.strictEqual(row.replicaRollback, 'exempt',
                copy.side + ': the replica must reach the same verdict as the source; a replica that ' +
                'deletes a snapshot its source keeps serves a different policy set, which is a fork');
        });

        it(copy.side + ': ' + TABLE + ' is in no generic rollback delete list', function () {
            const lifecycle = load(this);
            if (!lifecycle) return;
            // The classification above is only worth what the derived lists honour: the generic
            // reorg loops delete exactly what these buckets name, so the table's absence from
            // every one of them is the property, stated independently of the two field values.
            const source  = lifecycle.rollbackTables();
            const replica = lifecycle.replicaRollbackTables();
            for (const [label, lists] of [['source', source], ['replica', replica]])
                for (const kind of Object.keys(lists))
                    assert.strictEqual(lists[kind].indexOf(TABLE), -1,
                        copy.side + ': ' + TABLE + ' reached the ' + label + ' ' + kind +
                        ' generic delete list; a reorg would strip signed snapshots');
        });
    }

    it('the exemption is not vacuous: the registry does classify tables as deletable', function () {
        const lifecycle = require(path.resolve(__dirname, '../../src/tableLifecycle.js'));
        const lists = lifecycle.rollbackTables();
        assert.ok(lists.dataTables.length > 0 && lists.blockTables.length > 0,
            'the generic delete lists are empty, so "policy_snapshots is absent from them" proves nothing');
    });
});
