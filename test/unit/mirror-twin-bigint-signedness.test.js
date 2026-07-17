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
];

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
