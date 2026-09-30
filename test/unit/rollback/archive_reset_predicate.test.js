// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const batchHeads = require('../../../src/db/rollback/batch_heads.js');
const { ARCHIVE_HEAD_VERSIONS_SQL, archiveHeadPredicate } = require('../../../src/consensus/state_hash.js');

// Captures the SQL the invalid_archive reset issues and checks that its WHERE selects
// heads through both shared state_hash predicates, never a hand-written version literal.
async function captureReset(){
    const db = { doQuery: sinon.stub().resolves([]), createStatus: sinon.stub().resolves(1) };
    await batchHeads.resetOrphanedArchiveHeads(db, { NETWORK: 'regtest' }, 100, 50);
    assert.strictEqual(db.doQuery.callCount, 1, 'the reset issues exactly one UPDATE');
    assert.ok(db.createStatus.calledWith('unverified'), 'the reset interns unverified first');
    return db.doQuery.firstCall.args;
}

describe('rollback archive reset row predicate @tier3', function(){
    it('ANDs the fold row predicate into the reset WHERE', async function(){
        const [sql, args] = await captureReset();
        const where = sql.slice(sql.indexOf('WHERE'));
        assert.ok(where.includes('p.match_batch_seq IS NOT NULL AND p.version <> 2'));
        assert.ok(where.includes(archiveHeadPredicate('p')));
        assert.deepStrictEqual(args, [50, 50]);
    });

    it('keeps the shared spliced archive-head set and no hand-written version literal', async function(){
        const [sql] = await captureReset();
        const where = sql.slice(sql.indexOf('WHERE'));
        assert.ok(where.includes('p.version ' + ARCHIVE_HEAD_VERSIONS_SQL));
        assert.ok(!/p\.version (=|IN \()\s*\d/.test(where.replace('p.version ' + ARCHIVE_HEAD_VERSIONS_SQL, '')));
    });

    it('issues nothing when no action was orphaned', async function(){
        const db = { doQuery: sinon.stub().resolves([]), createStatus: sinon.stub().resolves(1) };
        await batchHeads.resetOrphanedArchiveHeads(db, { NETWORK: 'regtest' }, 100, null);
        assert.strictEqual(db.doQuery.callCount, 0);
    });
});
