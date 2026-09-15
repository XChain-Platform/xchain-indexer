/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/rollback_coverage.test.js
 *
 * Rollback coverage guard.
 *
 * Every table the indexer owns is defined by a file in src/sql/ (that is the
 * exact set verifyTables() creates (table name = filename minus ".sql"). On a
 * chain reorg, Rollback.rollback() must do *something* deliberate with each of
 * those tables, or rows written in the orphaned block range survive and the
 * indexer DB silently diverges from chain truth (and from other validators).
 *
 * Historically tables shipped before they were wired into the rollback set.
 * e.g. gated_files (table 2026-05-22, rollback 2026-05-28, a 6-day window) and
 * slash_events (2-day window). Invisible on regtest; silent corruption on
 * mainnet. This test closes the *class*: a new src/sql/<table>.sql that nobody
 * classifies fails here instead of shipping.
 *
 * To satisfy this test, a new table needs ONE entry in the table-lifecycle
 * registry (src/hub/table_lifecycle.js) declaring its replication, rollback, and
 * hash-coverage classification; the rollback buckets checked here (generic
 * lists, RECOMPUTED, SPECIAL_CASE, ROLLBACK_EXEMPT, inert lookups) are all
 * derived from that registry. Classify by understanding the table, not by
 * silencing the test; see the registry header for the field definitions.
 */

'use strict';
process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');
const { createMockIndexer } = require('../../fixtures/mocks');
const Rollback              = require('../../../src/rollback.js');
const lifecycle             = require('../../../src/hub/table_lifecycle.js');
const { siblingCheckout }   = require('../../helpers/sibling_checkout.js');
const SQL_DIR = path.join(__dirname, '../../../src/sql');
const UNIVERSE = fs.readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => f.slice(0, -'.sql'.length))
    .sort();
const { RECOMPUTED, SPECIAL_CASE, ROLLBACK_EXEMPT } = lifecycle.rollbackBuckets();
const ORPHAN_SWEEPS = lifecycle.ORPHAN_SWEEPS;
const LOOKUP_TABLES = new Set(lifecycle.tablesWhere(t => t.rollback === 'lookup'));
const isLookupTable = (t) => LOOKUP_TABLES.has(t);
const SYNC_ROOT = process.env.XCHAIN_SYNC_PATH
    ? path.resolve(process.env.XCHAIN_SYNC_PATH)
    : path.resolve(__dirname, '..', '..', '..', '..', 'xchain-sync');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
let rollback;
function rollbackHooks() {
    before(function () {
        const indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
    });
}

describe('Rollback coverage guard @regression', function () {
    rollbackHooks();
    describe('indexer<->sync twin byte-identity (reciprocal guard)', function(){

        // rollback.js and ClientRollback.js are not whole-file twins, but the contract
        // slash reorg-restore inside them is: a predicate that picks a different debit on
        // one side restores a different active stake there, and active stake drives staker
        // weighting and quorum eligibility, so the two nodes fork. Both files carry the
        // statement between //<CONTRACT-SLASH-RESTORE-SQL> markers; concatenating its string
        // literals (template literals here, double-quoted concatenation on the replica, the
        // interpolated table name dropping out of both) and normalising whitespace yields
        // the same SQL on both sides.
        it('the contract slash-restore SQL is identical across xchain-indexer and xchain-sync (cross-repo twin)', function(){
            const syncPath = path.join(SYNC_ROOT, 'src', 'client', 'rollback.js');
            // Refuses an absent sibling and a lane symlink into a live main checkout alike.
            const syncCheckout = siblingCheckout(__dirname, syncPath);
            if(!syncCheckout.usable){
                if(REQUIRE_SIBLINGS)
                    throw new Error('consensus drift guard cannot run: ' + syncCheckout.reason +
                        ' (check out xchain-sync or set XCHAIN_SYNC_PATH)');
                this.skip();
                return;
            }
            function slashRestoreSql(p){
                const src = fs.readFileSync(p, 'utf8');
                const m = src.match(/\/\/<CONTRACT-SLASH-RESTORE-SQL>([\s\S]*?)\/\/<\/CONTRACT-SLASH-RESTORE-SQL>/);
                assert.ok(m, 'CONTRACT-SLASH-RESTORE-SQL markers not found in ' + p);
                const lits = m[1].match(/`[^`]*`|"(?:[^"\\]|\\.)*"/g) || [];
                assert.ok(lits.length >= 2, 'expected >=2 SQL literals in the marked block of ' + p + ', got ' + lits.length);
                return lits.map(l => l.slice(1, -1)).join('').replace(/\s+/g, ' ').trim();
            }
            assert.strictEqual(
                slashRestoreSql(path.join(__dirname, '../../../src/rollback.js')),
                slashRestoreSql(syncPath),
                'the contract slash-restore SQL drifted between xchain-indexer and xchain-sync; keep it identical');
        });
    });
});
