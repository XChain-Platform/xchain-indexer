'use strict';

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
 * Index parity, pre-ledger baseline half: a baselined index keeps its shape, and
 * a re-frozen one is backed by a dated migration measured against the pinned
 * origin anchor. Part of the index parity suite; see
 * ../sql_schema_index_parity.test.js.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { loadPinnedOriginFixture } = require('../../../helpers/pinnedOriginFixture');
const { INDEX_BASELINE, PRIMARY_INDEX, collectDeclaredIndexes, collectMigrationIndexes } = require('./helpers/index_ledger.js');

// The immutable anchor the re-freeze guard measures against, plus the sha256 that
// makes editing it a deliberate act. See the re-freeze case at the bottom of this file.
const ORIGIN_INDEX_BASELINE        = path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-index-baseline-origin.json');
const ORIGIN_INDEX_BASELINE_SHA256 = 'c5da83b9fb1d9aab4d2e370b2e975022f1bbabecc3e732fe2714e4ca48d720bf';

// Original shape of each pre-ledger table-level PRIMARY KEY. The pinned anchor above was
// seeded before the parser read primary keys, so these stand in for its missing entries;
// adding a table here is the reviewed act, exactly as re-seeding the anchor would be.
const ORIGIN_PRIMARY_KEYS = {
    pending_hub_pushes: { columns: ['id'],   unique: true },
    push_generations:   { columns: ['coin'], unique: true },
};

describe('SQL schema index parity (definition path vs ledger path) @regression', function(){
    it('sanity: the index baseline is neither empty nor stale (guard is not vacuous)', function(){
        const fixture  = JSON.parse(fs.readFileSync(INDEX_BASELINE, 'utf8'));
        const baseline = fixture.baseline || {};
        assert.ok(Object.keys(baseline).length > 0, 'the index baseline is empty; the inverse guard would pass vacuously');

        // A baseline entry for an index no definition declares any more is dead weight that
        // would quietly re-waive the guard if the name were ever reused.
        const declared = collectDeclaredIndexes();
        const stale = [];
        for(const table of Object.keys(baseline))
            for(const entry of baseline[table]){
                const index = String(entry.name).toLowerCase();
                if(!(declared[table] && declared[table].has(index))) stale.push('  ' + table + '.' + index);
            }

        assert.deepStrictEqual(stale, [],
            'These baseline entries name an index no src/sql/<table>.sql declares any more. Remove them ' +
            'from test/fixtures/schema-index-baseline.json:\n' + stale.join('\n'));
    });

    // The index twin of the column-shape guard. The inverse guard above exempts a
    // pre-ledger index by NAME, and the baseline stored nothing but names, so re-pointing a
    // baselined index at different columns, changing its (len) prefix or its column ORDER, or
    // promoting a plain KEY to UNIQUE all stayed green with no dated migration. The runtime is
    // no backstop: reconcileTableIndexes matches by COLUMN SET (so it cannot see a prefix or
    // order change) and for an inline KEY it is never consulted at all, since parseExpectedIndexes
    // reads only standalone CREATE INDEX. The shape case above covers only indexes a
    // migration ALSO declares; a baselined index has no migration by definition, so nothing
    // watched it. The baseline now freezes each one's normalized columns + UNIQUE flag.
    it('a pre-ledger baselined index has not changed shape (columns, prefix, uniqueness) @regression', function(){
        const fixture  = JSON.parse(fs.readFileSync(INDEX_BASELINE, 'utf8'));
        const baseline = fixture.baseline || {};
        const declared = collectDeclaredIndexes();

        const drifted = [];
        for(const table of Object.keys(baseline))
            for(const entry of baseline[table]){
                const index = String(entry.name).toLowerCase();
                const decl  = declared[table] && declared[table].get(index);
                if(!decl) continue;                                       // staleness is the case above
                if(decl.columns === null || entry.columns === null) continue;  // unparsed, do not guess
                if(decl.columns.join(',') !== (entry.columns || []).join(','))
                    drifted.push(`  ${table}.${index} columns: baseline (${(entry.columns || []).join(', ')}) ` +
                                 `vs definition (${decl.columns.join(', ')})`);
                else if(decl.unique !== !!entry.unique)
                    drifted.push(`  ${table}.${index} uniqueness: baseline unique=${!!entry.unique} ` +
                                 `vs definition unique=${decl.unique}`);
            }

        assert.deepStrictEqual(drifted, [],
            'These indexes predate the migration ledger, so they are exempt from needing a dated migration - ' +
            'but their SHAPE changed in src/sql/<table>.sql with no migration behind it. An aged DB keeps the ' +
            'original index (the boot reconciler matches by column SET, so it cannot see a reorder or a (len) ' +
            'prefix change, and never touches an inline KEY at all), so the two schema-construction paths stop ' +
            'agreeing. Ship a dated migration that recreates the index in its new shape, and re-freeze ' +
            'test/fixtures/schema-index-baseline.json in the SAME commit:\n' + drifted.join('\n'));
    });
});

// The twin of the column suite's re-freeze guard, for the same reason. The case
// above fires when baseline != definition and its message mandates two things - a dated
// migration recreating the index in its new shape AND a re-freeze of this fixture in the
// same commit - but only the re-freeze is machine-checked. Doing the re-freeze alone
// restores baseline == declared and the guard goes green with no migration behind it,
// while every aged DB and every replay-only replica keeps the ORIGINAL index: the boot
// reconciler matches by column SET (blind to a reorder or a (len) prefix change) and never
// touches an inline KEY at all, so nothing heals it later either.
//
// test/fixtures/schema-index-baseline-origin.json is the anchor, sha256-pinned above and
// seeded from the shape-guard landing (01f321c1) rather than from today's baseline - an anchor
// copied from today would be vacuous, since nothing would differ from it. Seeded from
// that landing it already carries the destroys.action_index UNIQUE -> non-unique re-freeze, which
// this case resolves through the real 2026-08-15-destroys-drop-unique-action-index.sql,
// so the guard is exercised on live data today rather than on some future commit.
//
// "Recreated" is read exactly as collectMigrationIndexes reads it, so a DROP INDEX with no
// recreate does not count: the aged DB must end up holding the new shape, and only the
// ADD/CREATE INDEX puts it there.
describe('SQL schema index parity (definition path vs ledger path) @regression', function(){
    it('a re-frozen pre-ledger index is backed by a dated migration that recreates it @regression', function(){
        const origin   = loadPinnedOriginFixture(ORIGIN_INDEX_BASELINE, ORIGIN_INDEX_BASELINE_SHA256,
                                                 'test/unit/migration/sql_schema_index_parity.test.js');
        const fixture  = JSON.parse(fs.readFileSync(INDEX_BASELINE, 'utf8'));
        const baseline = fixture.baseline || {};

        // Migrations replay in lexical filename order, so when several touch one index the
        // shape an aged DB ends up with is the last one's.
        const lastCreated = new Map();
        for(const a of collectMigrationIndexes().slice().sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0)))
            lastCreated.set(a.table + '.' + a.index, a);

        const shape = (columns, unique) => (columns || []).join(',') + ' unique=' + !!unique;

        const unjustified = [];
        const minted      = [];
        for(const table of Object.keys(baseline)){
            const anchored = new Map(((origin.baseline || {})[table] || [])
                .map(e => [String(e.name).toLowerCase(), e]));
            for(const entry of baseline[table]){
                const index = String(entry.name).toLowerCase();
                const o     = anchored.get(index) ||
                              (index === PRIMARY_INDEX && Object.hasOwn(ORIGIN_PRIMARY_KEYS, table)
                                  ? ORIGIN_PRIMARY_KEYS[table] : undefined);
                if(!o){ minted.push(`  ${table}.${index}  (frozen as: ${shape(entry.columns, entry.unique)})`); continue; }
                if(shape(o.columns, o.unique) === shape(entry.columns, entry.unique)) continue;
                const m = lastCreated.get(table + '.' + index);
                if(m && shape(m.columns, m.unique) === shape(entry.columns, entry.unique)) continue;
                unjustified.push(`  ${table}.${index}\n    origin:    ${shape(o.columns, o.unique)}\n    ` +
                    `re-frozen: ${shape(entry.columns, entry.unique)}\n    ` +
                    (m ? `last migration recreate (${m.file}): ${shape(m.columns, m.unique)}`
                       : 'no dated migration recreates this index') +
                    (index === PRIMARY_INDEX ? '\n    (a primary key moves by ALTER TABLE ... DROP PRIMARY KEY, ADD PRIMARY KEY (...))' : ''));
            }
        }

        assert.deepStrictEqual(unjustified, [],
            'These pre-ledger indexes were RE-FROZEN in test/fixtures/schema-index-baseline.json - their ' +
            'shape no longer matches test/fixtures/schema-index-baseline-origin.json - but no dated ' +
            'migration under src/sql/migrations/ recreates them in the re-frozen shape. The re-freeze ' +
            'silences the shape guard above for fresh installs while every long-lived DB and every ' +
            'replay-only replica keeps the ORIGINAL index forever, and the boot reconciler cannot heal it ' +
            '(it matches by column SET and never reads an inline KEY). Ship the dated migration the ' +
            'guard\'s own failure message asks for - DROP INDEX IF EXISTS followed by a CREATE INDEX in ' +
            'the new shape, matching name, column list and UNIQUE flag - or revert the definition and the ' +
            're-freeze together:\n' + unjustified.join('\n'));

        assert.deepStrictEqual(minted, [],
            'These indexes were ADDED to test/fixtures/schema-index-baseline.json but are absent from ' +
            'test/fixtures/schema-index-baseline-origin.json, so they did not ship with their table\'s ' +
            'original CREATE TABLE and the baseline is claiming a provenance they do not have. Baselining ' +
            'exempts an index from needing a migration forever, so a replay-only replica never gets it. ' +
            'Ship a dated CREATE INDEX migration instead, or list it under known_unledgered while its ' +
            'migration is owed:\n' + minted.join('\n'));
    });
});

describe('SQL schema index parity (definition path vs ledger path) @regression', function(){
    // The anchor is only worth what it differs from: re-seeding it from the current baseline
    // would leave the case above passing over an empty set forever. Pin the one re-freeze we
    // know shipped, which that case resolves through its real migration.
    it('sanity: the origin index anchor still differs from the live baseline (re-freeze guard is not vacuous)', function(){
        const origin   = loadPinnedOriginFixture(ORIGIN_INDEX_BASELINE, ORIGIN_INDEX_BASELINE_SHA256,
                                                 'test/unit/migration/sql_schema_index_parity.test.js');
        const fixture  = JSON.parse(fs.readFileSync(INDEX_BASELINE, 'utf8'));
        const baseline = fixture.baseline || {};
        const shape    = (columns, unique) => (columns || []).join(',') + ' unique=' + !!unique;

        const moved = [];
        for(const table of Object.keys(baseline)){
            const anchored = new Map(((origin.baseline || {})[table] || [])
                .map(e => [String(e.name).toLowerCase(), e]));
            for(const entry of baseline[table]){
                const index = String(entry.name).toLowerCase();
                const o     = anchored.get(index);
                if(o && shape(o.columns, o.unique) !== shape(entry.columns, entry.unique))
                    moved.push(table + '.' + index);
            }
        }

        // validator_rewards.reward_unique: re-frozen when round_qualifier joined the reward
        // ledger key (2026-08-24-validator-rewards-round-qualifier.sql). The archive leg's
        // round_reference is MATCH_BATCH_SEQ, a dense hub counter a wipe-and-replay rebase
        // reissues, so the four-column key collapsed two genuinely distinct archive anchors
        // into one paid reward; the qualifier carries the snapshot_block that already
        // distinguished them in the signed XANCPUB tuple. The case above resolves this entry
        // through that dated migration, which DROPs and recreates the index in the new shape -
        // the one thing the boot reconciler will not do for an aged database.
        assert.deepStrictEqual(moved, ['destroys.action_index', 'validator_rewards.reward_unique'],
            'The set of index baseline entries that differ from test/fixtures/schema-index-baseline-origin.json ' +
            'changed. An EMPTY set means the anchor was re-seeded from the current baseline and the re-freeze ' +
            'guard above now proves nothing. A LARGER set means a new re-freeze landed: confirm the case above ' +
            'resolves it through a real dated migration, then add it here - that edit is the reviewed act.');
    });
});
