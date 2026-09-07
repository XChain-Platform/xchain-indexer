'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
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
 * Backfill: issues.transfer_supply_id, recomputed from the ISSUE's ledger rows.
 *
 * TRANSFER_SUPPLY is an address that sat in config NUMBER_FIELDS, so
 * normalizeDataValues() nulled it for storage and createIssue() wrote
 * transfer_supply_id = NULL on every ISSUE that transferred its initial supply,
 * on every chain. The ledger was unaffected (issue.js credits/debits from the
 * un-normalized copy), but rollback.js's reorg recompute reads that column to
 * decide whose balance to rebuild, so a rollback never rebuilt the recipient.
 *
 * The forward fix (TRANSFER_SUPPLY out of NUMBER_FIELDS, guarded by
 * number-fields-exclude-address-fields.test.js) does not heal rows already
 * written; 2026-09-02-issues-backfill-transfer-supply-id.sql does.
 *
 * These run the SHIPPED migration file against a real SQL engine loaded with the
 * project's own src/sql DDL. A backfill is a WHERE clause and nothing else, so a
 * mocked test of it certifies nothing: it would pass just as green if the
 * predicate matched no row at all, or matched the issuer instead of the
 * recipient.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { makeMigrationDb, migrationStatements, MIG_DIR } = require('../helpers/sqlMigrationDb');

const MIGRATION = '2026-09-02-issues-backfill-transfer-supply-id.sql';

// Ticker / address ids, interned the way db.js createTicker / createAddress do.
const TICK  = 9;    // the token being issued
const GAS   = 1;    // the platform fee tick (config GAS)
const SRC   = 20;   // the issuer
const DST   = 25;   // TRANSFER_SUPPLY recipient
const OTHER = 31;   // a second non-issuer address
const DONATE = 44;  // the fee destination for METHOD > 1

function freshDb(){
    return makeMigrationDb(['issues.sql', 'credits.sql', 'debits.sql', 'fees.sql']);
}

function run(db){
    for(const stmt of migrationStatements(MIGRATION)) db.db.exec(stmt);
}

function issue(db, row){
    db.insert('issues', Object.assign({ tick_id: TICK, mint_supply: '1000' }, row));
}

function supplyIdOf(db, action_index){
    const r = db.rows('SELECT transfer_supply_id FROM issues WHERE action_index = ?', [action_index]);
    return r.length ? r[0].transfer_supply_id : undefined;
}

describe('backfill issues.transfer_supply_id @regression @tier1', function () {

    let db;
    beforeEach(function(){ db = freshDb(); });
    afterEach(function(){ db.close(); });

    it('heals an ISSUE that transferred its initial supply', function () {
        // issue.js: credits (TICK, MINT_SUPPLY, SOURCE) + (TICK, MINT_SUPPLY, TRANSFER_SUPPLY),
        // debits (TICK, MINT_SUPPLY, SOURCE). The recipient is the undebited credit.
        issue(db, { action_index: 349, transfer_supply_id: null });
        db.insert('credits', { action_index: 349, address_id: SRC, tick_id: TICK, amount: '1000' });
        db.insert('credits', { action_index: 349, address_id: DST, tick_id: TICK, amount: '1000' });
        db.insert('debits',  { action_index: 349, address_id: SRC, tick_id: TICK, amount: '1000' });
        // The fee was paid from an XCHAIN balance with no donation destination (METHOD 1).
        db.insert('fees',    { action_index: 349, tick_id: GAS, amount: '1', method: 2, destination_id: null,
                               payment_mode: 2, fee_preference: 2, fee_version: 1 });

        run(db);

        assert.strictEqual(supplyIdOf(db, 349), DST);
    });

    it('heals when the fee was donated in a DIFFERENT tick', function () {
        // The donation credit rides in the GAS tick, so it is outside the ISSUE tick's
        // candidate set entirely and cannot compete with the recipient.
        issue(db, { action_index: 350, transfer_supply_id: null });
        db.insert('credits', { action_index: 350, address_id: SRC,    tick_id: TICK, amount: '1000' });
        db.insert('credits', { action_index: 350, address_id: DST,    tick_id: TICK, amount: '1000' });
        db.insert('credits', { action_index: 350, address_id: DONATE, tick_id: GAS,  amount: '1' });
        db.insert('debits',  { action_index: 350, address_id: SRC,    tick_id: TICK, amount: '1000' });
        db.insert('debits',  { action_index: 350, address_id: SRC,    tick_id: GAS,  amount: '1' });
        db.insert('fees',    { action_index: 350, tick_id: GAS, amount: '1', method: 3, destination_id: DONATE,
                               payment_mode: 2, fee_preference: 3, fee_version: 1 });

        run(db);

        assert.strictEqual(supplyIdOf(db, 350), DST);
    });

    it('leaves a self-mint alone instead of naming the issuer its own recipient', function () {
        // MINT_SUPPLY with no TRANSFER_SUPPLY: one credit to SOURCE and NO debit in the
        // ISSUE's tick. Without the "a debit must exist" guard the lone undebited credit
        // is SOURCE, and the row would be healed to the issuer - a wrong address written
        // into the reorg recompute set, worse than the NULL it replaced.
        issue(db, { action_index: 351, transfer_supply_id: null });
        db.insert('credits', { action_index: 351, address_id: SRC, tick_id: TICK, amount: '1000' });
        db.insert('fees',    { action_index: 351, tick_id: GAS, amount: '1', method: 2, destination_id: null,
                               payment_mode: 2, fee_preference: 2, fee_version: 1 });

        run(db);

        assert.strictEqual(supplyIdOf(db, 351), null);
    });

    it('never mistakes the fee destination for the recipient when the ISSUE tick IS the fee tick', function () {
        // Re-ISSUE of the gas token with METHOD > 1: the donation credit lands in the
        // ISSUE's own tick and is undebited, so it is the one row that can impersonate a
        // TRANSFER_SUPPLY recipient. The fees.destination_id exclusion is what stops it.
        issue(db, { action_index: 352, tick_id: GAS, transfer_supply_id: null });
        db.insert('credits', { action_index: 352, address_id: SRC,    tick_id: GAS, amount: '1000' });
        db.insert('credits', { action_index: 352, address_id: DONATE, tick_id: GAS, amount: '1' });
        db.insert('debits',  { action_index: 352, address_id: SRC,    tick_id: GAS, amount: '1' });
        db.insert('fees',    { action_index: 352, tick_id: GAS, amount: '1', method: 3, destination_id: DONATE,
                               payment_mode: 2, fee_preference: 3, fee_version: 1 });

        run(db);

        assert.strictEqual(supplyIdOf(db, 352), null);
    });

    it('leaves an ambiguous action NULL rather than guessing', function () {
        // Two undebited credits in the ISSUE tick: nothing here identifies which one the
        // wire field named, so the row is left for a re-index to repair.
        issue(db, { action_index: 353, transfer_supply_id: null });
        db.insert('credits', { action_index: 353, address_id: SRC,   tick_id: TICK, amount: '1000' });
        db.insert('credits', { action_index: 353, address_id: DST,   tick_id: TICK, amount: '500' });
        db.insert('credits', { action_index: 353, address_id: OTHER, tick_id: TICK, amount: '500' });
        db.insert('debits',  { action_index: 353, address_id: SRC,   tick_id: TICK, amount: '1000' });

        run(db);

        assert.strictEqual(supplyIdOf(db, 353), null);
    });

    it('leaves an INVALID ISSUE NULL - it wrote no ledger rows and moved no balance', function () {
        issue(db, { action_index: 354, transfer_supply_id: null });

        run(db);

        assert.strictEqual(supplyIdOf(db, 354), null);
    });

    it('never overwrites a transfer_supply_id the fixed indexer already wrote', function () {
        issue(db, { action_index: 355, transfer_supply_id: DST });
        db.insert('credits', { action_index: 355, address_id: SRC,   tick_id: TICK, amount: '1000' });
        db.insert('credits', { action_index: 355, address_id: OTHER, tick_id: TICK, amount: '1000' });
        db.insert('debits',  { action_index: 355, address_id: SRC,   tick_id: TICK, amount: '1000' });

        run(db);

        assert.strictEqual(supplyIdOf(db, 355), DST);
    });

    it('does not touch a row on another action, and is idempotent', function () {
        issue(db, { action_index: 360, transfer_supply_id: null });
        db.insert('credits', { action_index: 360, address_id: SRC, tick_id: TICK, amount: '1000' });
        db.insert('credits', { action_index: 360, address_id: DST, tick_id: TICK, amount: '1000' });
        db.insert('debits',  { action_index: 360, address_id: SRC, tick_id: TICK, amount: '1000' });
        // A neighbouring action's ledger rows must not leak into action 360's candidate set.
        issue(db, { action_index: 361, transfer_supply_id: null });
        db.insert('credits', { action_index: 361, address_id: SRC,   tick_id: TICK, amount: '7' });
        db.insert('credits', { action_index: 361, address_id: OTHER, tick_id: TICK, amount: '7' });
        db.insert('debits',  { action_index: 361, address_id: SRC,   tick_id: TICK, amount: '7' });

        run(db);
        const first = [supplyIdOf(db, 360), supplyIdOf(db, 361)];
        assert.deepStrictEqual(first, [DST, OTHER]);

        run(db);
        assert.deepStrictEqual([supplyIdOf(db, 360), supplyIdOf(db, 361)], first);
    });

    it('is a clean no-op on an empty issues table (fresh install)', function () {
        run(db);
        assert.deepStrictEqual(db.rows('SELECT COUNT(*) n FROM issues'), [{ n: 0 }]);
    });

});

describe('backfill migration file contract @regression @tier1', function () {

    const raw = fs.readFileSync(path.join(MIG_DIR, MIGRATION), 'utf8');

    it('is tagged mode=manual so it can never auto-apply at fleet startup', function () {
        const Database = require('../../src/db');
        assert.strictEqual(Database.prototype._migrationMode.call({}, raw), 'manual');
    });

    it('is not a deploy precondition - no code asserts it at boot', function () {
        // A backfill repairs history; the indexer boots and serves fine without it, so
        // tagging it deploy-precondition=required would crash-loop an un-migrated node
        // for nothing.
        assert.ok(!/deploy-precondition\s*=\s*required/i.test(raw));
    });

    it('is a single UPDATE that only ever fills a NULL', function () {
        const statements = migrationStatements(MIGRATION);
        assert.strictEqual(statements.length, 1);
        assert.ok(/^UPDATE\s+issues/i.test(statements[0].trim()));
        assert.ok(/i\.transfer_supply_id\s+IS\s+NULL/i.test(statements[0]));
    });

});
