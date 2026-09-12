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
 * The local pre-delete of orphaned bridge_transfers on a chain reorg.
 *
 * bridge_transfers is a hub-mirrored, federation-co-signed table: the indexer only
 * SELECTs it, and the authoritative unwind is the hub's retraction (hub_db_sync.js
 * _applyRetraction, under the mandatory push_generation fence). But a reorg concurrent
 * with a hub blip leaves 'finalized' transfers for the orphaned range serving locally
 * until the hub reconnects, and the bridge settle pass reads exactly those rows. That is
 * the window cross_chain_calls and cross_chain_matches already close with their own local
 * delete inside the CROSS-CHAIN-MIRROR-REORG-DELETE markers; this asserts bridge_transfers
 * closes it too, and that the predicate is the one the table's own DDL spells.
 *
 * The predicate is one-sided. A transfer is retracted when the SINGLE source leg (the
 * XBRIDGE v0 lock or v1 burn named by src_chain/src_action_index) is reorged away, unlike
 * cross_chain_matches, which drops when EITHER order leg goes. The column names are
 * src_chain/src_action_index, not the older source_chain/source_action_index that the
 * other mirrors use: a hard-coded `source_chain` here is errno 1054 and the delete would
 * silently do nothing, which is worse than not having it.
 *
 * The SQL text is asserted off the statement the shipped rollback actually issues, not off
 * the file, and the marked block is checked to carry it in BOTH twins, so an indexer-only
 * edit fails here rather than waiting for a sync CI run with a sibling checkout.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const Rollback              = require('../../src/rollback.js');

const ORPHAN_FROM = 50;   // first action_index in the orphaned range
const REORG_BLOCK = 100;

// Every statement rollback() issued, in order, with its bind values.
async function shippedStatements() {
    const indexer = createMockIndexer();
    indexer.protocolChanges = {
        isDefined: sinon.stub().returns(true),
        isEnabled: sinon.stub().resolves(true),
    };
    const rollback = new Rollback(indexer);
    // The first read is the orphan point: the lowest action_index in the rolled-back range.
    indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: ORPHAN_FROM }]);
    indexer.indexerDb.doQuery.resolves([]);
    await rollback.rollback(REORG_BLOCK);
    return indexer.indexerDb.doQuery.getCalls()
        .map(c => ({ sql: String(c.args[0]).replace(/\s+/g, ' ').trim(), args: c.args[1] }));
}

// The SQL literals between the twin-guard markers of one rollback file.
function markedSql(file) {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/\/\/<CROSS-CHAIN-MIRROR-REORG-DELETE>([\s\S]*?)\/\/<\/CROSS-CHAIN-MIRROR-REORG-DELETE>/);
    assert.ok(m, 'CROSS-CHAIN-MIRROR-REORG-DELETE markers not found in ' + file);
    return (m[1].match(/`[^`]*`/g) || []).map(l => l.replace(/`/g, '').replace(/\s+/g, ' ').trim());
}

describe('bridge_transfers reorg pre-delete @regression @tier1', function () {

    let statements;

    before(async function () {
        statements = await shippedStatements();
    });

    it('deletes the orphaned bridge_transfers range on its own source leg', function () {
        const del = statements.filter(s => /^DELETE FROM bridge_transfers\b/.test(s.sql));
        assert.strictEqual(del.length, 1,
            'a reorg must issue exactly one local bridge_transfers delete; none leaves finalized ' +
            'transfers for the orphaned range serving until the hub reconnects');
        assert.strictEqual(del[0].sql,
            'DELETE FROM bridge_transfers WHERE src_chain = ? AND src_action_index >= ?',
            'the predicate must name the DDL\'s own src_chain/src_action_index pair; source_chain ' +
            'is errno 1054 on this table and the delete would remove nothing');
        assert.deepStrictEqual(del[0].args, ['BTC', ORPHAN_FROM],
            'scoped to THIS chain and to the orphan point: bridge_transfers holds rows whose ' +
            'src_action_index is only unique within its src_chain');
    });

    it('runs inside the marker block, after the two mirrors that already close the window', function () {
        const lits = markedSql(path.resolve(__dirname, '../../src/rollback.js'));
        assert.deepStrictEqual(
            lits.map(l => (l.match(/^DELETE FROM (\w+)/) || [])[1]),
            ['cross_chain_calls', 'cross_chain_matches', 'bridge_transfers'],
            'the marked block is the cross-repo drift guard: a delete added outside it drifts ' +
            'from the replica unnoticed, and the order is compared literal-for-literal');
    });

    it('the xchain-sync replica carries the identical statement', function () {
        const syncRoot = process.env.XCHAIN_SYNC_PATH
            ? path.resolve(process.env.XCHAIN_SYNC_PATH)
            : path.resolve(__dirname, '..', '..', '..', 'xchain-sync');
        const syncFile = path.join(syncRoot, 'src', 'ClientRollback.js');
        if (!fs.existsSync(syncFile)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('cross-chain mirror drift guard cannot run: sibling missing at ' +
                    syncFile + ' (check out xchain-sync or set XCHAIN_SYNC_PATH)');
            this.skip();
            return;
        }
        // A replica that keeps rows the source deleted serves transfers the source has
        // already dropped, so the two must remove the same rows from the same point.
        assert.deepStrictEqual(
            markedSql(syncFile),
            markedSql(path.resolve(__dirname, '../../src/rollback.js')),
            'the cross-chain mirror reorg deletes drifted between xchain-indexer/src/rollback.js ' +
            'and xchain-sync/src/ClientRollback.js; keep them identical');
    });

    it('leaves policy_snapshots alone: append-only signed snapshots survive a reorg', function () {
        assert.strictEqual(statements.filter(s => /\bpolicy_snapshots\b/.test(s.sql)).length, 0,
            'a superseding policy arrives as a new row at a higher policy_seq, never as a ' +
            'deletion, and block replay cannot recreate a snapshot this chain did not produce');
    });
});
