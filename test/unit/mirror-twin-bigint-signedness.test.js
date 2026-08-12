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
 * Mirror-twin BIGINT signedness conformance .
 *
 * The hub-mirrored tables are declared twice: once in xchain-hub/src/sql
 * (the source of truth, written by the hub) and once here in src/sql (the
 * local mirror the indexer applies hub rows into). The mirror copies rows
 * verbatim, so a column declared signed BIGINT here while the hub declares
 * BIGINT UNSIGNED silently halves the local domain: a hub value in the
 * upper unsigned half would overflow the twin. 11 such columns drifted
 * across 4 twins before this guard existed.
 *
 * For every column name shared by a twin pair, if either side declares a
 * BIGINT, both sides must agree on UNSIGNED-ness. Column presence itself is
 * NOT asserted: some hub-side columns (e.g. batch_seq) are deliberately not
 * mirrored, and capability_snapshots' local id is a local surrogate.
 *
 * Like coins-conformance: when the sibling xchain-hub checkout is absent
 * (standalone deploy) the suite skips instead of failing; CI exports
 * XCHAIN_REQUIRE_SIBLINGS=1 so the platform run can never go green-by-skip.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const LOCAL_SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const HUB_DIR       = process.env.XCHAIN_HUB_DIR || path.join(__dirname, '..', '..', '..', 'xchain-hub');
const HUB_SQL_DIR   = path.join(HUB_DIR, 'src', 'sql');

// The hub-mirrored twins (hub_db_sync.js: oracle + CROSS_CHAIN_TABLES +
// HUB_STATE_TABLES + price_snapshots). validator_rewards shares a NAME with a
// hub table but is a different, locally-written schema, not a mirror twin.
const MIRROR_TWINS = [
    'oracle_prices',
    'price_snapshots',
    'cross_chain_matches',
    'cross_chain_calls',
    'capability_snapshots',
    'state_checkpoints',
    'anchor_reward_attestations',
];

// Mirror tables that are NOT declared in a hub_db_sync.js registry array. Empty
// today; an entry here is an explicit operator waiver, not a place to park drift.
const REGISTRY_EXEMPT = [];

// Tables the registries name outside the two scraped arrays: the oracle pair is
// wired by name in the oracle bootstrap/apply paths rather than via a const list.
const REGISTRY_IMPLICIT = ['oracle_prices', 'price_snapshots'];

// Scrape a `const <NAME> = [ 'a', 'b' ];` array literal out of hub_db_sync.js.
// Read from SOURCE rather than require()d because the module exports only the
// class + ensureTables, and the file is a byte-identical vendored twin shared
// with xchain-explorer: adding exports for a test's convenience would force a
// same-commit edit to that copy. Returns null when the declaration is absent, so
// the caller can fail loudly instead of silently inventorying nothing.
function scrapeTableArray(source, name) {
    const m = new RegExp('const\\s+' + name + '\\s*=\\s*\\[([^\\]]*)\\]').exec(source);
    if (!m) return null;
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

// table -> { column(lower) -> { unsigned: bool, definition } } for BIGINT columns only.
// Deliberately NOT parseExpectedColumns: that parser requires the local `) ENGINE ...`
// tail, and the hub DDLs close with a bare `);`. Signedness needs only the BIGINT
// column lines, so match those directly on the comment-stripped source.
function parseBigintColumns(dir, table) {
    const file = path.join(dir, table + '.sql');
    const raw  = Database.prototype.stripSqlLineComments.call({}, fs.readFileSync(file, 'utf8'));
    const out  = {};
    for (const m of raw.matchAll(/^\s*`?(\w+)`?\s+(BIGINT\b[^,\n]*)/gim)) {
        const name = m[1].toLowerCase();
        if (['key', 'unique', 'primary', 'constraint', 'index'].includes(name)) continue;
        const def = m[2].replace(/\s+/g, ' ').toUpperCase().trim();
        out[name] = { unsigned: /^BIGINT\s+UNSIGNED\b/.test(def), definition: def };
    }
    assert.ok(Object.keys(out).length, 'parsed no BIGINT columns out of ' + file);
    return out;
}

describe('mirror-twin BIGINT signedness conformance @regression', function () {

    const hubPresent = fs.existsSync(HUB_SQL_DIR);

    before(function () {
        if (!hubPresent) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling xchain-hub sql dir not found at ' + HUB_SQL_DIR);
            this.skip();
        }
    });

    //  landed anchor_reward_attestations into HUB_STATE_TABLES without adding it
    // here, so its field shape went unguarded on a money rail for a full release cycle.
    // The inventory above is hand-written; this joins it back to the registries that
    // decide what the mirror actually carries, so the NEXT table added to either array
    // reddens the suite instead of drifting silently.
    it('every hub_db_sync registry table is inventoried in MIRROR_TWINS', function () {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'hub_db_sync.js'), 'utf8');
        const missingDecls = [];
        const declared = [];
        for (const name of ['CROSS_CHAIN_TABLES', 'HUB_STATE_TABLES']) {
            const tables = scrapeTableArray(source, name);
            if (!tables || tables.length === 0) { missingDecls.push(name); continue; }
            declared.push(...tables);
        }
        assert.deepStrictEqual(missingDecls, [],
            'could not scrape these registries out of src/hub_db_sync.js; the declaration was ' +
            'renamed or reformatted and this guard is now inventorying nothing: ' + missingDecls.join(', '));
        declared.push(...REGISTRY_IMPLICIT);

        const uninventoried = declared.filter(t => !MIRROR_TWINS.includes(t) && !REGISTRY_EXEMPT.includes(t));
        assert.deepStrictEqual(uninventoried, [],
            'these tables are mirrored from the hub but absent from MIRROR_TWINS, so their BIGINT ' +
            'signedness is unguarded: ' + uninventoried.join(', ') + '. Add each to MIRROR_TWINS (and ' +
            'bump HUB_SCHEMA_VERSION in all three hub-schema-version.js copies, since a stale consumer ' +
            'cannot interpret a table it does not have).');
    });

    it('sanity: every declared twin exists on both sides (list is not vacuous)', function () {
        for (const table of MIRROR_TWINS) {
            assert.ok(fs.existsSync(path.join(LOCAL_SQL_DIR, table + '.sql')), 'missing local twin DDL: ' + table);
            assert.ok(fs.existsSync(path.join(HUB_SQL_DIR, table + '.sql')), 'missing hub twin DDL: ' + table);
        }
    });

    for (const table of MIRROR_TWINS) {
        it(table + ': every shared BIGINT column matches the hub UNSIGNED declaration', function () {
            const local = parseBigintColumns(LOCAL_SQL_DIR, table);
            const hub   = parseBigintColumns(HUB_SQL_DIR, table);

            const drifted = [];
            let sharedBigints = 0;
            for (const name of Object.keys(local)) {
                if (!hub[name]) continue;                        // hub-side-only / local-only columns are out of scope
                sharedBigints++;
                if (local[name].unsigned !== hub[name].unsigned) {
                    drifted.push('  ' + table + '.' + name +
                        '\n    local: ' + local[name].definition +
                        '\n    hub:   ' + hub[name].definition);
                }
            }
            assert.ok(sharedBigints > 0, table + ': found no shared BIGINT columns; the parser or twin pairing has gone stale');
            assert.strictEqual(drifted.length, 0,
                'BIGINT signedness drifted from the hub source DDL (align src/sql AND add a tracked ' +
                'src/sql/migrations ALTER for deployed mirrors, per ):\n' + drifted.join('\n'));
        });
    }
});
